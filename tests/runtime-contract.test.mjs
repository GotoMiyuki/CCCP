import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { MemoryIdentityProvider, MemoryStateStore, MemoryEvidenceStore, FakeAgentProvider, FakeToolRunner, MemoryWorkspaceManager,
  IdentityProvider, AgentProvider, StateStore, EvidenceStore, ToolRunner, WorkspaceManager,
  capabilityManifest, jsonCopy, EXECUTION_OUTCOMES, EXECUTION_STATES, HostRuntime } from '../src/index.mjs';
import { createSimulation } from '../examples/runtime-workflow.mjs';
import { human, codex, discoveryFixture, operationFixture } from '../examples/fixtures.mjs';

const raises = code => error => error.code === code;
const context = { task_id: 'task', principal: codex, state_version: 0, delegation_ref: 'delegation', workspace_ref: 'workspace', correlation_id: 'correlation' };
const agentRequest = (run_id = 'run') => ({ run_id, context, template_version: 'v1', input: {}, context_snapshot: {}, repository_snapshot: {},
  allowed_tools: [], delegation: {}, input_schema: 'RuntimeAgentInput', output_schema: 'Proposal', simulation: true });
const toolRequest = (attempt_id = 'attempt') => ({ attempt_id, context, operation: operationFixture(), repository_snapshot: discoveryFixture(), policy: {}, simulation: true });
const artifact = (patch = {}) => ({ type: 'COMMAND_RUN', task_id: 'task', operation_id: 'attempt', producer: 'fixture', status: 'pass',
  repository_snapshot: {}, principal: codex, content: 'SIMULATION ONLY', simulation: true, ...patch });

// Factory-based tests intentionally use public SPI methods, not implementation fields.
export function stateStoreContract(name, factory) {
  describe(name, () => {
    test('CAS accepts at most one writer for the same revision without interpreting lifecycle', async () => {
      const store = factory(); await store.create('task', { snapshot: { state_version: 2 } });
      const outcomes = await Promise.allSettled([store.compareAndSwap('task', 0, { snapshot: { state_version: 2 } }), store.compareAndSwap('task', 0, { snapshot: { state_version: 2 } })]);
      assert.equal(outcomes.filter(v => v.status === 'fulfilled').length, 1);
      assert.equal(outcomes.find(v => v.status === 'rejected').reason.code, 'STORE_CONFLICT');
      const saved = await store.read('task'); assert.equal(saved.store_revision, 1); assert.equal(saved.data.snapshot.state_version, 2);
    });
    test('create/read isolate input mutations and reject duplicate creation', async () => {
      const store = factory(); const input = { nested: { value: 1 } }; await store.create('task', input); input.nested.value = 9;
      const saved = await store.read('task'); assert.equal(saved.data.nested.value, 1);
      assert.throws(() => { saved.data.nested.value = 8; }, TypeError);
      await assert.rejects(store.create('task', {}), raises('TASK_EXISTS')); assert.equal(await store.read('missing'), null);
    });
    test('atomic claims, conflict detection and immutable settlement', async () => {
      const store = factory(); const claims = await Promise.all([store.claim('key', 'hash'), store.claim('key', 'hash')]);
      assert.equal(claims.filter(v => v.claimed).length, 1);
      await assert.rejects(store.claim('key', 'other'), raises('IDEMPOTENCY_CONFLICT'));
      const result = { ok: false, code: 'EFFECT_UNKNOWN' }; await store.settle('key', result); result.code = 'changed';
      assert.equal((await store.claim('key', 'hash')).result.code, 'EFFECT_UNKNOWN');
      await assert.rejects(store.settle('key', {}), raises('INVALID_IDEMPOTENCY_STATE'));
    });
  });
}
stateStoreContract('MemoryStateStore contract', () => new MemoryStateStore());

export function identityContract(name, factory) {
  describe(name, () => {
    test('grants originate in host configuration, and expire/revoke', async () => {
      let now = 100;
      const sessions = [{ credential: 'private-credential', principal: human, task_ids: ['task'], expires_at: 200 }];
      const provider = factory({ sessions, clock: () => now }); sessions[0].task_ids.push('other');
      assert.deepEqual(await provider.authenticate('private-credential'), { principal: human, task_ids: ['task'] });
      await assert.rejects(provider.authenticate('role:human'), raises('UNAUTHENTICATED'));
      now = 200; await assert.rejects(provider.authenticate('private-credential'), raises('UNAUTHENTICATED'));
      now = 100; assert.equal(await provider.revoke('private-credential'), true);
      await assert.rejects(provider.authenticate('private-credential'), raises('UNAUTHENTICATED'));
    });
  });
}
identityContract('MemoryIdentityProvider contract', options => new MemoryIdentityProvider(options));

