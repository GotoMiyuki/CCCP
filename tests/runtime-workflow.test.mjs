import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as nextTurn } from 'node:timers/promises';
import { createSimulation, prepareSimulation, simulationReport, simulationReview, runSimulation } from '../examples/runtime-workflow.mjs';
import { operationFixture, codex, human, discoveryFixture } from '../examples/fixtures.mjs';
import { AuditLog, FakeAgentProvider } from '../src/index.mjs';

const raises = code => error => error.code === code;
async function waitForRun(provider, id) {
  for (let i = 0; i < 400; i++) { if (await provider.inspect(id)) return; await nextTurn(5); }
  assert.fail('Provider was not dispatched');
}
async function completedTool(options) {
  const sim = await createSimulation(options); await prepareSimulation(sim);
  const result = await sim.call('executeTool', 'codex', { operation_id: 'op-1', attempt_id: 'attempt' }, { key: 'tool' });
  return { sim, result, ref: result.result.evidence_ref };
}
async function reviewReady(options) {
  const fixture = await completedTool(options);
  await fixture.sim.call('submitReport', 'codex', simulationReport(fixture.sim, fixture.result.snapshot));
  return fixture;
}

test('Runtime simulated workflow completes once with valid protocol and Runtime audit chains', async () => {
  const result = await runSimulation(); assert.equal(result.state, 'DONE'); assert.equal(result.audit_valid, true);
  assert.equal(result.operations, 1); assert.match(result.notice, /SIMULATION ONLY/); assert.equal(result.manifest.capabilities.real_agents, false);
  assert.equal(result.agent_runs, 2);
});

for (const [name, change, code] of [
  ['forged Human principal', r => { r.context.principal = human; }, 'AUTHORITY_BOUNDARY_EXCEEDED'],
  ['untrusted actor field', r => { r.actor = human; }, 'INVALID_RUNTIME_CONTRACT'],
  ['absent credential', r => { delete r.credential; }, 'INVALID_RUNTIME_CONTRACT'],
  ['cross-task grant', r => { r.context.task_id = 'other'; }, 'SESSION_SCOPE_EXCEEDED'],
  ['wrong Delegation', r => { r.context.delegation_ref = 'other'; }, 'REFERENCE_MISMATCH'],
  ['wrong workspace', r => { r.context.workspace_ref = 'other'; }, 'REFERENCE_MISMATCH'],
  ['stale version', r => { r.context.state_version = 0; }, 'STALE_STATE_VERSION'],
]) test(`Runtime rejects ${name} before tool dispatch`, async () => {
  const sim = await createSimulation(); await prepareSimulation(sim);
  const request = sim.request('codex', { operation_id: 'op-1', attempt_id: 'blocked-attempt' }, { key: 'blocked' }); change(request);
  await assert.rejects(sim.host.executeTool(request), raises(code)); assert.equal(await sim.providers.tool.inspect('blocked-attempt'), null);
  assert.equal(sim.host.audit.at(-1).type, 'RUNTIME_REJECTED'); assert.equal(AuditLog.verify(sim.host.audit), true);
  assert.ok(!JSON.stringify(sim.host.audit).includes('simulation-codex'));
});

test('revoked identity and missing authenticated principal are rejected without advancing state', async () => {
  const sim = await createSimulation(); const before = sim.context.state_version;
  await sim.providers.identity.revoke('simulation-codex');
  await assert.rejects(sim.call('discoverTask', 'codex'), raises('UNAUTHENTICATED'));
  sim.providers.identity.authenticate = async () => ({ task_ids: [sim.context.task_id] });
  await assert.rejects(sim.call('discoverTask', 'codex'), raises('INVALID_SCHEMA'));
  assert.equal(sim.context.state_version, before);
});

