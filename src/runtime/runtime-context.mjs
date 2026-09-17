import { check, immutable } from '../contracts.mjs';
import { canonical } from '../audit.mjs';
import { validateContext, record } from './contracts.mjs';
import { requireRuntime } from './errors.mjs';

export function resolveRuntimeContext(context, grant) {
  validateContext(context); record(grant, 'identity grant'); check('Principal', grant.principal);
  requireRuntime(Array.isArray(grant.task_ids) && grant.task_ids.includes(context.task_id), 'SESSION_SCOPE_EXCEEDED', 'Session does not grant this task');
  requireRuntime(!context.principal || canonical(context.principal) === canonical(grant.principal), 'AUTHORITY_BOUNDARY_EXCEEDED', 'Claimed principal differs from authenticated principal');
  return immutable({ ...context, principal: grant.principal });
}
export function checkTaskContext(context, task, { readOnly = false } = {}) {
  requireRuntime(context.delegation_ref === task.controller.delegation.id && context.workspace_ref === task.workspace.workspace_ref, 'REFERENCE_MISMATCH', 'Delegation or workspace does not match task');
  if (!readOnly) requireRuntime(context.state_version === task.controller.snapshot.state_version, 'STALE_STATE_VERSION', 'Refresh task context before writing');
}
