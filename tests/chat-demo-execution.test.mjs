import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { promisify } from 'node:util';
import { runChat } from '../src/chat/cli.mjs';
import { openSessionStore } from '../src/chat/session-store.mjs';
import { requirements } from '../src/decision.mjs';
import { SqliteDatabase, SqliteStateStore } from '../src/runtime/index.mjs';

const runNode = promisify(execFile);

async function runOfflineChat(databasePath, id, commands) {
  const program = [
    "const { runChat } = await import(process.argv[1]);",
    "await runChat({ args: ['--demo', '--resume', process.argv[3]], databasePath: process.argv[2],",
    "  env: {}, fetchImpl: () => { throw new Error('Acceptance must not contact the model'); } });",
  ].join('\n');
  const cli = new URL('../src/chat/cli.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, cli, databasePath, id]);
  child.stdin.end(commands.join('\n') + '\n');
  let output = '';
  let errors = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, errors);
  return output;
}

test('date demo protects and persists Human acceptance across restarts',
  { skip: process.env.CCCP_DOCKER_TESTS !== '1', timeout: 90000 }, async t => {
    const trialDirectory = await mkdtemp(join(tmpdir(), 'cccp-date-demo-'));
    t.after(() => rm(trialDirectory, { recursive: true, force: true }));
    const draft = {
      goal: 'Limit April to 30 days', approach: 'Change the maximum day for April and add regression assertions',
      constraints: ['Preserve other months'], non_goals: [], acceptance_criteria: ['April 31 is invalid'],
      suggested_paths: ['src/date.mjs', 'tests/checks.mjs'], questions: [],
    };
    for (const scenario of ['unsettled-agent', 'failed-tests', 'changed-after-test', 'boundary-violation', 'human-acceptance']) {
      const root = join(trialDirectory, scenario);
      const databasePath = join(root, 'chat.sqlite');
      let worktree, sequence = 0;
      const reviews = [];
      const fetchImpl = async (_url, request) => {
        const body = JSON.parse(request.body);
        let result = 'Agreed.';
        switch (body.text?.format.name) {
          case 'cccp_task_draft': result = JSON.stringify(draft); break;
          case 'cccp_implementation': {
            if (scenario === 'unsettled-agent') throw new TypeError('Connection lost after dispatch');
            const source = JSON.parse(body.input).source_files;
            const [code, tests] = source;
            result = JSON.stringify({ summary: draft.goal, file_changes: [
              { path: code.path, content: code.content.replace('day <= 31', 'day <= (month === 4 ? 30 : 31)') },
              { path: tests.path, content: [
                tests.content,
                "test('April 30 is valid', () => assert.equal(isValidDate(2024, 4, 30), true));",
                "test('April 31 exceeds the cap', () => assert.equal(isValidDate(2024, 4, 31), "
                  + String(scenario === 'failed-tests') + "));",
              ].join('\n') + '\n' },
              ...(scenario === 'boundary-violation' ? [{ path: 'README.md', content: 'Unapproved change' }] : []),
            ] });
            break;
          }
          case 'cccp_review_result': {
            const level = body.instructions.includes('independent R3') ? 'R3' : 'R2';
            reviews.push(level);
            const input = JSON.parse(body.input);
            const refs = input.artifacts.map(artifact => artifact.artifact_ref);
            if (level === 'R3' && scenario === 'changed-after-test') {
              await appendFile(join(worktree, 'src/date.mjs'), '// Edited after testing\n');
            }
            result = JSON.stringify({
              id: `review-${level}`, report_id: input.report.id, review_level: level,
              reviewer: { id: 'fixture-reviewer', role: 'chatgpt' },
              decision: 'APPROVE', confidence: 1, findings: [], evidence: refs, failed_requirements: [],
              requirements: requirements(input.specification).map(item => ({ requirement_id: item.id, status: 'pass', evidence: refs })),
              implementation_status: 'pass', specification_compliance: 'pass', architecture_compliance: 'pass',
              boundary_violation: false, reason: 'Fixture judgment',
            });
            break;
          }
        }
        return Response.json({
          id: `${scenario}-response-${++sequence}`, status: 'completed', model: 'fixture-model',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: result }] }],
        });
      };
      const run = async (commands, id, offline = false) => {
        if (offline) return runOfflineChat(databasePath, id, commands);
        let text = '';
        const output = new Writable({ write(chunk, _encoding, callback) { text += chunk.toString(); callback(); } });
        await runChat({
          args: ['--demo', ...(id ? ['--resume', id] : [])],
          input: Readable.from([commands.join('\n') + '\n']), output, databasePath,
          fetchImpl, env: { ...process.env, DEEPSEEK_API_KEY: 'fixture-key' },
        });
        return text;
      };

      const discussion = await run(['Limit April to 30 days', '/draft', '/exit']);
      assert.match(discussion, /草稿 v1/);
      const id = discussion.match(/会话 ([a-f0-9-]{36})/)[1];
      assert.match(await run(['/approve 1', '/exit'], id), /任务状态：DISCOVERY/);
      const sessions = await openSessionStore(databasePath);
      let approval;
      try {
        approval = sessions.load(id).approval;
        worktree = approval.request.payload.profile.repository;
      }
      finally { sessions.close(); }

      const premature = await run(['/accept Too early', '/task', '/exit'], id, true);
      assert.match(premature, /尚未到达待人工验收/);
      assert.doesNotMatch(premature, /任务状态：DONE/);
      const result = await run(['/run', '/task', '/exit'], id);
      if (scenario !== 'human-acceptance') assert.doesNotMatch(result, /任务状态：HUMAN_ACCEPTANCE|R3：APPROVE/);
      if (scenario === 'unsettled-agent') {
        const operation = result.match(/RECONCILIATION_REQUIRED）：(Agent [\w-]+)/)?.[1];
        assert.ok(operation, result);
        const reopened = await run(['/task', '/run', '/exit'], id, true);
        assert.ok(reopened.includes(operation));
        assert.match(reopened, /Agent 运行次数：1 · 工具操作次数：0/);
        assert.deepEqual(reviews, []);
      } else if (scenario === 'failed-tests') {
        assert.match(result, /测试结果：FAILED_CLEAN/);
        assert.match(result, /任务状态：BLOCKED/);
        assert.deepEqual(reviews, []);
      } else if (scenario === 'changed-after-test') {
        assert.match(result, /The tested files have changed since verification/);
        assert.deepEqual(reviews, ['R2', 'R3']);
      } else if (scenario === 'boundary-violation') {
        assert.match(result, /任务状态：BLOCKED/);
        assert.match(result, /变更提议：Agent file changes exceed Delegation paths/);
        assert.match(result, /工具操作次数：0/);
        await assert.rejects(readFile(join(worktree, 'README.md')), { code: 'ENOENT' });
      } else {
        assert.match(result, /任务状态：HUMAN_ACCEPTANCE/);
        assert.deepEqual(reviews, ['R2', 'R3']);
        const deferred = await run(['/defer Try the date commands first', '/exit'], id, true);
        assert.match(deferred, /最近暂缓验收：.*Try the date commands first/);
        const pending = await run(['/task', '/accept', '/exit'], id, true);
        assert.match(pending, /任务状态：HUMAN_ACCEPTANCE/);
        assert.match(pending, /最近暂缓验收：.*Try the date commands first/);
        assert.match(pending, /请输入 \/accept <验收理由>/);
        assert.ok(pending.includes(worktree));
        assert.ok(pending.includes(approval.request.context.task_id));
        const valid = await runNode(process.execPath, ['src/date.mjs', '2024', '4', '30'], { cwd: worktree });
        assert.equal(valid.stdout.trim(), 'valid');
        await assert.rejects(runNode(process.execPath, ['src/date.mjs', '2024', '4', '31'], { cwd: worktree }),
          error => error.code === 1 && error.stderr.trim() === 'invalid date');

        const date = join(worktree, 'src/date.mjs');
        const testedSource = await readFile(date);
        await appendFile(date, '// Edited while waiting for acceptance\n');
        const stale = await run(['/accept Verified both dates', '/exit'], id, true);
        assert.match(stale, /The tested files have changed since verification/);
        assert.doesNotMatch(stale, /任务状态：DONE/);
        await writeFile(date, testedSource);
        const accepted = await run(['/accept Verified both dates', '/exit'], id, true);
        assert.match(accepted, /任务状态：DONE/);
        const reopened = await run(['/accept Different reason', '/task', '/exit'], id, true);
        assert.match(reopened, /验收理由：Verified both dates/);
        assert.match(reopened, /验收依据：R3 review-R3 · 2 项证据/);
        assert.match(reopened, /Agent 运行次数：3 · 工具操作次数：2/);

        const runtime = await SqliteDatabase.open({ path: join(root, 'chat-runtime.sqlite') });
        try {
          const { data } = await new SqliteStateStore({ database: runtime }).recover(approval.request.context.task_id);
          const events = data.protocol_audit.filter(entry => entry.data.to === 'DONE');
          assert.equal(events.length, 1);
          assert.deepEqual(events[0].actor, approval.actor);
          assert.equal(events[0].data.acceptance, 'Verified both dates');
          assert.deepEqual(events[0].data.evidence, data.operations.map(item => item.evidence_ref.artifact_ref));
          assert.equal(data.simulation, false);
        } finally { runtime.close(); }
      }
    }
  });
