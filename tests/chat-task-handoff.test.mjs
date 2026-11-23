import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { digest } from '../src/audit.mjs';
import { runChat } from '../src/chat/cli.mjs';
import { loadChatConfig, snapshotProject } from '../src/chat/config.mjs';
import { openSessionStore } from '../src/chat/session-store.mjs';
import { SqliteDatabase, SqliteStateStore } from '../src/runtime/index.mjs';
import { safeGit } from '../src/safe-git.mjs';

const [major, minor] = process.versions.node.split('.').map(Number);
const sqliteAvailable = major > 24 || (major === 24 && minor >= 14);

test('a current Human approval creates one durable task pinned to its draft and recovers a lost receipt', { skip: !sqliteAvailable }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cccp-handoff-'));
  let chatDb;
  t.after(async () => {
    chatDb?.close();
    await rm(root, { recursive: true, force: true });
  });
  const repository = join(root, 'repo');
  await mkdir(join(repository, 'src'), { recursive: true });
  const git = args => safeGit(repository, args);
  await git(['init']);
  const sourceFile = join(repository, 'src', 'value.txt');
  const commit = async value => {
    await writeFile(sourceFile, value);
    await git(['add', 'src/value.txt']);
    await git(['-c', 'user.name=CCCP Test', '-c', 'user.email=cccp@example.invalid', 'commit', '-m', value]);
    return (await git(['rev-parse', 'HEAD'])).stdout.trim();
  };
  await commit('baseline');

  const configPath = join(root, 'config.json');
  const databasePath = join(root, 'chat.sqlite');
  const runtimePath = join(root, 'chat-runtime.sqlite');
  await writeFile(configPath, JSON.stringify({
    project: { repository, description: 'Demo repository', allowed_paths: ['src'], verification_commands: [['node', '--test']] },
    chatting_agent: { provider: 'deepseek-responses', model: 'deepseek-flash', model_env: 'CCCP_CHAT_MODEL', api_key_env: 'DEEPSEEK_API_KEY' },
  }));
  const { project } = await loadChatConfig(configPath);
  chatDb = await openSessionStore(databasePath);
  const legacyDraft = {
    goal: '更新提示', approach: '只修改提示文本', constraints: ['退出码保持不变'], non_goals: ['不修改其他文件'],
    acceptance_criteria: ['新提示可见'], suggested_paths: ['src/value.txt'],
  };
  const session = chatDb.create(await snapshotProject(project));
  chatDb.save(session, {
    messages: [{ role: 'user', content: '请修改提示' }],
    drafts: [1, 2].map(version => ({
      version, messageCount: 1, createdAt: new Date().toISOString(), model: 'deepseek-flash', content: legacyDraft,
    })),
  });
  const run = async (commands, env = {}) => {
    let text = '';
    const output = new Writable({ write(chunk, _encoding, callback) { text += chunk.toString(); callback(); } });
    await runChat({
      args: ['--config', configPath, '--resume', session.id],
      input: Readable.from([commands.join('\n') + '\n']), output, databasePath, env,
      fetchImpl: async () => {
        assert.ok(env.DEEPSEEK_API_KEY);
        return Response.json({
          status: 'completed', model: 'deepseek-flash',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ ...legacyDraft, questions: [] }) }] }],
        });
      },
    });
    return text;
  };

  assert.match(await run(['/show 1', '/approve 1', '/task']), /请确认最新讨论对应的草稿版本/);
  const newHead = await commit('new baseline');
  assert.match(await run(['/approve 2', '/task']), /仓库基线已变化/);
  assert.equal(chatDb.load(session.id).approval, undefined);

  assert.match(await run(['/draft'], { DEEPSEEK_API_KEY: 'fixture-key' }), /草稿 v3/);
  await writeFile(sourceFile, 'uncommitted local changes');
  const approved = await run(['/approve 3', '/approve 3', '/task']);
  const { approval } = chatDb.load(session.id);
  assert.equal(approval.baseCommit, newHead);
  assert.equal(approval.draftVersion, 3);
  assert.equal(approval.payloadHash, digest(approval.request.payload));
  assert.equal(approval.receipt.taskId, approval.request.context.task_id);
  assert.equal([...approved.matchAll(/任务状态：DISCOVERY/g)].length, 3);
  assert.match(approved, /Agent 运行次数：0 · 工具操作次数：0/);
  assert.equal(await readFile(sourceFile, 'utf8'), 'uncommitted local changes');
  assert.equal(await readFile(join(approval.request.payload.profile.repository, 'src', 'value.txt'), 'utf8'), 'new baseline');

  const { receipt: _lost, ...withoutReceipt } = approval;
  chatDb.save(chatDb.load(session.id), { approval: withoutReceipt });
  assert.match(await run(['/task', '/approve 3']), /任务状态：DISCOVERY/);
  assert.equal(chatDb.load(session.id).approval.receipt.taskId, approval.receipt.taskId);

  const runtime = await SqliteDatabase.open({ path: runtimePath });
  try {
    assert.equal(runtime.db.prepare('SELECT count(*) AS total FROM tasks').get().total, 1);
    const { data } = await new SqliteStateStore({ database: runtime }).recover(approval.receipt.taskId);
    assert.deepEqual(data.approval.approval.actor, { id: 'local-human', role: 'human' });
    assert.deepEqual(data.journal.payload, approval.request.payload);
    assert.equal(data.protocol_audit.filter(entry => entry.type === 'DECISION_TRANSITION' && entry.data.to === 'APPROVED').length, 1);
  } finally {
    runtime.close();
  }
});