export function evidenceContract(name, factory) {
  describe(name, () => {
    test('hashes content and rejects changed hash, reference and cross-task/operation reuse', async () => {
      const store = factory(); const input = artifact(); const ref = await store.put(input); input.content = 'changed';
      const verified = await store.verify(ref, { task_id: 'task', operation_id: 'attempt' }); assert.equal(verified.content, 'SIMULATION ONLY');
      assert.equal(ref.content_hash, createHash('sha256').update('SIMULATION ONLY').digest('hex'));
      await assert.rejects(store.verify({ ...ref, content_hash: '0'.repeat(64) }, { task_id: 'task' }), raises('INVALID_EVIDENCE'));
      await assert.rejects(store.verify({ ...ref, artifact_ref: 'text' }, { task_id: 'task' }), raises('INVALID_EVIDENCE'));
      await assert.rejects(store.verify(ref, { task_id: 'other' }), raises('EVIDENCE_SCOPE_EXCEEDED'));
      await assert.rejects(store.verify(ref, { task_id: 'task', operation_id: 'other' }), raises('EVIDENCE_SCOPE_EXCEEDED'));
      assert.throws(() => { verified.status = 'pass'; }, TypeError);
    });
    test('UNKNOWN remains UNKNOWN; content hash is not a truth judgment', async () => {
      const store = factory(); const ref = await store.put(artifact({ status: 'unknown', content: 'Agent says PASS' }));
      assert.equal((await store.verify(ref, { task_id: 'task' })).status, 'unknown');
      await assert.rejects(store.put(artifact({ simulation: false })), raises('INVALID_RUNTIME_CONTRACT'));
    });
  });
}
evidenceContract('MemoryEvidenceStore contract', () => new MemoryEvidenceStore());

export function agentContract(name, factory) {
  describe(name, () => {
    test('records all three kinds and never runs request-supplied code', async () => {
      const provider = factory({ scripts: { deliberate: { output: { candidate: true } }, implement: { output: { report: true } }, review: { output: { judgment: true } } } });
      for (const kind of ['deliberate', 'implement', 'review']) {
        const request = agentRequest(kind); const result = await provider[kind](request);
        assert.equal(result.kind, kind); assert.equal(result.status, 'COMPLETED'); assert.equal(result.role, 'codex');
        assert.equal(result.provider, 'fake'); assert.equal(result.model, 'scripted'); assert.equal(result.template_version, 'v1');
        assert.equal(result.usage.tokens, 0); assert.equal(result.simulation, true);
        assert.deepEqual(await provider.inspect(kind), result);
        await assert.rejects(provider[kind](request), raises('RUN_ALREADY_EXISTS'));
      }
      await assert.rejects(provider.implement({ ...agentRequest('code'), input: () => 'execute' }), raises('INVALID_RUNTIME_CONTRACT'));
    });
    test('cancellation settles a pending run without claiming production cancellation', async () => {
      const provider = factory({ scripts: { implement: { delay_ms: 5000, output: {} } } });
      const pending = provider.implement(agentRequest()); assert.equal(await provider.cancel('run'), true);
      const result = await pending; assert.equal(result.status, 'INTERRUPTED'); assert.equal(result.output, null);
      assert.equal(await provider.cancel('run'), false); assert.equal((await provider.capabilities()).simulation, true);
    });
  });
}
agentContract('FakeAgentProvider contract', options => new FakeAgentProvider(options));

export function toolContract(name, factory) {
  describe(name, () => {
    for (const outcome of EXECUTION_OUTCOMES) test(`preserves Runtime outcome ${outcome}`, async () => {
      const provider = factory({ scripts: { 'op-1': { outcome, stdout: 'simulated' } } });
      const result = await provider.run(toolRequest()); assert.equal(result.outcome, outcome); assert.equal(result.simulation, true);
      assert.equal((await provider.inspect('attempt')).result.outcome, outcome);
      await assert.rejects(provider.run(toolRequest()), raises('ATTEMPT_ALREADY_EXISTS'));
    });
    test('cancelled fake tool returns INTERRUPTED; thrown failure remains EFFECT_UNKNOWN', async () => {
      const provider = factory({ scripts: { 'op-1': { delay_ms: 5000 } } }); const pending = provider.run(toolRequest());
      assert.equal(await provider.cancel('attempt'), true); assert.equal((await pending).outcome, 'INTERRUPTED');
      const failing = factory({ scripts: { 'op-1': { error: true } } });
      await assert.rejects(failing.run(toolRequest()), raises('TOOL_FAILED'));
      assert.equal((await failing.inspect('attempt')).result.outcome, 'EFFECT_UNKNOWN');
    });
  });
}
toolContract('FakeToolRunner contract', options => new FakeToolRunner(options));

