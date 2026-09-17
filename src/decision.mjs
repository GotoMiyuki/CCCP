import { assert, check, immutable, REQUIREMENT_GROUPS } from './contracts.mjs';
import { requireRole, approveProfile, relativePath } from './authority.mjs';
import { AuditLog } from './audit.mjs';

export function requirements(specification) {
  return [specification.objective, ...REQUIREMENT_GROUPS.flatMap(k => specification[k])];
}

export class DecisionLifecycle {
  #state = 'INTENT'; #intent; #proposal; #decision; #specification; #delegation; #profile; #approval;
  #blockedFrom; #audit;
  constructor({ intent, profile, actor, audit = new AuditLog() }) {
    requireRole(actor, 'human'); check('Intent', intent);
    this.#audit = audit; this.#intent = immutable(intent);
    this.#profile = approveProfile(actor, profile, audit);
    this.#audit.append('INTENT_CONFIRMED', actor, intent);
  }
  static directed({ intent, decision, specification, delegation, profile, actor, audit }) {
    requireRole(actor, 'human'); check('Decision', decision);
    assert(decision.intent_id === intent.id, 'REFERENCE_MISMATCH', 'Directed Decision must refer to current Intent');
    const flow = new DecisionLifecycle({ intent, profile, actor, audit });
    flow.#decision = immutable(decision);
    flow.#approval = immutable({ actor, timestamp: new Date().toISOString(), decision_id: decision.id });
    flow.#move('APPROVED', actor, { decision, approval: flow.#approval, mode: 'Directed', note: 'Human supplies the already chosen design; no AI deliberation is fabricated' });
    flow.specify(actor, specification); flow.delegate(actor, delegation); return flow;
  }
  get state() { return this.#state; }
  get snapshot() { return immutable({ state: this.#state, intent: this.#intent, proposal: this.#proposal ?? null, decision: this.#decision ?? null,
    specification: this.#specification ?? null, delegation: this.#delegation ?? null, profile: this.#profile, approval: this.#approval ?? null }); }
  get audit() { return this.#audit.entries; }
  #at(...states) { assert(states.includes(this.#state), 'INVALID_TRANSITION', `Decision is ${this.#state}; expected ${states.join(' / ')}`); }
  #move(state, actor, data) { this.#audit.append('DECISION_TRANSITION', actor, { from: this.#state, to: state, ...data }); this.#state = state; }
  propose(actor, proposal) {
    requireRole(actor, 'human', 'chatgpt', 'codex'); this.#at('INTENT', 'PROPOSAL', 'DELIBERATION'); check('Proposal', proposal);
    assert(proposal.intent_id === this.#intent.id, 'REFERENCE_MISMATCH', 'Proposal must refer to current Intent');
    this.#proposal = immutable(proposal); this.#move('PROPOSAL', actor, { proposal });
  }
  deliberate(actor, note) {
    requireRole(actor, 'human', 'chatgpt', 'codex'); this.#at('PROPOSAL', 'DELIBERATION');
    assert(typeof note === 'string' && note.trim(), 'MISSING_INFORMATION', 'Deliberation must add information');
    this.#move('DELIBERATION', actor, { note });
  }
  requestDecision(actor) {
    requireRole(actor, 'human', 'chatgpt', 'codex'); this.#at('DELIBERATION'); this.#move('DECISION_PENDING', actor, { proposal_id: this.#proposal.id });
  }
  approve(actor, decision) {
    requireRole(actor, 'human'); this.#at('DECISION_PENDING'); check('Decision', decision);
    assert(decision.intent_id === this.#intent.id && decision.proposal_id === this.#proposal.id, 'REFERENCE_MISMATCH', 'Decision must refer to current Intent and Proposal');
    this.#decision = immutable(decision); this.#approval = immutable({ actor, timestamp: new Date().toISOString(), decision_id: decision.id });
    this.#move('APPROVED', actor, { decision, approval: this.#approval });
  }
  reject(actor, reason) {
    requireRole(actor, 'human'); this.#at('DECISION_PENDING');
    assert(typeof reason === 'string' && reason.trim(), 'MISSING_INFORMATION', 'Rejection requires a reason');
    this.#move('REJECTED', actor, { reason });
  }
  specify(actor, specification) {
    requireRole(actor, 'human', 'chatgpt', 'codex'); this.#at('APPROVED'); check('Specification', specification);
    assert(specification.decision_id === this.#decision.id, 'REFERENCE_MISMATCH', 'Specification must refer to approved Decision');
    const clauses = requirements(specification);
    assert(new Set(clauses.map(c => c.id)).size === clauses.length, 'INVALID_SPECIFICATION', 'Requirement IDs must be unique across all groups');
    // Mechanical traceability guard. Semantic equivalence still needs R2/R3 assessment.
    for (const [group, original] of [['constraints', this.#decision.constraints], ['non_goals', this.#decision.non_goals]]) {
      assert(original.every(text => specification[group].some(c => c.text === text)), 'SPECIFICATION_CONFLICT', `Specification must retain Decision ${group}`);
    }
    this.#specification = immutable(specification); this.#move('SPECIFIED', actor, { specification });
  }
  delegate(actor, delegation) {
    requireRole(actor, 'human'); this.#at('SPECIFIED'); check('Delegation', delegation);
    assert(delegation.decision_id === this.#decision.id, 'REFERENCE_MISMATCH', 'Delegation must refer to approved Decision');
    delegation.paths.forEach(relativePath);
    this.#delegation = immutable(delegation); this.#move('DELEGATED', actor, { delegation });
  }
  block(actor, reason) {
    requireRole(actor, 'human', 'chatgpt', 'codex');
    assert(typeof reason === 'string' && reason.trim(), 'MISSING_INFORMATION', 'Block requires a reason');
    if (this.#state !== 'BLOCKED') this.#blockedFrom = this.#state;
    this.#move('BLOCKED', actor, { reason });
  }
  resume(actor, resolution) {
    requireRole(actor, 'human'); this.#at('BLOCKED');
    assert(typeof resolution === 'string' && resolution.trim(), 'MISSING_INFORMATION', 'Resolution is required');
    this.#move(this.#blockedFrom, actor, { resolution });
  }
}
