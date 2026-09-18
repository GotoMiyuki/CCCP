import { check, immutable } from '../contracts.mjs';
import { requireRuntime } from './errors.mjs';

export const RUNTIME_CONTRACT_VERSION = '0.2';
export const EXECUTION_OUTCOMES = Object.freeze(['SUCCEEDED', 'FAILED_CLEAN', 'EFFECT_UNKNOWN', 'INTERRUPTED']);
export const PORT_METHODS = immutable({
  identity: ['capabilities', 'authenticate', 'revoke'],
  agent: ['capabilities', 'deliberate', 'implement', 'review', 'cancel', 'inspect'],
  state: ['capabilities', 'create', 'read', 'compareAndSwap', 'claim', 'settle'],
  tool: ['capabilities', 'run', 'cancel', 'inspect'],
  workspace: ['capabilities', 'createWorkspace', 'inspectWorkspace', 'acquireLease', 'renewLease', 'releaseLease', 'disposeWorkspace'],
  evidence: ['capabilities', 'put', 'read', 'verify'],
});

export function record(value, name = 'record', keys) {
  requireRuntime(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_RUNTIME_CONTRACT', `${name} must be an object`);
  if (keys) requireRuntime(Object.keys(value).every(k => keys.includes(k)), 'INVALID_RUNTIME_CONTRACT', `${name} contains unknown fields`);
  return value;
}
export function nonempty(value, name) {
  requireRuntime(typeof value === 'string' && value.trim().length > 0, 'INVALID_RUNTIME_CONTRACT', `${name} must be nonempty text`);
  return value;
}
export function version(value, name = 'version') {
  requireRuntime(Number.isSafeInteger(value) && value >= 0, 'INVALID_RUNTIME_CONTRACT', `${name} must be a nonnegative safe integer`);
  return value;
}
export function oneOf(value, values, name) {
  requireRuntime(values.includes(value), 'INVALID_RUNTIME_CONTRACT', `Invalid ${name}`); return value;
}
export function jsonCopy(value) {
  const visit = (v, seen = new Set()) => {
    requireRuntime(v !== undefined && typeof v !== 'function' && typeof v !== 'symbol' && typeof v !== 'bigint', 'INVALID_RUNTIME_CONTRACT', 'Expected JSON data');
    if (typeof v === 'number') requireRuntime(Number.isFinite(v), 'INVALID_RUNTIME_CONTRACT', 'Expected finite number');
    if (v && typeof v === 'object') {
      requireRuntime(!seen.has(v) && (Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null), 'INVALID_RUNTIME_CONTRACT', 'Expected acyclic plain JSON data');
      seen.add(v);
      if (Array.isArray(v)) for (let i = 0; i < v.length; i++) { requireRuntime(Object.hasOwn(v, i), 'INVALID_RUNTIME_CONTRACT', 'Sparse array'); visit(v[i], seen); }
      else for (const item of Object.values(v)) visit(item, seen);
      seen.delete(v);
    }
  };
  visit(value); return immutable(value);
}
export function validatePort(name, port) {
  requireRuntime(PORT_METHODS[name]?.every(method => typeof port?.[method] === 'function'), 'INVALID_PROVIDER', `Incomplete ${name} provider`);
}
export function validateCapabilities(value) {
  record(value, 'provider capabilities', ['simulation', 'cancellation', 'durable', 'recovery', 'backend', 'sandbox', 'cross_process', 'independent_review', 'provider_id', 'review_boundary']);
  requireRuntime(typeof value.simulation === 'boolean', 'INVALID_RUNTIME_CONTRACT', 'simulation must be explicit');
  if (!value.simulation) requireRuntime(['sqlite', 'docker', 'git-worktree', 'codex-app-server', 'openai-responses', 'routed-agent'].includes(value.backend), 'UNSUPPORTED_CAPABILITY', 'Unsupported real provider backend');
  for (const field of ['cancellation', 'durable', 'recovery', 'cross_process', 'independent_review']) if (field in value) requireRuntime(typeof value[field] === 'boolean', 'INVALID_RUNTIME_CONTRACT', `${field} must be boolean`);
  if ('provider_id' in value) nonempty(value.provider_id, 'provider_id');
  if ('review_boundary' in value) oneOf(value.review_boundary, ['independent-run'], 'review_boundary');
  return jsonCopy(value);
}

export function validateFileChanges(value) {
  requireRuntime(Array.isArray(value), 'INVALID_RUNTIME_CONTRACT', 'file_changes must be an array');
  requireRuntime(value.length > 0 && value.length <= 100, 'INVALID_RUNTIME_CONTRACT', 'file_changes must contain 1..100 entries');
  let bytes = 0;
  const paths = new Set();
  for (const change of value) {
    record(change, 'file change', ['path', 'content']); nonempty(change.path, 'file change path');
    requireRuntime(typeof change.content === 'string' && !change.path.includes('\\') && !change.path.startsWith('/') && !/^[A-Za-z]:/.test(change.path)
      && !change.path.split('/').some(part => !part || part === '.' || part === '..'), 'INVALID_RUNTIME_CONTRACT', 'File change must use a normalized relative path');
    requireRuntime(!paths.has(change.path), 'INVALID_RUNTIME_CONTRACT', 'Duplicate file change path');
    paths.add(change.path); bytes += Buffer.byteLength(change.content, 'utf8');
  }
  requireRuntime(bytes <= 1024 * 1024, 'INVALID_RUNTIME_CONTRACT', 'Agent file changes exceed 1 MiB');
  return jsonCopy(value);
}
export function validateContext(value) {
  record(value, 'context', ['task_id', 'principal', 'state_version', 'delegation_ref', 'workspace_ref', 'correlation_id']);
  for (const k of ['task_id', 'delegation_ref', 'workspace_ref', 'correlation_id']) nonempty(value[k], k);
  version(value.state_version, 'state_version');
  if ('principal' in value) check('Principal', value.principal);
  return value;
}
export function validateRequest(value) {
  record(value, 'request', ['credential', 'context', 'payload', 'idempotency_key']);
  nonempty(value.credential, 'credential'); validateContext(value.context); record(value.payload, 'payload');
  if ('idempotency_key' in value) nonempty(value.idempotency_key, 'idempotency_key');
  return jsonCopy(value);
}
export function validateToolResult(value, { allowReal = false } = {}) {
  record(value, 'tool result'); oneOf(value.outcome, EXECUTION_OUTCOMES, 'outcome');
  requireRuntime(typeof value.stdout === 'string' && typeof value.stderr === 'string', 'INVALID_RUNTIME_CONTRACT', 'Tool output must be text');
  requireRuntime(value.exit_code === null || Number.isInteger(value.exit_code), 'INVALID_RUNTIME_CONTRACT', 'Invalid exit_code');
  requireRuntime(value.outcome !== 'SUCCEEDED' || value.exit_code === 0, 'INVALID_RUNTIME_CONTRACT', 'Successful command must have exit_code=0');
  requireRuntime(value.simulation === true || allowReal && value.simulation === false, 'INVALID_RUNTIME_CONTRACT', 'Result must declare its execution mode');
  return jsonCopy(value);
}
export function validateArtifact(value, { allowReal = false } = {}) {
  record(value, 'artifact');
  for (const k of ['task_id', 'operation_id', 'producer']) nonempty(value[k], k);
  oneOf(value.type, ['TEST_RUN', 'COMMAND_RUN', 'FILE', 'DIFF', 'COMMIT', 'REVIEW'], 'artifact type');
  oneOf(value.status, ['pass', 'fail', 'unknown'], 'artifact status');
  requireRuntime(typeof value.content === 'string' && (value.simulation === true || allowReal && value.simulation === false), 'INVALID_RUNTIME_CONTRACT', 'Artifact must contain text and an allowed execution mode');
  check('Principal', value.principal); record(value.repository_snapshot, 'repository_snapshot');
  return jsonCopy(value);
}
