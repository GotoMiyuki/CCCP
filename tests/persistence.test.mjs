import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDatabase, SqliteStateStore, DurableBridge, AuditLog, FakeToolRunner, RoutedAgentProvider } from '../src/index.mjs';
import { durableFixture } from './fixtures/durable-host.mjs';
import { prepareSimulation, simulationReport, simulationReview } from '../examples/runtime-workflow.mjs';
import { chatgpt, codex, operationFixture } from '../examples/fixtures.mjs';

const raises = code => error => error.code === code;
const directories = [];
after(async () => { for (const path of directories) await rm(path, { recursive: true, force: true }); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'cccp-durable-')); directories.push(path); await mkdir(join(path, 'repo', 'src'), { recursive: true }); return path; }

test('SQLite migrations are idempotent and reject future versions', async t => {
  const dir = await directory(t), path = join(dir, 'schema.sqlite');
  let database = await SqliteDatabase.open({ path }); assert.equal(database.db.prepare('PRAGMA user_version').get().user_version, 1); database.close();
  database = await SqliteDatabase.open({ path }); database.db.exec('PRAGMA user_version=99'); database.close();
  await assert.rejects(SqliteDatabase.open({ path }), raises('UNSUPPORTED_STORAGE_VERSION'));
});

test('SQLite CAS, snapshot/tail recovery and atomic settlement preserve independent Store revision', async t => {
  const dir = await directory(t), path = join(dir, 'state.sqlite');
  const a = await SqliteDatabase.open({ path }), b = await SqliteDatabase.open({ path }); t.after(() => { a.close(); b.close(); });
  const sa = new SqliteStateStore({ database: a, snapshotInterval: 3 }), sb = new SqliteStateStore({ database: b });
  await sa.create('task', { snapshot: { state_version: 0 } });
  const writes = await Promise.allSettled([sa.compareAndSwap('task', 0, { snapshot: { state_version: 1 } }), sb.compareAndSwap('task', 0, { snapshot: { state_version: 1 } })]);
  assert.equal(writes.filter(r => r.status === 'fulfilled').length, 1);
  await sa.claim('key', 'hash', { task_id: 'task' });
  await sa.compareAndSwap('task', 1, { snapshot: { state_version: 1 } }, { settlements: [{ key: 'key', result: { ok: true } }], outbox: [{ id: 'receipt', payload: { ok: true } }] });
  await sa.compareAndSwap('task', 2, { snapshot: { state_version: 2 } });
  const recovered = await sb.recover('task'); assert.equal(recovered.snapshot_offset, 3); assert.equal(recovered.replayed_events, 1); assert.equal(recovered.data.snapshot.state_version, 2);
  assert.equal((await sb.claim('key', 'hash')).result.ok, true); assert.equal((await sb.outbox('task')).length, 1);
  await assert.rejects(sb.claim('key', 'different'), raises('IDEMPOTENCY_CONFLICT'));
});

test('transaction failure leaves state, log, audit, outbox and receipt unchanged', async t => {
  const dir = await directory(t), database = await SqliteDatabase.open({ path: join(dir, 'rollback.sqlite') }); t.after(() => database.close());
  const state = new SqliteStateStore({ database }); await state.create('task', { snapshot: { state_version: 0 } }); await state.claim('key', 'hash');
  database.fault = point => { if (point === 'state_staged') throw new Error('Injected transaction failure'); };
  await assert.rejects(state.compareAndSwap('task', 0, { snapshot: { state_version: 1 } }, { settlements: [{ key: 'key', result: { ok: true } }], outbox: [{ id: 'message', payload: {} }] }), /Injected/);
  database.fault = () => {};
  assert.equal((await state.recover('task')).data.snapshot.state_version, 0); assert.equal((await state.claim('key', 'hash')).status, 'PENDING'); assert.deepEqual(await state.outbox('task'), []);
});