test('different Codex principal cannot execute the active plan', async () => {
  const sim = await createSimulation(); await prepareSimulation(sim);
  sim.providers.identity.authenticate = async () => ({ principal: { id: 'another-codex', role: 'codex' }, task_ids: [sim.context.task_id] });
  await assert.rejects(sim.call('executeTool', 'codex', { operation_id: 'op-1', attempt_id: 'other' }, { key: 'other' }), raises('AUTHORITY_BOUNDARY_EXCEEDED'));
  assert.equal(await sim.providers.tool.inspect('other'), null);
});

test('exact retry returns historical receipt, conflicting content rejects, new keys cannot repeat an operation', async () => {
  const sim = await createSimulation(); await prepareSimulation(sim);
  const request = sim.request('codex', { operation_id: 'op-1', attempt_id: 'attempt' }, { key: 'stable' });
  const first = sim.update(await sim.host.executeTool(request));
  await sim.call('submitReport', 'codex', simulationReport(sim, first.snapshot));
  const again = await sim.host.executeTool(request); assert.deepEqual(again, first);
  await assert.rejects(sim.host.executeTool({ ...request, payload: { ...request.payload, attempt_id: 'changed' } }), raises('IDEMPOTENCY_CONFLICT'));
  const stored = await sim.providers.state.read(sim.context.task_id); assert.equal(stored.data.operations.length, 1);
  assert.equal(stored.data.snapshot.state, 'VERIFYING');
});

test('concurrent requests do not dispatch duplicate tools or submit a report while a tool is pending', async () => {
  const sim = await createSimulation({ toolScripts: { 'op-1': { delay_ms: 5000 } } }); await prepareSimulation(sim);
  const request = sim.request('codex', { operation_id: 'op-1', attempt_id: 'pending' }, { key: 'pending' });
  const pending = sim.host.executeTool(request); const rejected = assert.rejects(pending, raises('INTERRUPTED'));
  await waitForRun(sim.providers.tool, 'pending');
  await assert.rejects(sim.host.executeTool(request), raises('OPERATION_IN_PROGRESS'));
  await assert.rejects(sim.call('submitReport', 'codex', simulationReport(sim, (await sim.call('inspectTask', 'human')).snapshot)), raises('OPERATION_IN_PROGRESS'));
  await sim.providers.tool.cancel('pending'); await rejected;
});

for (const [script, expected, outcome] of [
  [{ outcome: 'FAILED_CLEAN' }, 'FAILED_CLEAN', 'FAILED_CLEAN'],
  [{ outcome: 'EFFECT_UNKNOWN' }, 'EFFECT_UNKNOWN', 'EFFECT_UNKNOWN'],
  [{ outcome: 'INTERRUPTED' }, 'INTERRUPTED', 'INTERRUPTED'],
  [{ error: true }, 'TOOL_FAILED', 'EFFECT_UNKNOWN'],
]) test(`tool ${expected} is recorded and blocked without automatic retry`, async () => {
  const sim = await createSimulation({ toolScripts: { 'op-1': script } }); await prepareSimulation(sim);
  const request = sim.request('codex', { operation_id: 'op-1', attempt_id: 'failed' }, { key: 'failure' });
  await assert.rejects(sim.host.executeTool(request), raises(expected));
  const stored = await sim.providers.state.read(sim.context.task_id);
  assert.equal(stored.data.snapshot.state, 'BLOCKED'); assert.equal(stored.data.operations[0].outcome, outcome);
  assert.equal(AuditLog.verify(stored.data.protocol_audit), true);
  await assert.rejects(sim.host.executeTool(request), raises(expected));
  const observed = await sim.call('inspectTask', 'human'); assert.equal(observed.result.operations.length, 1);
  await sim.call('resumeTask', 'codex', { resolution: 'SIMULATION ONLY: checked Reality', discovery: { forged: true } });
  assert.equal(sim.context.state_version > request.context.state_version, true);
  const fresh = await sim.call('inspectTask', 'human'); assert.equal(fresh.snapshot.state, 'DISCOVERY'); assert.equal(fresh.snapshot.discovery.fingerprint, 'synthetic-fingerprint');
  await sim.call('planTask', 'codex', { summary: 'Same bounded plan', operations: [operationFixture()] }); await sim.call('beginTask', 'codex');
  await assert.rejects(sim.call('executeTool', 'codex', { operation_id: 'op-1', attempt_id: 'retry' }, { key: 'new-key' }), raises('OPERATION_ALREADY_ATTEMPTED'));
  assert.equal(await sim.providers.tool.inspect('retry'), null);
});

