import { createHash } from 'node:crypto';
import { check } from '../../contracts.mjs';
import { canonical } from '../../audit.mjs';
import { IdentityProvider } from './identity-provider.mjs';
import { jsonCopy, nonempty } from '../contracts.mjs';
import { requireRuntime } from '../errors.mjs';

const tokenHash = token => createHash('sha256').update(token).digest('hex');
// Durable host-installed grants; still a fixture/operator-session provider, not login authentication.
export class SqliteIdentityProvider extends IdentityProvider {
  constructor({ database, sessions = [], clock = () => Date.now() }) {
    super(); this.database = database; this.clock = clock;
    database.transaction(() => {
      for (const session of sessions) {
        nonempty(session.credential, 'credential'); check('Principal', session.principal);
        requireRuntime(Array.isArray(session.task_ids) && session.task_ids.length > 0 && Number.isFinite(session.expires_at), 'INVALID_SESSION', 'Explicit task grants and expiry required');
        session.task_ids.forEach(id => nonempty(id, 'task_id'));
        const grant = canonical(jsonCopy({ principal: session.principal, task_ids: session.task_ids, expires_at: session.expires_at }));
        const hash = tokenHash(session.credential), prior = database.db.prepare('SELECT grant_json FROM sessions WHERE token_hash=?').get(hash);
        requireRuntime(!prior || prior.grant_json === grant, 'SESSION_CONFLICT', 'Existing credential grants cannot be silently expanded');
        if (!prior) database.db.prepare('INSERT INTO sessions(token_hash,grant_json) VALUES(?,?)').run(hash, grant);
      }
    });
  }
  async capabilities() { return { simulation: true, durable: this.database.durable, backend: 'sqlite-session-fixture' }; }
  async authenticate(credential) {
    nonempty(credential, 'credential');
    const row = this.database.db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(tokenHash(credential));
    const grant = row ? JSON.parse(row.grant_json) : null;
    requireRuntime(grant && !row.revoked && grant.expires_at > this.clock(), 'UNAUTHENTICATED', 'Session is missing, expired or revoked');
    return jsonCopy({ principal: grant.principal, task_ids: grant.task_ids });
  }
  async revoke(credential) { return this.database.db.prepare('UPDATE sessions SET revoked=1 WHERE token_hash=? AND revoked=0').run(tokenHash(credential)).changes > 0; }
}