test('recovery replays Controller guards, preserves evidence and resumes after R2 without repeating reviews', async t => {
  const dir = await directory(t); let sim = await durableFixture(dir); await prepareSimulation(sim);
  const executed = await sim.call('executeTool', 'codex', { operation_id: 'op-1', attempt_id: 'op' }, { key: 'execute' }); const ref = executed.result.evidence_ref;
  await sim.call('submitReport', 'codex', simulationReport(sim, executed.snapshot));
  for (const level of ['R1', 'R2']) await sim.call('submitReview', 'codex', { review: simulationReview(sim, level, ref), evidence_refs: [ref] }, { key: level });
  const before = (await sim.call('inspectTask', 'human')).snapshot; sim.database.close();
  sim = await durableFixture(dir, { start: false, recover: true }); t.after(() => sim.database.close());
  assert.deepEqual((await sim.call('inspectTask', 'human')).snapshot, before);
  assert.equal((await sim.providers.evidence.verify(ref, { task_id: sim.context.task_id })).status, 'pass');
  assert.equal((await sim.call('routeReview', 'codex')).snapshot.state, 'DONE');
  assert.equal(AuditLog.verify((await sim.call('inspectTask', 'human')).result.protocol_audit), true);
});

test('Human Stop and session revocation survive opening a new database connection', async t => {
  const dir = await directory(t); let sim = await durableFixture(dir); await prepareSimulation(sim);
  await sim.call('stopTask', 'human', { reason: 'Persist Human Stop' }); await sim.providers.identity.revoke('durable-chatgpt'); sim.database.close();
  sim = await durableFixture(dir, { start: false, recover: true }); t.after(() => sim.database.close());
  assert.equal((await sim.call('inspectTask', 'human')).snapshot.human_stopped, true);
  await assert.rejects(sim.call('resumeTask', 'codex', { resolution: 'Cannot erase Stop' }), raises('AUTHORITY_BOUNDARY_EXCEEDED'));
  await assert.rejects(sim.providers.identity.authenticate('durable-chatgpt'), raises('UNAUTHENTICATED'));
});

test('corrupted event/projection cannot restore a task or fabricate DONE', async t => {
  const dir = await directory(t); const sim = await durableFixture(dir); sim.database.close();
  const database = await SqliteDatabase.open({ path: join(dir, 'runtime.sqlite') }); t.after(() => database.close());
  const state = new SqliteStateStore({ database }), saved = await state.read('durable-task');
  const corrupted = structuredClone(saved.data); corrupted.snapshot.state = 'DONE';
  database.db.prepare('UPDATE tasks SET data=? WHERE task_id=?').run(JSON.stringify(corrupted), 'durable-task');
  await assert.rejects(state.recover('durable-task'), raises('CORRUPT_RECOVERY'));
});

test('DurableBridge deduplicates after reconstruction and never blindly retries uncertain outbox delivery', async t => {
  const dir = await directory(t), database = await SqliteDatabase.open({ path: join(dir, 'bridge.sqlite') }); t.after(() => database.close());
  const state = new SqliteStateStore({ database });
  const sessions = [{ id: 'bridge-session', token: 'durable-bridge-token', actor: codex, task_id: 'bridge-task', repository: { path: dir, branch: null, commit: null }, allowed_types: ['DISCOVERY_REQUEST'], expires_at: 4102444800000 }];
  const message = { protocol: 'CCCP', version: '1.0', task_id: 'bridge-task', message_type: 'DISCOVERY_REQUEST', message_id: 'message-1', timestamp: '2026-09-17T00:00:00Z', repository: sessions[0].repository, payload: { related_paths: ['src'] } };
  let deliveries = 0; const routes = { DISCOVERY_REQUEST: async () => { deliveries++; } };
  await new DurableBridge({ state, sessions, routes }).send('durable-bridge-token', message);
  const bridge = new DurableBridge({ state, sessions, routes }); await bridge.send('durable-bridge-token', message); assert.equal(deliveries, 1);
  await bridge.queue('durable-bridge-token', message);
  const seen = []; await bridge.flush('bridge-task', async event => { seen.push(event.idempotency_key); throw new Error('ACK lost'); });
  await bridge.flush('bridge-task', async () => { assert.fail('Must not redeliver uncertain output automatically'); });
  await bridge.flush('bridge-task', async event => seen.push(event.idempotency_key), { retryUncertain: true });
  assert.equal(seen.length, 2); assert.equal(seen[0], seen[1]); assert.equal((await state.outbox('bridge-task'))[0].status, 'DELIVERED');
});

