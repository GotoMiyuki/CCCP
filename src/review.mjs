import { assert, check, immutable } from './contracts.mjs';
import { requireRole } from './authority.mjs';
import { requirements } from './decision.mjs';

// Assessment-only functions: neither function receives a controller or executor.
export function validateReview(actor, review, report, specification, implementerId) {
  check('ReviewResult', review);
  requireRole(actor, ...(review.review_level === 'R3' ? ['chatgpt', 'human'] : ['codex', 'human']));
  assert(review.reviewer.id === actor.id && review.reviewer.role === actor.role, 'AUTHORITY_BOUNDARY_EXCEEDED', 'Review identity must match authenticated actor');
  assert(review.report_id === report.id, 'STALE_REVIEW', 'Review must target current implementation report');
  if (review.review_level === 'R3') assert(actor.id !== implementerId, 'INDEPENDENCE_REQUIRED', 'R3 must be independent of the implementer');
  const ids = review.requirements.map(r => r.requirement_id);
  assert(new Set(ids).size === ids.length, 'INVALID_REVIEW', 'Duplicate requirement evidence');
  const expected = requirements(specification).map(c => c.id);
  assert(ids.every(id => expected.includes(id)), 'INVALID_REVIEW', 'Unknown requirement ID');
  assert(review.failed_requirements.every(id => expected.includes(id)), 'INVALID_REVIEW', 'Unknown failed requirement ID');
  return immutable(review);
}

export function assessReview(review, specification) {
  if (review.boundary_violation) return { outcome: 'BOUNDARY', reason: review.reason };
  if (review.decision !== 'APPROVE') return { outcome: review.decision, reason: review.reason };
  const status = { R1: 'implementation_status', R2: 'specification_compliance', R3: 'architecture_compliance' }[review.review_level];
  if (review[status] !== 'pass' || !review.evidence.length || review.failed_requirements.length) return { outcome: 'BLOCKED', reason: 'Approval lacks passing status or supporting evidence' };
  if (review.review_level === 'R2') {
    const mapping = new Map(review.requirements.map(r => [r.requirement_id, r]));
    if (requirements(specification).some(c => mapping.get(c.id)?.status !== 'pass' || !mapping.get(c.id)?.evidence.length)) {
      return { outcome: 'BLOCKED', reason: 'R2 requires PASS with evidence for every Specification clause; missing evidence remains UNKNOWN' };
    }
  }
  return { outcome: 'APPROVE', reason: review.reason };
}

export function routeReview({ profile, report, discovery, r2, operations }) {
  const observed = new Set(report.triggers);
  if (report.unexpected_deviations.length) observed.add('significant_plan_deviation');
  if (discovery.context_conflicts.length) observed.add('reality_context_conflict');
  if (r2.architecture_compliance !== 'pass') observed.add('uncertain_decision_compliance');
  if (operations.some(o => ['architecture_change', 'system_boundary_change'].includes(o.domain))) observed.add('architecture_sensitive');
  if (operations.some(o => ['public_api_change', 'protocol_contract_change', 'data_model_change'].includes(o.domain))) observed.add('public_api_or_contract');
  const reasons = profile.review.triggers.filter(t => observed.has(t));
  if (profile.review.require_r3) reasons.push('profile_requires_review');
  if (profile.review.human_acceptance) reasons.push('human_acceptance_requires_r3');
  if (report.risk !== 'low') reasons.push(`risk:${report.risk}`);
  return immutable({ required: reasons.length > 0, reasons: [...new Set(reasons)], observed_triggers: [...observed] });
}
