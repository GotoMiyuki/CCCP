import { posix, win32 } from 'node:path';
import { assert, check, immutable, DEFAULT_ALLOWED } from './contracts.mjs';

export function requireRole(actor, ...roles) {
  check('Principal', actor);
  assert(roles.includes(actor.role), 'AUTHORITY_BOUNDARY_EXCEEDED', `${actor.role} cannot perform this action; requires ${roles.join(' / ')}`);
}

export function relativePath(value) {
  assert(typeof value === 'string' && value.length > 0, 'INVALID_PATH', 'A nonempty repository-relative path is required');
  const path = value.replaceAll('\\', '/');
  assert(!posix.isAbsolute(path) && !win32.isAbsolute(path) && !path.includes(':') && !path.includes('\0') && !path.split('/').includes('..'), 'INVALID_PATH', `Path escapes repository: ${value}`);
  return posix.normalize(path).replace(/\/$/, '') || '.';
}
export function pathWithin(path, root) {
  const p = relativePath(path); const r = relativePath(root);
  return r === '.' || p === r || p.startsWith(`${r}/`);
}

export function authorize(operation, delegation, profile) {
  check('Operation', operation); check('Delegation', delegation); check('Profile', profile);
  if (operation.changes_decision) return { allowed: false, reason: 'Approved Decision cannot be changed by an implementation operation' };
  const allowed = new Set([...DEFAULT_ALLOWED, ...profile.delegation.allowed, ...delegation.allowed]);
  const forbidden = new Set([...profile.delegation.forbidden, ...delegation.forbidden]);
  if (forbidden.has(operation.domain) || !allowed.has(operation.domain)) return { allowed: false, reason: `Domain ${operation.domain} is not delegated` };
  const permission = operation.permission ?? (['push', 'force_push', 'remote_branch_change', 'remote_branch_delete', 'destructive_operation'].includes(operation.domain) ? operation.domain : null);
  // A custom permission cannot replace the mandatory permission on sensitive operations.
  for (const name of new Set([permission, ...(['push', 'force_push', 'remote_branch_change', 'remote_branch_delete', 'destructive_operation'].includes(operation.domain) ? [operation.domain] : [])])) {
    if (name && (!Object.hasOwn(profile.permissions, name) || profile.permissions[name] !== true)) return { allowed: false, reason: `Permission ${name} not granted` };
  }
  if (operation.paths.some(p => !delegation.paths.some(root => pathWithin(p, root)))) return { allowed: false, reason: 'Operation path exceeds delegated scope' };
  return { allowed: true, reason: 'Within delegation, permissions and declared Decision boundary' };
}

// Actors are trusted host inputs, never identities read from an untrusted message.
export function approveProfile(actor, profile, audit) {
  requireRole(actor, 'human'); check('Profile', profile);
  audit?.append('PROFILE_APPROVED', actor, profile);
  return immutable(profile);
}