test('explicit Human acceptance is journaled and recovered as the same DONE with the same audit', async t => {
  const dir = await directory(); let sim = await durableFixture(dir, { humanAcceptance: true }); await prepareSimulation(sim);
  const executed = await sim.call('executeTool', 'codex', { operation_id: 'op-1', attempt_id: 'accepted' }, { key: 'accepted' });
  const ref = executed.result.evidence_ref; await sim.call('submitReport', 'codex', simulationReport(sim, executed.snapshot));
  for (const level of ['R1', 'R2']) await sim.call('submitReview', 'codex', { review: simulationReview(sim, level, ref), evidence_refs: [ref] });
  await sim.call('routeReview', 'codex');
  await sim.call('submitReview', 'chatgpt', { review: simulationReview(sim, 'R3', ref), evidence_refs: [ref] });
  const accepted = await sim.call('acceptTask', 'human', { reason: 'Synthetic Human acceptance persistence test' });
  const audit = (await sim.call('inspectTask', 'human')).result.protocol_audit;
  await sim.host.close(); sim.database.close();
  sim = await durableFixture(dir, { start: false, recover: true }); t.after(() => sim.database.close());
  const recovered = await sim.call('inspectTask', 'human'); assert.equal(recovered.snapshot.state, 'DONE');
  assert.deepEqual(recovered.snapshot, accepted.snapshot); assert.deepEqual(recovered.result.protocol_audit, audit);
});

test('synthetic provider fault requires reconciliation even after FINISHED; a fake replacement cannot hide it', async t => {
  // No container executes here: this deliberately faulty test provider exercises Host guards.
  class Fault extends FakeToolRunner {
    stopped = false; seen = null;
    async capabilities() { return { simulation: false, backend: 'docker', sandbox: 'docker', cancellation: true }; }
    async describeAttempt() { return { backend: 'docker', identity: 'persisted-run' }; }
    async run() { return { outcome: 'EFFECT_UNKNOWN', stdout: '', stderr: '', exit_code: null, process_tree_stopped: false, simulation: false }; }
    async reconcile(input) { this.seen = input; return { stopped: this.stopped, simulation: false }; }
  }
  const dir = await directory(), tool = new Fault(); let sim = await durableFixture(dir, { tool }); await prepareSimulation(sim);
  await assert.rejects(sim.call('executeTool', 'codex', { operation_id: 'op-1', attempt_id: 'uncertain' }, { key: 'uncertain' }), raises('EFFECT_UNKNOWN'));
  await assert.rejects(sim.host.close(), raises('RECONCILIATION_REQUIRED')); sim.database.close();
  sim = await durableFixture(dir, { start: false });
  await assert.rejects(sim.call('recoverTask', 'human'), raises('RECONCILIATION_REQUIRED')); sim.database.close();
  sim = await durableFixture(dir, { start: false, tool });
  await assert.rejects(sim.call('recoverTask', 'human'), raises('RECONCILIATION_REQUIRED'));
  tool.stopped = true; await sim.call('recoverTask', 'human');
  assert.equal(tool.seen.execution_binding.identity, 'persisted-run');
  assert.equal((await sim.call('inspectTask', 'human')).result.operations[0].reconciliation.stopped, true);
  await sim.host.close(); await assert.rejects(sim.call('inspectTask', 'human'), raises('RUNTIME_CLOSED')); sim.database.close();
});

