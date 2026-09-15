// Implementation schemas refine the guide; they do not constitute a new protocol version.
const string = { type: 'string', minLength: 1, pattern: '\\S' };
const bool = { type: 'boolean' };
const strings = { type: 'array', items: string, uniqueItems: true };
const list = (items, minItems = 0) => ({ type: 'array', items, minItems });
const enumeration = (...values) => ({ type: 'string', enum: values });
const ref = name => ({ $ref: `#/$defs/${name}` });
const object = (properties, optional = []) => ({
  type: 'object', properties, required: Object.keys(properties).filter(k => !optional.includes(k)),
  additionalProperties: false,
});
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const integer = { type: 'integer', minimum: 0 };
const timestamp = { type: 'string', format: 'date-time' };

export const ROLES = Object.freeze(['human', 'chatgpt', 'codex', 'bridge', 'repository']);
export const DECISION_STATES = Object.freeze(['INTENT', 'PROPOSAL', 'DELIBERATION', 'DECISION_PENDING', 'APPROVED', 'SPECIFIED', 'DELEGATED', 'REJECTED', 'BLOCKED']);
export const EXECUTION_STATES = Object.freeze(['DISCOVERY', 'IMPLEMENTATION_PLANNED', 'IMPLEMENTING', 'VERIFYING', 'SPEC_REVIEW', 'REVIEW_ROUTING', 'ARCHITECTURE_REVIEW', 'HUMAN_ACCEPTANCE', 'REVISION', 'REPLAN_PROPOSED', 'BLOCKED', 'DONE']);
export const DEFAULT_ALLOWED = Object.freeze(['internal_implementation', 'local_refactor', 'internal_structure', 'test_implementation', 'code_cleanup', 'specification_local_change', 'implementation_plan']);
export const DEFAULT_RESTRICTED = Object.freeze(['architecture_change', 'system_boundary_change', 'public_api_change', 'external_behavior_change', 'scope_expansion', 'new_dependency', 'data_model_change', 'protocol_contract_change', 'important_feature_removal', 'destructive_operation', 'release_workflow_change', 'push', 'force_push', 'remote_branch_change', 'remote_branch_delete']);
export const DOMAINS = Object.freeze([...DEFAULT_ALLOWED, ...DEFAULT_RESTRICTED]);
export const DEFAULT_TRIGGERS = Object.freeze(['architecture_sensitive', 'cross_module_responsibility', 'public_api_or_contract', 'near_delegation_boundary', 'significant_plan_deviation', 'uncertain_decision_compliance', 'reality_context_conflict', 'profile_requires_review']);
export const REQUIREMENT_GROUPS = Object.freeze(['scope', 'constraints', 'non_goals', 'acceptance_criteria', 'invariants', 'expected_behavior', 'verification_criteria']);
export const MESSAGE_TYPES = Object.freeze(['DISCOVERY_REQUEST', 'DISCOVERY_REPORT', 'DESIGN_PROPOSAL', 'DECISION_REQUEST', 'DESIGN_DECISION', 'IMPLEMENT_REQUEST', 'IMPLEMENT_REPORT', 'REVIEW_REQUEST', 'REVIEW_RESULT', 'CHANGE_PROPOSAL', 'REPLAN_PROPOSAL', 'BLOCKED_REPORT']);

