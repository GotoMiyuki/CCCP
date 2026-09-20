import assert from 'node:assert/strict';
import test from 'node:test';
import { DeepSeekReviewProvider } from '../src/index.mjs';
import { chatgpt } from '../examples/fixtures.mjs';

const enabled = process.env.CCCP_DEEPSEEK_TESTS === '1';

test('real DeepSeek structured review returns a provider-bound candidate without GPT usage', { skip: !enabled, timeout: 180000 }, async () => {
  const provider = new DeepSeekReviewProvider({ apiKey: process.env.DEEPSEEK_API_KEY,
    model: process.env.CCCP_DEEPSEEK_MODEL ?? 'deepseek-flash', maxOutputTokens: 2048 });
  const artifact_ref = 'evidence:deepseek-probe:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const run = await provider.review({ run_id: 'deepseek-review-probe', template_version: 'deepseek-review-v1', review_level: 'R3',
    input_schema: 'RuntimeAgentInput', output_schema: 'ReviewResult', allowed_tools: [], simulation: false,
    context: { task_id: 'deepseek-probe', principal: chatgpt, state_version: 1, delegation_ref: 'delegation',
      workspace_ref: 'workspace', correlation_id: 'deepseek-probe' },
    context_snapshot: { state: 'ARCHITECTURE_REVIEW' }, repository_snapshot: { fingerprint: 'probe-snapshot' },
    delegation: { id: 'delegation', decision_id: 'decision', allowed: [], forbidden: [], paths: ['src'] },
    input: {
      decision: { id: 'decision', goal: 'Verify the bounded probe without changing architecture' },
      specification: { id: 'specification', objective: 'Return a structured R3 judgment' },
      report: { id: 'report', summary: 'No repository change; API contract probe only' },
      repository_snapshot: { fingerprint: 'probe-snapshot' },
      artifacts: [{ artifact_ref, type: 'TEST_RUN', status: 'pass', content: 'Synthetic API contract fixture; no CCCP acceptance claim.' }],
    },
  });
  assert.equal(run.status, 'COMPLETED'); assert.equal(run.provider, 'deepseek-responses');
  assert.equal(run.provider_kind, 'deepseek-reviewer'); assert.equal(run.output.reviewer.id, chatgpt.id);
  assert.equal(run.output.review_level, 'R3');
});