test('Human Stop interrupts a running tool, remains recorded, and cannot be resumed by Codex', async () => {
  const sim = await createSimulation({ toolScripts: { 'op-1': { delay_ms: 5000 } } }); await prepareSimulation(sim);
  const pending = sim.call('executeTool', 'codex', { operation_id: 'op-1', attempt_id: 'stopped' }, { key: 'stopped' });
  const interrupted = assert.rejects(pending, raises('EXECUTION_INTERRUPTED'));
  await waitForRun(sim.providers.tool, 'stopped');
  const stopped = await sim.call('stopTask', 'human', { reason: 'Explicit Human Stop' });
  assert.equal(stopped.snapshot.human_stopped, true); await interrupted;
  const observed = await sim.call('inspectTask', 'human'); assert.equal(observed.snapshot.state, 'BLOCKED'); assert.equal(observed.snapshot.human_stopped, true);
  await assert.rejects(sim.call('resumeTask', 'codex', { resolution: 'Resume without Human' }), raises('AUTHORITY_BOUNDARY_EXCEEDED'));
  const stored = await sim.providers.state.read(sim.context.task_id); assert.equal(stored.data.snapshot.human_stopped, true);
  await sim.call('resumeTask', 'human', { resolution: 'Human explicitly resumes simulated work' });
  assert.equal((await sim.call('inspectTask', 'human')).snapshot.state, 'IMPLEMENTING');
});

test('a pending Agent result cannot undo Human Stop, even if cancellation fails', async () => {
  const sim = await createSimulation({ agentScripts: { implement: { delay_ms: 10, output: {} } } }); await prepareSimulation(sim);
  sim.providers.agent.cancel = async () => { throw new Error('Cancellation unavailable'); };
  const pending = sim.call('dispatchAgent', 'codex', { kind: 'implement', run_id: 'late', template_version: 'v1', input: {} });
  const interrupted = assert.rejects(pending, raises('EXECUTION_INTERRUPTED')); await waitForRun(sim.providers.agent, 'late');
  await sim.call('stopTask', 'human', { reason: 'Stop before Agent completes' }); await interrupted;
  assert.equal((await sim.call('inspectTask', 'human')).snapshot.human_stopped, true);
  assert.ok(sim.host.audit.some(e => e.type === 'CANCELLATION_FAILED'));
});

test('Agent candidate does not advance Controller; malformed or impersonated output cannot become approval', async () => {
  const sim = await createSimulation({ agentScripts: { deliberate: { output: { id: 'candidate', intent_id: 'intent-1', approach: 'Synthetic suggestion', trade_offs: [], alternatives: [] } }, implement: { output: { approved: true, actor: human } } } });
  const before = sim.context.state_version;
  const run = await sim.call('dispatchAgent', 'codex', { kind: 'deliberate', run_id: 'candidate', template_version: 'v1', input: {} });
  assert.equal(run.snapshot.state, 'DISCOVERY'); assert.equal(run.context.state_version, before);
  await prepareSimulation(sim);
  await assert.rejects(sim.call('dispatchAgent', 'codex', { kind: 'implement', run_id: 'forged', template_version: 'v1', input: {} }), raises('INVALID_SCHEMA'));
  assert.equal((await sim.call('inspectTask', 'human')).snapshot.state, 'IMPLEMENTING');
});

