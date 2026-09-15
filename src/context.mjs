import { check, assert, immutable } from './contracts.mjs';
import { requireRole } from './authority.mjs';
import { DecisionLifecycle } from './decision.mjs';
import { AuditLog } from './audit.mjs';

export class ContextStore {
  #entries = new Map(); #audit;
  constructor(audit = new AuditLog()) { this.#audit = audit; }
  put(actor, entry, { decision } = {}) {
    requireRole(actor, 'human', 'codex', 'chatgpt'); check('ContextEntry', entry);
    assert(actor.id === entry.generated_by.id && actor.role === entry.generated_by.role, 'AUTHORITY_BOUNDARY_EXCEEDED', 'Context provenance must match authenticated author');
    const previous = this.#entries.get(entry.id);
    assert(!previous || previous.kind === entry.kind, 'CONTEXT_AUTHORITY_CONFLICT', 'Context kind is immutable; an inference cannot be relabeled as a Decision');
    if (entry.kind === 'HUMAN_DECISION') {
      assert(decision instanceof DecisionLifecycle && ['APPROVED', 'SPECIFIED', 'DELEGATED'].includes(decision.state), 'DECISION_NOT_READY', 'Human Decision context requires an approved Decision record');
      assert(entry.decision_id === decision.snapshot.decision.id, 'REFERENCE_MISMATCH', 'Context must reference approved Decision');
      assert(entry.content === JSON.stringify(decision.snapshot.decision), 'CONTEXT_AUTHORITY_CONFLICT', 'Human Decision context stores the exact approved record, not an AI paraphrase');
    } else assert(!entry.decision_id, 'CONTEXT_AUTHORITY_CONFLICT', 'Only Human Decision records carry a decision_id');
    this.#entries.set(entry.id, immutable(entry)); this.#audit.append('CONTEXT_UPDATED', actor, entry);
  }
  get entries() { return immutable([...this.#entries.values()]); }
  freshness(commit) {
    return this.entries.map(entry => ({ id: entry.id, needs_discovery: entry.status !== 'historical' && (entry.status === 'stale' || commit === null || entry.source_commit === null || entry.source_commit !== commit) }));
  }
}
