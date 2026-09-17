import { check } from '../../contracts.mjs';
import { IdentityProvider } from './identity-provider.mjs';
import { nonempty, jsonCopy } from '../contracts.mjs';
import { requireRuntime } from '../errors.mjs';

export class MemoryIdentityProvider extends IdentityProvider {
  #sessions = new Map(); #clock;
  constructor({ sessions = [], clock = () => Date.now() } = {}) {
    super(); this.#clock = clock;
    for (const session of sessions) {
      nonempty(session.credential, 'credential'); check('Principal', session.principal);
      requireRuntime(!this.#sessions.has(session.credential), 'INVALID_SESSION', 'Duplicate credential');
      requireRuntime(Array.isArray(session.task_ids) && session.task_ids.length > 0, 'INVALID_SESSION', 'Explicit task grants required');
      session.task_ids.forEach(id => nonempty(id, 'task_id'));
      requireRuntime(Number.isFinite(session.expires_at), 'INVALID_SESSION', 'Explicit expiry required');
      const { credential, principal, task_ids, expires_at } = session;
      this.#sessions.set(credential, jsonCopy({ principal, task_ids, expires_at }));
    }
  }
  async capabilities() { return { simulation: true }; }
  async authenticate(credential) {
    const grant = this.#sessions.get(credential);
    requireRuntime(grant && grant.expires_at > this.#clock(), 'UNAUTHENTICATED', 'Missing, expired or revoked session');
    return jsonCopy({ principal: grant.principal, task_ids: grant.task_ids });
  }
  async revoke(credential) { return this.#sessions.delete(credential); }
}