test('unfinished and transport-failed real Agent runs fail closed until the original execution is proven stopped', async t => {
  const dir = await directory(); let sim = await durableFixture(dir);
  await sim.host.close(); sim.database.close();
  let database = await SqliteDatabase.open({ path: join(dir, 'runtime.sqlite') });
  let state = new SqliteStateStore({ database }), stored = await state.read('durable-task');
  const data = structuredClone(stored.data);
  data.agent_runs.push({ run_id: 'orphan-agent', kind: 'implement', review_level: null, status: 'RUNNING', simulation: false,
    context: { task_id: 'durable-task', principal: codex, state_version: data.snapshot.state_version, delegation_ref: data.approval.delegation.id,
      workspace_ref: 'durable-workspace', correlation_id: 'orphan' }, execution_binding: { backend: 'codex-app-server', pid: 424242, run_id: 'orphan-agent' } });
  data.agent_runs.push({ run_id: 'failed-agent', kind: 'implement', review_level: null, status: 'FAILED', accepted: false,
    reconciliation_required: true, external_execution_stopped: false, simulation: false,
    context: { task_id: 'durable-task', principal: codex, state_version: data.snapshot.state_version, delegation_ref: data.approval.delegation.id,
      workspace_ref: 'durable-workspace', correlation_id: 'failed' }, execution_binding: { backend: 'codex-app-server', pid: 424243, run_id: 'failed-agent' } });
  await state.compareAndSwap('durable-task', stored.store_revision, data); database.close();
  const provider = stopped => ({
    capabilities: async () => ({ simulation: false, backend: 'codex-app-server', cancellation: true, recovery: true, provider_id: 'recovery-agent' }),
    deliberate: async () => {}, implement: async () => {}, review: async () => {}, cancel: async () => false, inspect: async () => null,
    reconcile: async run => ({ stopped, reason: stopped ? 'process_absent' : `unverified_${run.execution_binding.pid}` }),
  });
  sim = await durableFixture(dir, { start: false, agent: provider(false) });
  await assert.rejects(sim.call('recoverTask', 'human'), raises('RECONCILIATION_REQUIRED')); sim.database.close();
  sim = await durableFixture(dir, { start: false, agent: provider(true) }); t.after(() => sim.database.close());
  await sim.call('recoverTask', 'human');
  const runs = (await sim.call('inspectTask', 'human')).result.agent_runs.filter(item => ['orphan-agent', 'failed-agent'].includes(item.run_id));
  assert.equal(runs.length, 2); assert.ok(runs.every(run => run.status === 'INTERRUPTED' && run.accepted === false && run.reconciliation.stopped));
});

test('live resume reconciles an unverified real tool before another operation can run', async t => {
  class UnverifiedTool extends FakeToolRunner {
    stopped = false; runs = 0; reconciliations = 0;
    async capabilities() { return { simulation: false, backend: 'docker', sandbox: 'docker', cancellation: true, recovery: true }; }
    async describeAttempt() { return { backend: 'docker', identity: `probe-${this.runs + 1}` }; }
    async run() { this.runs++; return { outcome: 'EFFECT_UNKNOWN', stdout: '', stderr: '', exit_code: null,
      process_tree_stopped: false, simulation: false }; }
    async reconcile() { this.reconciliations++; return { stopped: this.stopped, simulation: false }; }
  }
  const dir = await directory(), tool = new UnverifiedTool(); const sim = await durableFixture(dir, { tool }); t.after(() => sim.database.close());
  await prepareSimulation(sim);
  await assert.rejects(sim.call('executeTool', 'codex', { operation_id: 'op-1', attempt_id: 'unverified' }, { key: 'unverified' }), raises('EFFECT_UNKNOWN'));
  await sim.call('inspectTask', 'human');
  await assert.rejects(sim.call('resumeTask', 'codex', { resolution: 'Reality was inspected' }), raises('RECONCILIATION_REQUIRED'));
  assert.equal(tool.runs, 1); assert.equal(tool.reconciliations, 1);
  tool.stopped = true;
  assert.equal((await sim.call('resumeTask', 'codex', { resolution: 'Old execution is now proven stopped' })).snapshot.state, 'DISCOVERY');
  assert.equal((await sim.call('inspectTask', 'human')).result.operations[0].reconciliation.stopped, true);
});