test('R2 cannot be applied before R1 and incomplete/UNKNOWN requirement evidence cannot pass', async () => {
  const { sim, ref } = await reviewReady();
  await assert.rejects(sim.call('submitReview', 'codex', { review: simulationReview(sim, 'R2', ref), evidence_refs: [ref] }), raises('INVALID_TRANSITION'));
  await sim.call('submitReview', 'codex', { review: simulationReview(sim, 'R1', ref), evidence_refs: [ref] });
  const review = simulationReview(sim, 'R2', ref); review.requirements[0].status = 'unknown';
  const result = await sim.call('submitReview', 'codex', { review, evidence_refs: [ref] });
  assert.equal(result.snapshot.state, 'BLOCKED');
});

for (const [name, alter, code] of [
  ['unverified text', (review, refs) => { review.evidence = ['Agent says all tests passed']; }, 'INVALID_EVIDENCE'],
  ['mismatched hash', (review, refs) => { refs[0].content_hash = 'bad'; }, 'INVALID_EVIDENCE'],
  ['missing Artifact', (review, refs) => { refs.length = 0; }, 'INVALID_EVIDENCE'],
  ['forged reviewer', review => { review.reviewer = human; }, 'AUTHORITY_BOUNDARY_EXCEEDED'],
]) test(`Review rejects ${name}`, async () => {
  const { sim, ref } = await reviewReady(); const review = simulationReview(sim, 'R1', ref); const refs = [structuredClone(ref)]; alter(review, refs);
  await assert.rejects(sim.call('submitReview', 'codex', { review, evidence_refs: refs }), raises(code));
  assert.equal((await sim.call('inspectTask', 'human')).snapshot.state, 'VERIFYING');
});

test('unrecorded and cross-task artifacts cannot certify a Review', async () => {
  const { sim } = await reviewReady();
  for (const task_id of [sim.context.task_id, 'other']) {
    const ref = await sim.providers.evidence.put({ type: 'TEST_RUN', task_id, operation_id: 'invented', producer: 'Agent text', status: 'pass',
      repository_snapshot: {}, principal: codex, content: 'claims pass', simulation: true });
    await assert.rejects(sim.call('submitReview', 'codex', { review: simulationReview(sim, 'R1', ref), evidence_refs: [ref] }), raises(task_id === 'other' ? 'EVIDENCE_SCOPE_EXCEEDED' : 'INVALID_EVIDENCE'));
  }
});

test('conditional R3 and Human acceptance use existing Controller routing and preserve simulation labels', async () => {
  const { sim, ref } = await reviewReady({ requireR3: true, humanAcceptance: true });
  for (const level of ['R1', 'R2']) await sim.call('submitReview', 'codex', { review: simulationReview(sim, level, ref), evidence_refs: [ref] });
  const routed = await sim.call('routeReview', 'codex'); assert.equal(routed.snapshot.state, 'ARCHITECTURE_REVIEW');
  await assert.rejects(sim.call('submitReview', 'codex', { review: simulationReview(sim, 'R3', ref, { reviewer: codex }), evidence_refs: [ref] }), raises('AUTHORITY_BOUNDARY_EXCEEDED'));
  await sim.call('submitReview', 'chatgpt', { review: simulationReview(sim, 'R3', ref), evidence_refs: [ref] });
  assert.equal((await sim.call('inspectTask', 'human')).snapshot.state, 'HUMAN_ACCEPTANCE');
  await assert.rejects(sim.call('acceptTask', 'codex', { reason: 'self acceptance' }), raises('AUTHORITY_BOUNDARY_EXCEEDED'));
  assert.equal((await sim.call('acceptTask', 'human', { reason: 'SIMULATION ONLY' })).snapshot.state, 'DONE');
  assert.equal(sim.host.manifest.capabilities.independent_r3, false);
});

