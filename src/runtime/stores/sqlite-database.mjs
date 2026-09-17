import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireRuntime } from '../errors.mjs';

export function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; } // Permission denial is not proof of death.
}
export class SqliteDatabase {
  static async open({ path, fault = () => {} } = {}) {
    const [major, minor] = process.versions.node.split('.').map(Number);
    requireRuntime(major > 24 || major === 24 && minor >= 14, 'UNSUPPORTED_CAPABILITY', 'SQLite backend requires Node >=24.14');
    requireRuntime(typeof path === 'string' && path.length > 0, 'INVALID_RUNTIME_CONTRACT', 'SQLite path required');
    const { DatabaseSync } = await import('node:sqlite');
    const database = new SqliteDatabase();
    database.path = path === ':memory:' ? path : resolve(path); database.durable = path !== ':memory:';
    database.owner = randomUUID(); database.pid = process.pid; database.fault = fault;
    database.db = new DatabaseSync(database.path, { timeout: 5000, enableForeignKeyConstraints: true, allowExtension: false });
    try {
      database.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
      database.transaction(() => {
        const version = database.db.prepare('PRAGMA user_version').get().user_version;
        requireRuntime(version <= 1, 'UNSUPPORTED_STORAGE_VERSION', 'Database was created by a newer Runtime');
        if (version === 0) database.db.exec(`
          CREATE TABLE tasks(task_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state_version INTEGER NOT NULL, data TEXT NOT NULL, event_hash TEXT NOT NULL);
          CREATE TABLE events(task_id TEXT NOT NULL, sequence INTEGER NOT NULL, payload TEXT NOT NULL, hash TEXT NOT NULL, previous_hash TEXT, PRIMARY KEY(task_id, sequence));
          CREATE TABLE snapshots(task_id TEXT NOT NULL, event_offset INTEGER NOT NULL, event_hash TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(task_id, event_offset));
          CREATE TABLE audit_entries(task_id TEXT NOT NULL, sequence INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(task_id, sequence));
          CREATE TABLE inbox(key TEXT PRIMARY KEY, hash TEXT NOT NULL, task_id TEXT, status TEXT NOT NULL, result TEXT);
          CREATE TABLE outbox(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, hash TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL);
          CREATE TABLE operation_attempts(task_id TEXT NOT NULL, attempt_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(task_id, attempt_id));
          CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, grant_json TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE artifacts(id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE task_owners(task_id TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL);
          CREATE TABLE repository_leases(identity TEXT PRIMARY KEY, lease_id TEXT NOT NULL, task_id TEXT NOT NULL, owner TEXT NOT NULL, pid INTEGER NOT NULL, expires_at INTEGER NOT NULL);
          CREATE TABLE workspaces(ref TEXT PRIMARY KEY, data TEXT NOT NULL);
          PRAGMA user_version=1;
        `);
      });
      return database;
    } catch (error) { database.db.close(); throw error; }
  }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      requireRuntime(!result?.then, 'INVALID_TRANSACTION', 'SQLite transactions must be synchronous');
      this.fault?.('before_commit'); this.db.exec('COMMIT'); this.fault?.('after_commit'); return result;
    } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
  claimTask(taskId) {
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT * FROM task_owners WHERE task_id=?').get(taskId);
      requireRuntime(!prior || prior.owner === this.owner || !processAlive(prior.pid), 'TASK_OWNED', 'Another live process owns this task');
      this.db.prepare('INSERT INTO task_owners VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET owner=excluded.owner,pid=excluded.pid').run(taskId, this.owner, this.pid);
    });
  }
  assertOwner(taskId) {
    const prior = this.db.prepare('SELECT * FROM task_owners WHERE task_id=?').get(taskId);
    requireRuntime(!prior || prior.owner === this.owner, 'TASK_OWNED', 'Task ownership changed');
  }
  close() {
    if (!this.db.isOpen) return;
    this.transaction(() => { this.db.prepare('DELETE FROM task_owners WHERE owner=?').run(this.owner); });
    this.db.close();
  }
}