test('a rejected independent R3 output cannot be resubmitted with a different evidence set', async t => {
  let implementationOutput, reviewOutput;
  const run = (request, patch) => ({ ...request, kind: request.kind, provider: 'test-provider', status: 'COMPLETED',
    principal: request.context.principal, role: request.context.principal.role, termination_reason: 'completed',
    external_execution_stopped: true, simulation: false, ...patch });
  const implementer = {
    capabilities: async () => ({ simulation: false, backend: 'codex-app-server', cancellation: true, recovery: true, provider_id: 'test-implementer' }),
    deliberate: async () => {}, implement: async () => {}, review: async () => {}, cancel: async () => true, inspect: async () => null,
    reconcile: async () => ({ stopped: true }),
    dispatch(kind, request) { return { binding: { backend: 'codex-app-server', thread_id: 'implementation-thread' }, result: Promise.resolve(run(request, {
      kind, provider_kind: 'codex-implementer', provider_instance: 'test-implementer', output: implementationOutput,
      artifacts: { file_changes: [{ path: 'src/probe.txt', content: 'probe' }] },
      execution_binding: { backend: 'codex-app-server', thread_id: 'implementation-thread', turn_id: 'implementation-turn' },
    })) }; },
  };
  const reviewer = {
    capabilities: async () => ({ simulation: false, backend: 'openai-responses', cancellation: true, recovery: true, independent_review: true,
      provider_id: 'test-reviewer', review_boundary: 'independent-run' }),
    review: async () => {}, cancel: async () => true, inspect: async () => null, reconcile: async () => ({ stopped: true }),
    dispatch(kind, request) { return { binding: { backend: 'openai-responses', response_id: 'review-response' }, result: Promise.resolve(run(request, {
      kind, provider_kind: 'openai-reviewer', provider_instance: 'test-reviewer', independent_review: true, review_boundary: 'independent-run',
      output: reviewOutput, execution_binding: { backend: 'openai-responses', response_id: 'review-response' },
    })) }; },
  };
  const tool = {
    capabilities: async () => ({ simulation: false, backend: 'docker', sandbox: 'docker', cancellation: true, recovery: true }),
    describeAttempt: async ({ attempt_id }) => ({ backend: 'docker', identity: attempt_id }), cancel: async () => true,
    inspect: async () => null, reconcile: async () => ({ stopped: true }),
    run: async request => ({ outcome: 'SUCCEEDED', stdout: '', stderr: '', exit_code: 0, process_tree_stopped: true,
      repository_before: request.repository_snapshot, repository_after: request.repository_snapshot, simulation: false,
      ...(request.agent_input ? { file_delta: { format: 'cccp-file-delta-v1', source_run_id: request.agent_input.source_run_id,
        changes: [{ path: 'src/probe.txt', changed: true }] } } : {}) }),
  };
  const dir = await directory(); const agent = new RoutedAgentProvider({ implementer, reviewer });
  const sim = await durableFixture(dir, { agent, tool, humanAcceptance: true }); t.after(() => sim.database.close());
  await sim.call('discoverTask', 'codex');
  const operations = [operationFixture({ id: 'apply' }), operationFixture({ id: 'test', domain: 'test_implementation' }), operationFixture({ id: 'extra' })];
  await sim.call('planTask', 'codex', { summary: 'Independent review evidence binding probe', operations });
  const begun = await sim.call('beginTask', 'codex');
  implementationOutput = simulationReport(sim, begun.snapshot, { changed_files: [] });
  await sim.call('dispatchAgent', 'codex', { kind: 'implement', run_id: 'implementation', template_version: 'test', input: {} });
  const refs = [];
  for (const id of ['apply', 'test', 'extra']) refs.push((await sim.call('executeTool', 'codex',
    { operation_id: id, attempt_id: id, ...(id === 'apply' ? { agent_run_id: 'implementation' } : {}) }, { key: id })).result.evidence_ref);
  await sim.call('submitReport', 'codex', implementationOutput);
  for (const level of ['R1', 'R2']) await sim.call('submitReview', 'codex', { review: simulationReview(sim, level, refs[1]), evidence_refs: [refs[1]] });
  await sim.call('routeReview', 'codex');
  reviewOutput = simulationReview(sim, 'R3', refs[2], { id: 'rejected-r3', reviewer: chatgpt });
  await assert.rejects(sim.call('dispatchAgent', 'chatgpt', { kind: 'review', review_level: 'R3', run_id: 'rejected-r3-run',
    template_version: 'test', input: { evidence_refs: refs.slice(0, 2) } }), raises('INVALID_EVIDENCE'));
  const rejected = (await sim.call('inspectTask', 'human')).result.agent_runs.find(item => item.run_id === 'rejected-r3-run');
  assert.equal(rejected.status, 'COMPLETED'); assert.equal(rejected.accepted, false);
  await assert.rejects(sim.call('submitReview', 'chatgpt', { review: reviewOutput, evidence_refs: [refs[2]] }), raises('AUTHORITY_BOUNDARY_EXCEEDED'));
  assert.equal((await sim.call('inspectTask', 'human')).snapshot.state, 'ARCHITECTURE_REVIEW');
});