test('Discovery freshness and authority blocks are recorded through existing Adapter/Controller guards', async () => {
  let fingerprint = 'before'; const sim = await createSimulation({ discovery: async path => discoveryFixture(path, { fingerprint }) });
  await sim.call('discoverTask', 'codex');
  await sim.call('planTask', 'codex', { summary: 'Plan', operations: [operationFixture()] }); fingerprint = 'after';
  assert.equal((await sim.call('beginTask', 'codex')).snapshot.state, 'BLOCKED');
  await sim.call('resumeTask', 'codex', { resolution: 'New Reality observed' });
  const result = await sim.call('planTask', 'codex', { summary: 'Unauthorized architecture', operations: [operationFixture({ domain: 'architecture_change' })] });
  assert.equal(result.snapshot.state, 'BLOCKED'); assert.ok(result.snapshot.change_proposal);
  assert.equal((await sim.providers.state.read(sim.context.task_id)).data.snapshot.blocked.category, 'AUTHORITY_BOUNDARY_EXCEEDED');
  await assert.rejects(sim.call('resumeTask', 'human', { resolution: 'No new Decision' }), raises('NEW_AUTHORIZATION_REQUIRED'));
});

test('Store failure after a Controller mutation stops further writes without rolling back authority', async () => {
  const sim = await createSimulation();
  sim.providers.state.compareAndSwap = async () => { throw new Error('Injected store failure'); };
  await assert.rejects(sim.call('stopTask', 'human', { reason: 'Stop even if store fails' }), raises('RUNTIME_STATE_UNAVAILABLE'));
  const observed = await sim.call('inspectTask', 'human'); assert.equal(observed.snapshot.human_stopped, true); assert.equal(observed.result.storage_available, false);
  await assert.rejects(sim.call('resumeTask', 'human', { resolution: 'Cannot restore from snapshot' }), raises('RUNTIME_STATE_UNAVAILABLE'));
});

test('M1 refuses recovery and returns immutable views instead of Controller handles', async () => {
  const sim = await createSimulation();
  await assert.rejects(sim.call('recoverTask', 'human'), raises('UNSUPPORTED_CAPABILITY'));
  const view = await sim.call('inspectTask', 'human'); assert.equal(view.controller, undefined);
  assert.throws(() => { view.snapshot.state = 'DONE'; }, TypeError);
});

test('resuming Repository failure preserves the original Discovery scope', async () => {
  const scopes = [];
  const sim = await createSimulation({ toolScripts: { 'op-1': { outcome: 'EFFECT_UNKNOWN' } },
    discovery: async (path, options) => { scopes.push(options); return discoveryFixture(path); } });
  await sim.call('discoverTask', 'codex', { relatedPaths: ['src'] });
  await sim.call('planTask', 'codex', { summary: 'Scoped plan', operations: [operationFixture()] }); await sim.call('beginTask', 'codex');
  await assert.rejects(sim.call('executeTool', 'codex', { operation_id: 'op-1', attempt_id: 'unknown' }, { key: 'unknown' }), raises('EFFECT_UNKNOWN'));
  await sim.call('inspectTask', 'human'); await sim.call('resumeTask', 'codex', { resolution: 'Rediscover same scope' });
  assert.ok(scopes.length >= 3); assert.ok(scopes.every(options => JSON.stringify(options) === JSON.stringify({ relatedPaths: ['src'] })));
});

test('forged successful exit status is recorded as unknown and cannot produce passing evidence', async () => {
  const sim = await createSimulation(); await prepareSimulation(sim);
  sim.providers.tool.run = async () => ({ outcome: 'SUCCEEDED', stdout: 'claims pass', stderr: '', exit_code: 1, simulation: true });
  await assert.rejects(sim.call('executeTool', 'codex', { operation_id: 'op-1', attempt_id: 'invalid' }, { key: 'invalid' }), raises('INVALID_RUNTIME_CONTRACT'));
  const saved = await sim.providers.state.read(sim.context.task_id);
  assert.equal(saved.data.snapshot.state, 'BLOCKED'); assert.equal(saved.data.operations[0].outcome, 'EFFECT_UNKNOWN');
});

