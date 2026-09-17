import { randomUUID } from 'node:crypto';
import { processAlive } from '../stores/sqlite-database.mjs';
import { jsonCopy, nonempty } from '../contracts.mjs';
import { requireRuntime } from '../errors.mjs';

export class RepositoryLease {
  constructor({ database, clock = () => Date.now(), leaseMs = 60000 }) {
    this.database = database; this.clock = clock; this.leaseMs = leaseMs;
    requireRuntime(Number.isSafeInteger(leaseMs) && leaseMs > 0, 'INVALID_WORKSPACE', 'Positive lease duration required');
  }
  acquire(identity, taskId, mode = 'write') {
    nonempty(identity, 'repository identity'); nonempty(taskId, 'task_id');
    requireRuntime(mode === 'write', 'INVALID_RUNTIME_CONTRACT', 'Only single-writer leases are implemented');
    const database = this.database;
    return database.transaction(() => {
      const prior = database.db.prepare('SELECT * FROM repository_leases WHERE identity=?').get(identity);
      // Time expiry never proves the old writer stopped. Require actual owner death/release.
      requireRuntime(!prior, prior && processAlive(prior.pid) ? 'LEASE_CONFLICT' : 'RECONCILIATION_REQUIRED', 'Existing lease must be explicitly released or reconciled before takeover');
      const lease = { lease_id: randomUUID(), repository_identity: identity, task_id: taskId, mode, expires_at: this.clock() + this.leaseMs, simulation: false };
      database.db.prepare('INSERT INTO repository_leases VALUES(?,?,?,?,?,?) ON CONFLICT(identity) DO UPDATE SET lease_id=excluded.lease_id,task_id=excluded.task_id,owner=excluded.owner,pid=excluded.pid,expires_at=excluded.expires_at')
        .run(identity, lease.lease_id, taskId, database.owner, database.pid, lease.expires_at);
      return jsonCopy(lease);
    });
  }
  renew(id) {
    return this.database.transaction(() => {
      const prior = this.database.db.prepare('SELECT * FROM repository_leases WHERE lease_id=?').get(id);
      requireRuntime(prior?.owner === this.database.owner, 'LEASE_EXPIRED', 'Lease ownership changed');
      const expires_at = this.clock() + this.leaseMs;
      this.database.db.prepare('UPDATE repository_leases SET expires_at=? WHERE lease_id=? AND owner=?').run(expires_at, id, this.database.owner);
      return jsonCopy({ lease_id: id, repository_identity: prior.identity, task_id: prior.task_id, mode: 'write', expires_at, simulation: false });
    });
  }
  release(id) { return this.database.db.prepare('DELETE FROM repository_leases WHERE lease_id=? AND owner=?').run(id, this.database.owner).changes === 1; }
  assertFree(identity) {
    const prior = this.database.db.prepare('SELECT * FROM repository_leases WHERE identity=?').get(identity);
    requireRuntime(!prior, 'WORKSPACE_IN_USE', 'Repository lease has not been released or reconciled');
  }
}
