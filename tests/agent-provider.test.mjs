import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatGPTReviewProvider, CodexAgentProvider, DeepSeekReviewProvider, OpenAIReviewProvider, RoutedAgentProvider, agentFileDelta, captureAgentFiles, validateFileChanges } from '../src/index.mjs';
import { codex, chatgpt } from '../examples/fixtures.mjs';

const context = principal => ({ task_id: 'task', principal, state_version: 3, delegation_ref: 'delegation', workspace_ref: 'workspace', correlation_id: 'correlation' });
const base = (principal, patch = {}) => ({ run_id: 'run', template_version: 'm4-v1', input: {}, context: context(principal), input_schema: 'RuntimeAgentInput',
  context_snapshot: {}, repository_snapshot: { fingerprint: 'before' }, delegation: { id: 'delegation', decision_id: 'decision', allowed: ['internal_implementation'], forbidden: [], paths: ['src'] },
  allowed_tools: ['read_repository'], simulation: false, ...patch });
const report = { id: 'report', specification_id: 'spec', discovery_fingerprint: 'before', summary: 'bounded change', changed_files: ['src/value.txt'], evidence: [],
  unexpected_deviations: [], risk: 'low', triggers: [] };
const review = { id: 'review', report_id: 'report', review_level: 'R3', reviewer: chatgpt, decision: 'APPROVE', confidence: 0.9, findings: [], evidence: ['evidence:1:hash'],
  failed_requirements: [], requirements: [], implementation_status: 'pass', specification_compliance: 'pass', architecture_compliance: 'pass', boundary_violation: false, reason: 'verified' };

test('Codex real provider binds structured output and bounded file changes', async () => {
  let started;
  const client = { start(options) { started = options; return { binding: { backend: 'codex-app-server', pid: 42, run_id: options.runId }, result: Promise.resolve({
    output: { output: report, file_changes: [{ path: 'src/value.txt', content: 'ready\n' }] }, thread_id: 'thread', turn_id: 'turn', usage: { input_tokens: 10, output_tokens: 5 } }) }; },
  cancel: async () => true, inspect: () => null };
  const provider = new CodexAgentProvider({ client, cwd: process.cwd(), model: 'test-model' });
  const run = await provider.implement(base(codex));
  assert.equal(run.simulation, false); assert.equal(run.provider, 'openai-codex-app-server'); assert.equal(run.execution_binding.thread_id, 'thread');
  assert.deepEqual(run.artifacts.file_changes, [{ path: 'src/value.txt', content: 'ready\n' }]);
  assert.equal(started.sandbox, 'readOnly'); assert.equal(started.timeoutMs, 300000); assert.equal(started.outputSchema.additionalProperties, false);
});

test('Codex App Server recovery stays fail-closed without remote turn reconciliation', async () => {
  const client = { start() { throw new Error('unused'); }, cancel: async () => true, inspect: () => null };
  const provider = new CodexAgentProvider({ client, cwd: process.cwd(), model: 'test-model' });
  assert.deepEqual(await provider.reconcile({ execution_binding: { pid: 1234 } }),
    { stopped: false, result_discarded: true, reason: 'remote_start_unverified' });
  assert.deepEqual(await provider.reconcile({ execution_binding: { pid: 1234, thread_id: 'thread', turn_id: 'turn' } }),
    { stopped: false, result_discarded: true, reason: 'remote_turn_unverified' });
});

test('Agent file changes reject traversal, duplicates and oversized content', () => {
  assert.throws(() => validateFileChanges([{ path: '../secret', content: 'x' }]));
  assert.throws(() => validateFileChanges([{ path: 'src/a', content: 'x' }, { path: 'src/a', content: 'y' }]));
  assert.throws(() => validateFileChanges([{ path: 'src/a', content: 'x'.repeat(1024 * 1024 + 1) }]));
});