test('revocation is checked even when replaying a successful idempotent request', async () => {
  const sim = await createSimulation(); await prepareSimulation(sim);
  const request = sim.request('codex', { operation_id: 'op-1', attempt_id: 'once' }, { key: 'once' });
  await sim.host.executeTool(request); await sim.providers.identity.revoke('simulation-codex');
  await assert.rejects(sim.host.executeTool(request), raises('UNAUTHENTICATED'));
});

test('task storage failure still permits Human to stop the live Controller', async () => {
  const sim = await createSimulation();
  sim.providers.state.compareAndSwap = async () => { throw new Error('Failure before Human Stop'); };
  await assert.rejects(sim.call('discoverTask', 'codex'), raises('RUNTIME_STATE_UNAVAILABLE'));
  await sim.call('inspectTask', 'human');
  await assert.rejects(sim.call('stopTask', 'human', { reason: 'Human retains Stop authority' }), raises('RUNTIME_STATE_UNAVAILABLE'));
  assert.equal((await sim.call('inspectTask', 'human')).snapshot.human_stopped, true);
});

test('fake review runs return candidates for the matching role and cannot reuse a prior run for R3', async () => {
  const { sim, ref } = await reviewReady({ requireR3: true });
  const review = simulationReview(sim, 'R1', ref);
  // Replace a method on the trusted test provider; messages cannot supply callbacks.
  const fake = new FakeAgentProvider({ scripts: { review: { output: review } } });
  sim.providers.agent.review = fake.review.bind(fake);
  const candidate = await sim.call('dispatchAgent', 'codex', { kind: 'review', review_level: 'R1', run_id: 'review-run', template_version: 'v1', input: {} });
  assert.equal(candidate.snapshot.state, 'VERIFYING'); assert.equal(candidate.result.output.review_level, 'R1');
  await sim.call('submitReview', 'codex', { review: candidate.result.output, evidence_refs: [ref] });
  await sim.call('submitReview', 'codex', { review: simulationReview(sim, 'R2', ref), evidence_refs: [ref] }); await sim.call('routeReview', 'codex');
  await assert.rejects(sim.call('dispatchAgent', 'chatgpt', { kind: 'review', review_level: 'R3', run_id: 'review-run', template_version: 'v1', input: {} }), raises('RUN_ALREADY_EXISTS'));
  await assert.rejects(sim.call('dispatchAgent', 'codex', { kind: 'review', review_level: 'R3', run_id: 'new-run', template_version: 'v1', input: {} }), raises('AUTHORITY_BOUNDARY_EXCEEDED'));
});

test('evidence from an earlier Revision cannot certify a new implementation cycle', async () => {
  const { sim, ref } = await reviewReady();
  await sim.call('submitReview', 'codex', { review: simulationReview(sim, 'R1', ref, { decision: 'REVISION_RECOMMENDED', implementation_status: 'fail' }), evidence_refs: [ref] });
  await sim.call('discoverTask', 'codex'); await sim.call('beginTask', 'codex', { progress: 'New simulated diagnosis for Revision' });
  const observed = await sim.call('inspectTask', 'human');
  await sim.call('submitReport', 'codex', simulationReport(sim, observed.snapshot, { id: 'revised-report' }));
  await assert.rejects(sim.call('submitReview', 'codex', { review: simulationReview(sim, 'R1', ref, { id: 'revised-review', report_id: 'revised-report' }), evidence_refs: [ref] }), raises('INVALID_EVIDENCE'));
});

test('an AI cannot create a task by supplying a serialized Human approval', async () => {
  const sim = await createSimulation(); const saved = await sim.providers.state.read(sim.context.task_id);
  const { intent, decision, specification, delegation, profile } = saved.data.approval;
  await assert.rejects(sim.host.startTask(sim.request('codex', { intent, decision, specification, delegation, profile })), raises('AUTHORITY_BOUNDARY_EXCEEDED'));
  assert.equal(saved.data.snapshot.state, 'DISCOVERY');
});
