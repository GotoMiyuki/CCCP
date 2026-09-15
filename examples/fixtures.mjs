import { defaultProfile, DecisionLifecycle, requirements } from '../src/index.mjs';

export const human = { id: 'local-human', role: 'human' };
export const codex = { id: 'local-codex', role: 'codex' };
export const chatgpt = { id: 'independent-chatgpt', role: 'chatgpt' };

// These are explicitly synthetic inputs for the demo, not real Human approvals.
export function approvalFixture({ repository = process.cwd(), suffix = '1', profile = defaultProfile(repository), delegationPatch = {} } = {}) {
  const intent = { id: `intent-${suffix}`, objective: 'Implement a bounded internal change' };
  const proposal = { id: `proposal-${suffix}`, intent_id: intent.id, approach: 'Use the approved internal implementation', trade_offs: [], alternatives: [] };
  const decision = { id: `decision-${suffix}`, intent_id: intent.id, proposal_id: proposal.id, goal: intent.objective, selected_approach: proposal.approach,
    constraints: ['Preserve public behavior'], non_goals: ['No remote push'], important_trade_offs: [], rejected_alternatives: [] };
  const spec = { id: `spec-${suffix}`, decision_id: decision.id, objective: { id: 'OBJ-1', text: intent.objective },
    scope: [{ id: 'S-1', text: 'Internal files only' }], constraints: [{ id: 'C-1', text: decision.constraints[0] }],
    non_goals: [{ id: 'NG-1', text: decision.non_goals[0] }], acceptance_criteria: [{ id: 'AC-1', text: 'Expected internal result' }],
    invariants: [{ id: 'INV-1', text: 'Human retains authority' }], expected_behavior: [{ id: 'EB-1', text: 'Preserve public behavior' }], verification_criteria: [{ id: 'V-1', text: 'Tests pass' }] };
  const delegation = { id: `delegation-${suffix}`, decision_id: decision.id, allowed: ['internal_implementation', 'test_implementation'], forbidden: [], paths: ['src', 'tests'], ...delegationPatch };
  const flow = new DecisionLifecycle({ intent, profile, actor: human });
  flow.propose(codex, proposal); flow.deliberate(chatgpt, 'Synthetic example of deliberation'); flow.requestDecision(codex);
  flow.approve(human, decision); flow.specify(codex, spec); flow.delegate(human, delegation);
  return flow;
}

export function operationFixture(patch = {}) {
  return { id: 'op-1', domain: 'internal_implementation', paths: ['src'], changes_decision: false, description: 'Implement approved internal logic', ...patch };
}
export function discoveryFixture(repository = process.cwd(), patch = {}) {
  return { repository: { path: repository, branch: null, commit: null }, base_commit: null, working_tree_status: 'not_git', changed_files: [], related_files: ['src/example.mjs'],
    architecture_observations: ['Synthetic test fixture'], reusable_implementations: [], test_status: 'unknown', test_evidence: [], context_conflicts: [], observed_at: new Date().toISOString(), fingerprint: 'synthetic-fingerprint', ...patch };
}
let serial = 0;
export function reportFixture(controller, patch = {}) {
  return { id: `report-${++serial}`, specification_id: controller.specification.id, discovery_fingerprint: controller.snapshot.discovery.fingerprint,
    summary: 'Synthetic implementation report', changed_files: ['src/example.mjs'], evidence: ['Synthetic test evidence'], unexpected_deviations: [], risk: 'low', triggers: [], ...patch };
}
export function reviewFixture(controller, level, patch = {}) {
  return { id: `review-${++serial}`, report_id: controller.snapshot.report.id, review_level: level, reviewer: level === 'R3' ? chatgpt : codex,
    decision: 'APPROVE', confidence: 0.9, findings: [], evidence: ['Synthetic review evidence'], failed_requirements: [],
    requirements: level === 'R2' ? requirements(controller.specification).map(c => ({ requirement_id: c.id, status: 'pass', evidence: [`Synthetic evidence for ${c.id}`] })) : [],
    implementation_status: 'pass', specification_compliance: 'pass', architecture_compliance: 'pass', boundary_violation: false, reason: 'Synthetic approval for demo / tests only', ...patch };
}