export function workspaceContract(name, factory) {
  describe(name, () => {
    test('binds registered directories and enforces single-writer leases and expiry', async () => {
      let now = 0; const provider = factory({ workspaces: [{ workspace_ref: 'workspace', repository: process.cwd() }], clock: () => now, leaseMs: 100 });
      const workspace = await provider.createWorkspace('task', 'workspace', null);
      await assert.rejects(provider.createWorkspace('other', 'workspace'), raises('WORKSPACE_IN_USE'));
      const lease = await provider.acquireLease(workspace.repository_identity, 'task', 'write');
      await assert.rejects(provider.acquireLease(workspace.repository_identity, 'other', 'write'), raises('LEASE_CONFLICT'));
      await assert.rejects(provider.disposeWorkspace('workspace'), raises('WORKSPACE_IN_USE'));
      now = 100; await assert.rejects(provider.renewLease(lease.lease_id), raises('LEASE_EXPIRED'));
      const next = await provider.acquireLease(workspace.repository_identity, 'other', 'write');
      assert.equal(await provider.releaseLease(lease.lease_id), false); assert.equal(await provider.releaseLease(next.lease_id), true);
      await provider.disposeWorkspace('workspace'); assert.equal((await provider.inspectWorkspace('workspace')).task_id, null);
    });
  });
}
workspaceContract('MemoryWorkspaceManager contract', options => new MemoryWorkspaceManager(options));

test('unimplemented SPI methods reject rather than silently succeeding', async () => {
  for (const Provider of [IdentityProvider, AgentProvider, StateStore, EvidenceStore, ToolRunner, WorkspaceManager]) {
    await assert.rejects(new Provider().capabilities(), raises('UNSUPPORTED_CAPABILITY'));
  }
});
test('manifest rejects missing ports, exaggerated capabilities and unavailable required capabilities', async () => {
  const sim = await createSimulation(); const providers = sim.providers;
  await assert.rejects(capabilityManifest({ ...providers, tool: {} }), raises('INVALID_PROVIDER'));
  await assert.rejects(capabilityManifest(providers, ['crash_recovery']), raises('UNSUPPORTED_CAPABILITY'));
  await assert.rejects(capabilityManifest(providers, ['future_magic']), raises('UNSUPPORTED_CAPABILITY'));
  await assert.rejects(capabilityManifest({ ...providers, tool: { run() {}, cancel() {}, inspect() {}, capabilities: async () => ({ simulation: false }) } }), raises('UNSUPPORTED_CAPABILITY'));
  await assert.rejects(HostRuntime.create({ providers }), raises('STORE_ALREADY_OWNED'));
  assert.equal(sim.host.manifest.capabilities.independent_r3, false);
  assert.throws(() => { sim.host.manifest.capabilities.durable_state = true; }, TypeError);
});
test('Runtime JSON validation rejects functions, sparse arrays and non-JSON values', () => {
  for (const value of [() => {}, [,,], { bad: undefined }, new Date(), NaN, { big: 1n }]) assert.throws(() => jsonCopy(value), raises('INVALID_RUNTIME_CONTRACT'));
});
test('Protocol lifecycle and frozen files retain the M0 baseline', async () => {
  assert.ok(EXECUTION_OUTCOMES.every(outcome => !EXECUTION_STATES.includes(outcome)));
  const baseline = await readFile(new URL('../docs/development_logs/2026-09-17-host-runtime-m0.md', import.meta.url), 'utf8');
  const lines = baseline.split(/\r?\n/).filter(line => / [a-f0-9]{64}$/.test(line)); assert.equal(lines.length, 10);
  for (const line of lines) {
    const [, path, hash] = /^(.*) ([a-f0-9]{64})$/.exec(line);
    assert.equal(createHash('sha256').update(await readFile(new URL(`../${path}`, import.meta.url))).digest('hex'), hash, path);
  }
});