test('DIFF evidence records actual before/after content and rejects unapplied candidates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cccp-agent-diff-'));
  try {
    await mkdir(join(directory, 'src')); await writeFile(join(directory, 'src', 'value.txt'), 'before\n');
    const changes = [{ path: 'src/value.txt', content: 'after\n' }], before = await captureAgentFiles(directory, changes);
    await writeFile(join(directory, 'src', 'value.txt'), 'after\n');
    const after = await captureAgentFiles(directory, changes, { requireExpected: true });
    const delta = agentFileDelta({ sourceRunId: 'run', before, after });
    assert.equal(delta.changes[0].changed, true); assert.equal(delta.source_run_id, 'run');
    await writeFile(join(directory, 'src', 'value.txt'), 'different\n');
    await assert.rejects(captureAgentFiles(directory, changes, { requireExpected: true }), error => error.code === 'AGENT_CHANGE_MISMATCH');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('ChatGPT review provider is independent and exposes no implementation route', async () => {
  const client = { start(options) { return { binding: { backend: 'codex-app-server', pid: 43, run_id: options.runId }, result: Promise.resolve({
    output: { output: review }, thread_id: 'review-thread', turn_id: 'review-turn' }) }; }, cancel: async () => true, inspect: () => null };
  const provider = new ChatGPTReviewProvider({ client, cwd: process.cwd(), model: 'review-model' });
  assert.equal((await provider.capabilities()).independent_review, true);
  const run = await provider.review(base(chatgpt, { review_level: 'R3', output_schema: 'ReviewResult', allowed_tools: [] }));
  assert.deepEqual(run.output, review); await assert.rejects(provider.implement(base(codex)));
});

test('OpenAI review provider uses a stored background response and preserves remote id', async () => {
  let request;
  const fetchImpl = async (url, options = {}) => { request = { url, options }; return { ok: true, status: 200, json: async () => ({ id: 'resp_1', status: 'completed', model: 'review-model', output_text: JSON.stringify(review), usage: { input_tokens: 1, output_tokens: 1 } }) }; };
  const provider = new OpenAIReviewProvider({ apiKey: 'test-key', model: 'review-model', fetchImpl, pollMs: 0 });
  const run = await provider.review(base(chatgpt, { review_level: 'R3', output_schema: 'ReviewResult', allowed_tools: [] }));
  const body = JSON.parse(request.options.body); assert.equal(body.background, true); assert.equal(body.store, true); assert.equal(body.metadata.cccp_run_id, 'run');
  assert.equal(run.execution_binding.response_id, 'resp_1'); assert.equal(run.simulation, false);
});

test('OpenAI recovery only proves stopped after a terminal remote status', async () => {
  const statuses = ['in_progress', 'in_progress'];
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ id: 'resp_1', status: statuses.shift() }) });
  const provider = new OpenAIReviewProvider({ apiKey: 'test-key', model: 'review-model', fetchImpl, pollMs: 0 });
  assert.deepEqual(await provider.reconcile({ execution_binding: { response_id: 'resp_1' } }),
    { stopped: false, result_discarded: false, reason: 'remote_status_in_progress' });
});

test('OpenAI recovery accepts a confirmed cancelled response', async () => {
  const statuses = ['in_progress', 'cancelled'];
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ id: 'resp_1', status: statuses.shift() }) });
  const provider = new OpenAIReviewProvider({ apiKey: 'test-key', model: 'review-model', fetchImpl, pollMs: 0 });
  assert.deepEqual(await provider.reconcile({ execution_binding: { response_id: 'resp_1' } }),
    { stopped: true, result_discarded: true, reason: 'recovered_cancelled' });
});

test('DeepSeek review provider uses the Responses wire format without claiming OpenAI provenance', async () => {
  let request;
  const fetchImpl = async (url, options = {}) => { request = { url, options }; return { ok: true, status: 200, json: async () => ({
    id: 'deepseek-response', status: 'completed', model: 'deepseek-flash', output_text: JSON.stringify(review), usage: { input_tokens: 1, output_tokens: 1 },
  }) }; };
  const provider = new DeepSeekReviewProvider({ apiKey: 'test-key', model: 'deepseek-flash', fetchImpl, pollMs: 0 });
  const capabilities = await provider.capabilities();
  const run = await provider.review(base(chatgpt, { review_level: 'R3', output_schema: 'ReviewResult', allowed_tools: [] }));
  assert.equal(request.url, 'https://api.deepseek.com/responses');
  const body = JSON.parse(request.options.body);
  assert.equal(body.background, undefined); assert.equal(body.store, undefined); assert.equal(body.metadata, undefined);
  assert.equal(capabilities.backend, 'deepseek-responses'); assert.equal(capabilities.independent_review, true);
  assert.equal(capabilities.recovery, false); assert.equal(capabilities.cancellation, false);
  assert.equal(run.provider, 'deepseek-responses'); assert.equal(run.provider_kind, 'deepseek-reviewer');
  assert.equal(run.execution_binding.backend, 'deepseek-responses'); assert.equal(run.review_boundary, 'independent-run');
  assert.deepEqual(await provider.reconcile(run), { stopped: false, result_discarded: false, reason: 'stateless_response_unverifiable' });
});

test('Routed provider advertises real agents only with a distinct independent reviewer', async () => {
  const implementer = { capabilities: async () => ({ simulation: false, backend: 'codex-app-server', cancellation: true, recovery: true, provider_id: 'implementer' }), deliberate() {}, implement() {}, review() {}, dispatch() {}, cancel() {}, inspect() {}, reconcile() {} };
  const reviewer = { capabilities: async () => ({ simulation: false, backend: 'openai-responses', cancellation: true, recovery: true, independent_review: true,
    provider_id: 'reviewer', review_boundary: 'independent-run' }), review() {}, dispatch() {}, cancel() {}, inspect() {}, reconcile() {} };
  const provider = new RoutedAgentProvider({ implementer, reviewer }); const capabilities = await provider.capabilities();
  assert.equal(capabilities.backend, 'routed-agent'); assert.equal(capabilities.independent_review, true); assert.equal(capabilities.simulation, false);
});

test('Routed provider rejects incomplete implementer and reviewer route surfaces', () => {
  const capabilities = async () => ({ simulation: false, backend: 'codex-app-server', cancellation: true, recovery: true, provider_id: 'incomplete' });
  assert.throws(() => new RoutedAgentProvider({ implementer: { capabilities }, reviewer: { capabilities } }), error => error.code === 'INVALID_PROVIDER');
});
