import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostRuntime, MemoryIdentityProvider, FakeAgentProvider, MemoryStateStore, MemoryEvidenceStore,
  FakeToolRunner, MemoryWorkspaceManager, AuditLog, defaultProfile, requirements } from '../src/index.mjs';
import { approvalFixture, discoveryFixture, operationFixture, human, codex, chatgpt } from './fixtures.mjs';

export async function createSimulation({ repository = process.cwd(), taskId = 'runtime-demo', toolScripts = {}, agentScripts = {},
  requireR3 = false, humanAcceptance = false, discovery = async path => discoveryFixture(path) } = {}) {
  const profile = defaultProfile(repository);
  profile.review.require_r3 = requireR3; profile.review.human_acceptance = humanAcceptance;
  const { intent, decision, specification, delegation } = approvalFixture({ repository, profile }).snapshot;
  const providers = {
    identity: new MemoryIdentityProvider({ sessions: [human, codex, chatgpt].map(principal => ({ credential: `simulation-${principal.role}`,
      principal, task_ids: [taskId], expires_at: Date.now() + 3600000 })) }),
    agent: new FakeAgentProvider({ scripts: agentScripts }), state: new MemoryStateStore(), evidence: new MemoryEvidenceStore(),
    tool: new FakeToolRunner({ scripts: { 'op-1': { stdout: 'SIMULATION ONLY: scripted verification', outcome: 'SUCCEEDED' }, ...toolScripts } }),
    workspace: new MemoryWorkspaceManager({ workspaces: [{ workspace_ref: 'demo-workspace', repository }] }),
  };
  const host = await HostRuntime.create({ providers, discovery });
  const context = { task_id: taskId, state_version: 0, delegation_ref: delegation.id, workspace_ref: 'demo-workspace', correlation_id: 'simulation-create' };
  let serial = 0;
  const request = (role, payload = {}, options = {}) => ({ credential: `simulation-${role}`, context: { ...context, correlation_id: `simulation-${++serial}`, ...options.context }, payload,
    ...(options.key ? { idempotency_key: options.key } : {}) });
  const update = response => { context.state_version = response.context.state_version; return response; };
  const call = async (method, role, payload = {}, options = {}) => update(await host[method](request(role, payload, options)));
  await call('startTask', 'human', { intent, decision, specification, delegation, profile });
  return { host, providers, context, request, call, update, specification };
}

export function simulationReport(sim, snapshot, patch = {}) {
  return { id: 'runtime-report', specification_id: sim.specification.id, discovery_fingerprint: snapshot.discovery.fingerprint,
    summary: 'SIMULATION ONLY: fake tool result', changed_files: [], evidence: ['SIMULATION ONLY'], unexpected_deviations: [], risk: 'low', triggers: [], ...patch };
}
export function simulationReview(sim, level, evidenceRef, patch = {}) {
  return { id: `runtime-review-${level}`, report_id: 'runtime-report', review_level: level, reviewer: level === 'R3' ? chatgpt : codex,
    decision: 'APPROVE', confidence: 0.9, findings: [], evidence: [evidenceRef.artifact_ref], failed_requirements: [],
    requirements: level === 'R2' ? requirements(sim.specification).map(c => ({ requirement_id: c.id, status: 'pass', evidence: [evidenceRef.artifact_ref] })) : [],
    implementation_status: 'pass', specification_compliance: 'pass', architecture_compliance: 'pass', boundary_violation: false,
    reason: 'SIMULATION ONLY: not independent real review', ...patch };
}
export async function prepareSimulation(sim) {
  await sim.call('discoverTask', 'codex');
  await sim.call('planTask', 'codex', { summary: 'Simulated internal implementation', operations: [operationFixture()] });
  return sim.call('beginTask', 'codex');
}
export async function runSimulation() {
  const candidateReport = simulationReport({ specification: { id: 'spec-1' } }, { discovery: { fingerprint: 'synthetic-fingerprint' } });
  const sim = await createSimulation({ agentScripts: { implement: { output: candidateReport }, deliberate: { output: {
    id: 'simulated-candidate', intent_id: 'intent-1', approach: 'SIMULATION ONLY: bounded implementation suggestion', trade_offs: [], alternatives: [],
  } } } });
  await sim.call('dispatchAgent', 'codex', { kind: 'deliberate', run_id: 'demo-agent-run', template_version: 'simulation-v1', input: {} });
  await prepareSimulation(sim);
  const toolRequest = sim.request('codex', { operation_id: 'op-1', attempt_id: 'demo-attempt' }, { key: 'demo-tool' });
  const executed = sim.update(await sim.host.executeTool(toolRequest));
  await sim.host.executeTool(toolRequest); // Exact replay returns the original receipt, without another execution.
  const evidence_ref = executed.result.evidence_ref;
  const implemented = await sim.call('dispatchAgent', 'codex', { kind: 'implement', run_id: 'demo-implement-run', template_version: 'simulation-v1', input: { evidence_ref } });
  await sim.call('submitReport', 'codex', implemented.result.output);
  for (const level of ['R1', 'R2']) await sim.call('submitReview', 'codex', { review: simulationReview(sim, level, evidence_ref), evidence_refs: [evidence_ref] });
  await sim.call('routeReview', 'codex');
  const observed = await sim.call('inspectTask', 'human');
  return { notice: 'SIMULATION ONLY: synthetic Human approval, fake Agent/tools and evidence; no real independent R3',
    state: observed.snapshot.state, audit_valid: AuditLog.verify(observed.result.protocol_audit) && AuditLog.verify(sim.host.audit),
    operations: observed.result.operations.length, agent_runs: observed.result.agent_runs.length, manifest: sim.host.manifest };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await runSimulation(), null, 2));