const defs = {
  Principal: object({ id: string, role: enumeration(...ROLES) }),
  Intent: object({ id: string, objective: string }),
  Proposal: object({ id: string, intent_id: string, approach: string, trade_offs: strings, alternatives: strings }),
  Decision: object({ id: string, intent_id: string, proposal_id: string, goal: string, selected_approach: string, constraints: strings, non_goals: strings, important_trade_offs: strings, rejected_alternatives: strings }),
  Clause: object({ id: string, text: string }),
  Specification: object({ id: string, decision_id: string, objective: ref('Clause'), ...Object.fromEntries(REQUIREMENT_GROUPS.map(k => [k, list(ref('Clause'), k === 'acceptance_criteria' || k === 'verification_criteria' ? 1 : 0)])) }),
  Delegation: object({ id: string, decision_id: string, allowed: list(enumeration(...DOMAINS)), forbidden: list(enumeration(...DOMAINS)), paths: list(string, 1) }),
  Permissions: { type: 'object', additionalProperties: bool },
  Profile: object({
    id: string, repository: string, default_branch: string,
    delegation: object({ allowed: list(enumeration(...DOMAINS)), forbidden: list(enumeration(...DOMAINS)) }),
    permissions: ref('Permissions'),
    verification_commands: list(list(string, 1)), context_path: string,
    review: object({ triggers: strings, require_r3: bool, human_acceptance: bool, max_revision_attempts: integer, repeated_failure_limit: { type: 'integer', minimum: 2 } }),
  }),
  Operation: object({ id: string, domain: enumeration(...DOMAINS), paths: strings, permission: string, changes_decision: bool, description: string }, ['permission']),
  Repository: object({ path: string, branch: nullable(string), commit: nullable(string) }),
  Discovery: object({
    repository: ref('Repository'), base_commit: nullable(string), working_tree_status: enumeration('clean', 'dirty', 'not_git'),
    changed_files: strings, related_files: strings, architecture_observations: strings, reusable_implementations: strings,
    test_status: enumeration('pass', 'fail', 'unknown'), test_evidence: strings,
    context_conflicts: strings, observed_at: timestamp, fingerprint: string,
  }),
  ImplementationReport: object({ id: string, specification_id: string, discovery_fingerprint: string, summary: string, changed_files: strings, evidence: strings, unexpected_deviations: strings, risk: enumeration('low', 'medium', 'high', 'unknown'), triggers: strings }),
  RequirementEvidence: object({ requirement_id: string, status: enumeration('pass', 'fail', 'unknown'), evidence: strings }),
  ReviewResult: object({
    id: string, report_id: string, review_level: enumeration('R1', 'R2', 'R3'), reviewer: ref('Principal'),
    decision: enumeration('APPROVE', 'REVISION_RECOMMENDED', 'REPLAN_RECOMMENDED', 'BLOCKED'),
    confidence: { type: 'number', minimum: 0, maximum: 1 }, findings: strings, evidence: strings, failed_requirements: strings,
    requirements: list(ref('RequirementEvidence')), implementation_status: enumeration('pass', 'fail', 'unknown'),
    specification_compliance: enumeration('pass', 'fail', 'unknown'), architecture_compliance: enumeration('pass', 'fail', 'unknown'),
    boundary_violation: bool, reason: string, failure_signature: string,
  }, ['failure_signature']),
  ChangeProposal: object({ id: string, decision_id: string, problem: string, suggested_change: string, trade_offs: strings, affected_boundaries: strings, evidence: strings }),
  BlockedReport: object({ id: string, reason: string, category: enumeration('IMPLEMENTATION_FAILURE', 'SPECIFICATION_FAILURE', 'ARCHITECTURE_FAILURE', 'AUTHORITY_BOUNDARY_EXCEEDED', 'REPOSITORY_FAILURE', 'LOOP_PROTECTION', 'MISSING_INFORMATION'), evidence: strings, required_resolution: string }),
  ContextEntry: object({ id: string, kind: enumeration('HUMAN_DECISION', 'AI_PROPOSAL', 'AI_INFERENCE', 'REPOSITORY_FACT', 'HISTORICAL_CONTEXT'), content: string, source_commit: nullable(string), updated_at: timestamp, generated_by: ref('Principal'), status: enumeration('current', 'stale', 'historical'), decision_id: string }, ['decision_id']),
};

const payloads = {
  DISCOVERY_REQUEST: object({ related_paths: strings }), DISCOVERY_REPORT: ref('Discovery'),
  DESIGN_PROPOSAL: ref('Proposal'), DECISION_REQUEST: object({ proposal_id: string, question: string }), DESIGN_DECISION: ref('Decision'),
  IMPLEMENT_REQUEST: object({ decision_id: string, specification_id: string, delegation_id: string }), IMPLEMENT_REPORT: ref('ImplementationReport'),
  REVIEW_REQUEST: object({ report_id: string, review_level: enumeration('R1', 'R2', 'R3') }), REVIEW_RESULT: ref('ReviewResult'),
  CHANGE_PROPOSAL: ref('ChangeProposal'), REPLAN_PROPOSAL: ref('ChangeProposal'), BLOCKED_REPORT: ref('BlockedReport'),
};
defs.Envelope = {
  oneOf: MESSAGE_TYPES.map(type => object({ protocol: { const: 'CCCP' }, version: { const: '1.0' }, message_type: { const: type },
    message_id: string, task_id: string, timestamp, repository: ref('Repository'), payload: payloads[type],
    request_id: string, parent_message_id: string, idempotency_key: string,
  }, ['request_id', 'parent_message_id', 'idempotency_key'])),
};
export const CONTRACT = freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:cccp:implementation:0.1:core',
  title: 'CCCP v1.0 reference implementation contracts (provisional)', $defs: defs,
});

