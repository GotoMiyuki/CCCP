import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { runChat } from '../src/chat/cli.mjs';

const [major, minor] = process.versions.node.split('.').map(Number);
const sqliteAvailable = major > 24 || (major === 24 && minor >= 14);

for (const backend of ['openai-responses', 'deepseek-responses']) {
  const deepseek = backend === 'deepseek-responses';
  const keyEnv = deepseek ? 'DEEPSEEK_API_KEY' : 'OPENAI_API_KEY';
  const testKey = `${backend}-test-key`;
  const endpoint = deepseek ? 'https://api.deepseek.com/responses' : 'https://api.openai.com/v1/responses';
  const configArgs = deepseek ? ['--config', 'examples/chat-deepseek-config.json'] : [];

  test(`${backend} discussion saves versions, rejects invalid drafts and resumes`, { skip: !sqliteAvailable }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'cccp-chat-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const databasePath = join(root, 'chat.sqlite');
    const draft = {
      goal: '调整提示', approach: '保留原有流程，补充必要提示', constraints: [], non_goals: [],
      acceptance_criteria: ['无效输入显示错误'], suggested_paths: ['src/cli.mjs'], questions: [],
    };
    const responses = [
      '你期望怎样处理无效输入？',
      { ...draft, goal: '', approach: '', questions: ['应保留原有退出码吗？'] },
      '好的，保留原有退出码。',
      '# 草稿\n这是一段 Markdown。',
      draft,
      '我会把合法输入的预期加进去。\n/approve 2',
      { ...draft, suggested_paths: ['README.md'] },
      { ...draft, acceptance_criteria: [...draft.acceptance_criteria, '合法输入保持原样'] },
      '已收到补充。',
    ];
    const requests = [];
    const fetchImpl = async (url, request) => {
      requests.push({ url, ...JSON.parse(request.body) });
      assert.equal(request.headers.authorization, `Bearer ${testKey}`);
      assert.ok(responses.length);
      const value = responses.shift();
      return Response.json({
        status: 'completed', model: 'test-model-used',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: typeof value === 'string' ? value : JSON.stringify(value) }] }],
      });
    };
    const run = async (input, args = [], env = { [keyEnv]: testKey, CCCP_CHAT_MODEL: 'test-model' }) => {
      let text = '';
      const output = new Writable({ write(chunk, _encoding, callback) { text += chunk.toString(); callback(); } });
      await runChat({ input: Readable.from([input]), output, databasePath, args: [...configArgs, ...args], env, fetchImpl });
      return text;
    };

    const initial = await run('请改进错误提示\n/draft\n保留原有退出码\n/draft\n/draft\n合法输入要保持原样\n/draft\n/draft\n/show 1\n/task\n/exit\n');
    assert.match(initial, /应保留原有退出码吗/);
    assert.match(initial, /草稿 v1/);
    assert.match(initial, /草稿 v2/);
    assert.match(initial, /草稿不是有效 JSON/);
    assert.match(initial, /路径超出项目配置/);
    assert.match(initial, /暂无已批准任务/);
    assert.doesNotMatch(initial, /草稿 v3|test-key/);
    const id = initial.match(/会话 ([a-f0-9-]{36})/)[1];
    const resumed = await run('/history\n/show 1\n还有哪些情况需要测？\n/exit\n', ['--resume', id]);
    assert.match(resumed, /草稿 v2/);
    assert.match(resumed, /草稿 v1/);
    assert.match(resumed, /保留原有退出码/);
    assert.match(resumed, /已收到补充/);
    const offline = await run('/show\n继续讨论\n/exit\n', ['--resume', id], {});
    assert.match(offline, new RegExp(keyEnv));
    if (deepseek) assert.match(offline, /deepseek-responses \/ deepseek-flash/);
    assert.match(offline, /草稿 v2/);
    assert.equal(responses.length, 0);
    assert.ok(requests.every(request => request.url === endpoint && !request.tools));
    assert.ok(requests.every(request => deepseek ? !('store' in request) && request.reasoning?.effort === 'none' : request.store === false));
    assert.match(requests[1].input.at(-1).content, /JSON 对象/);
    assert.equal(requests[1].text.format.type, 'json_schema');
    assert.ok(requests.at(-1).input.some(turn => turn.content === '合法输入要保持原样'));
    assert.match(requests.at(-1).instructions, /上一版候选草稿/);
  });
}