export function defaultProfile(repository) {
  return { id: 'default', repository, default_branch: 'main', delegation: { allowed: [...DEFAULT_ALLOWED], forbidden: [...DEFAULT_RESTRICTED] },
    permissions: {}, verification_commands: [], context_path: 'docs/ai',
    review: { triggers: [...DEFAULT_TRIGGERS], require_r3: false, human_acceptance: false, max_revision_attempts: 2, repeated_failure_limit: 2 } };
}

// Deliberately limited to the keywords used above. Unknown keywords are rejected,
// so adding a schema constraint cannot silently leave runtime validation weaker.
const annotations = new Set(['$schema', '$id', 'title', '$defs', 'description']);
const keywords = new Set(['$ref', 'type', 'const', 'enum', 'anyOf', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'uniqueItems', 'minLength', 'minimum', 'maximum', 'format', 'pattern']);
function validTimestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && hour < 24 && minute < 60 && second < 60;
}
export function errorsFor(schema, value, at = '$') {
  const errors = [];
  for (const key of Object.keys(schema)) if (!annotations.has(key) && !keywords.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
  if (schema.$ref) {
    const name = schema.$ref.replace('#/$defs/', '');
    if (!schema.$ref.startsWith('#/$defs/') || !Object.hasOwn(defs, name)) throw new Error(`Unsupported schema reference: ${schema.$ref}`);
    errors.push(...errorsFor(defs[name], value, at));
  }
  for (const union of ['anyOf', 'oneOf']) if (schema[union]) {
    const matches = schema[union].filter(s => errorsFor(s, value, at).length === 0).length;
    if (union === 'oneOf' ? matches !== 1 : matches === 0) errors.push(`${at}: ${union} has ${matches} matching variants`);
  }
  if ('const' in schema && value !== schema.const) errors.push(`${at}: expected ${schema.const}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: invalid enum value`);
  if (schema.type) {
    const valid = schema.type === 'null' ? value === null : schema.type === 'array' ? Array.isArray(value)
      : schema.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : schema.type === 'integer' ? Number.isSafeInteger(value)
      : schema.type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === schema.type;
    if (!valid) return [...errors, `${at}: expected ${schema.type}`];
  }
  if (typeof value === 'string') {
    if (schema.minLength && [...value].length < schema.minLength) errors.push(`${at}: string too short`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${at}: does not match required pattern`);
    if (schema.format === 'date-time' && !validTimestamp(value)) errors.push(`${at}: expected valid calendar date-time with timezone`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: above maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems && value.length < schema.minItems) errors.push(`${at}: too few items`);
    if (schema.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length) errors.push(`${at}: duplicate items`);
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) errors.push(`${at}[${i}]: sparse arrays are not JSON data`);
      else if (schema.items) errors.push(...errorsFor(schema.items, value[i], `${at}[${i}]`));
    }
  } else if (value !== null && typeof value === 'object') {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${at}.${key}: required`);
    for (const [key, v] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) errors.push(...errorsFor(schema.properties[key], v, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}.${key}: unknown property`);
      else if (typeof schema.additionalProperties === 'object') errors.push(...errorsFor(schema.additionalProperties, v, `${at}.${key}`));
    }
  }
  return errors;
}
export class ProtocolError extends Error {
  constructor(code, message) { super(message); this.name = 'ProtocolError'; this.code = code; }
}
export function check(name, value) {
  if (!Object.hasOwn(defs, name)) throw new Error(`Unknown contract: ${name}`);
  const errors = errorsFor(defs[name], value);
  if (errors.length) throw new ProtocolError('INVALID_SCHEMA', `${name}: ${errors.join('; ')}`);
  return value;
}
export function assert(condition, code, message) { if (!condition) throw new ProtocolError(code, message); }
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export function immutable(value) { return freeze(structuredClone(value)); }
