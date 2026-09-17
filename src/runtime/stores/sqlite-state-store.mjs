import { AuditLog, canonical, digest } from '../../audit.mjs';
import { StateStore } from './state-store.mjs';
import { jsonCopy, nonempty, record, version } from '../contracts.mjs';
import { requireRuntime } from '../errors.mjs';

export class SqliteStateStore extends StateStore {
  constructor({ database, snapshotInterval = 8 }) {
    super(); this.database = database; this.snapshotInterval = snapshotInterval;
    requireRuntime(Number.isSafeInteger(snapshotInterval) && snapshotInterval > 0, 'INVALID_RUNTIME_CONTRACT', 'Positive snapshot interval required');
  }
  async capabilities() { return { simulation: false, backend: 'sqlite', durable: this.database.durable, recovery: this.database.durable }; }
  async acquireTask(taskId) { this.database.claimTask(taskId); }
  async create(taskId, data, options = {}) { return this.#commit(taskId, null, data, options); }
  async compareAndSwap(taskId, revision, data, options = {}) { version(revision); return this.#commit(taskId, revision, data, options); }
  #commit(taskId, revision, input, { settlements = [], outbox = [] } = {}) {
    nonempty(taskId, 'task_id'); record(input); const data = jsonCopy(input); const database = this.database, db = database.db;
    return database.transaction(() => {
      database.assertOwner(taskId);
      const prior = db.prepare('SELECT * FROM tasks WHERE task_id=?').get(taskId);
      requireRuntime(revision === null ? !prior : prior?.revision === revision, revision === null ? 'TASK_EXISTS' : 'STORE_CONFLICT', 'Task / Store revision mismatch');
      const next = revision === null ? 0 : revision + 1; version(next);
      const stateVersion = data.snapshot?.state_version ?? 0; version(stateVersion, 'state_version');
      requireRuntime(!prior || stateVersion >= prior.state_version, 'STORE_CONFLICT', 'Controller version cannot go backwards');
      const audit = data.protocol_audit ?? [];
      requireRuntime(AuditLog.verify(audit), 'CORRUPT_RECOVERY', 'Invalid protocol audit chain');
      const oldAudit = db.prepare('SELECT data FROM audit_entries WHERE task_id=? ORDER BY sequence').all(taskId);
      requireRuntime(oldAudit.length <= audit.length && oldAudit.every((row, i) => row.data === canonical(audit[i])), 'CORRUPT_RECOVERY', 'Committed audit prefix is immutable');
      const payload = { task_id: taskId, sequence: next + 1, store_revision: next, previous_state_version: prior?.state_version ?? null,
        state_version: stateVersion, timestamp: new Date().toISOString(), data };
      const hash = digest({ previous_hash: prior?.event_hash ?? null, payload });
      db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(taskId, next + 1, canonical(payload), hash, prior?.event_hash ?? null);
      db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET revision=excluded.revision,state_version=excluded.state_version,data=excluded.data,event_hash=excluded.event_hash')
        .run(taskId, next, stateVersion, canonical(data), hash);
      if (next === 0 || (next + 1) % this.snapshotInterval === 0) db.prepare('INSERT INTO snapshots VALUES(?,?,?,?)').run(taskId, next + 1, hash, canonical(data));
      for (let i = oldAudit.length; i < audit.length; i++) db.prepare('INSERT INTO audit_entries VALUES(?,?,?)').run(taskId, i + 1, canonical(audit[i]));
      for (const attempt of data.operations ?? []) db.prepare('INSERT INTO operation_attempts VALUES(?,?,?) ON CONFLICT(task_id,attempt_id) DO UPDATE SET data=excluded.data').run(taskId, attempt.attempt_id, canonical(attempt));
      for (const settlement of settlements) this.#settle(settlement.key, settlement.result);
      for (const message of outbox) this.#enqueue(message.id, taskId, message.payload);
      database.fault('state_staged');
      return jsonCopy({ store_revision: next, data });
    });
  }
  async read(taskId) {
    const row = this.database.db.prepare('SELECT revision,data FROM tasks WHERE task_id=?').get(taskId);
    return row ? jsonCopy({ store_revision: row.revision, data: JSON.parse(row.data) }) : null;
  }
  async recover(taskId) {
    // Read a consistent committed view, checking log, snapshot, audit and projection.
    return this.database.transaction(() => {
      const db = this.database.db, task = db.prepare('SELECT * FROM tasks WHERE task_id=?').get(taskId);
      requireRuntime(task, 'TASK_NOT_FOUND', 'No durable task');
      const events = db.prepare('SELECT * FROM events WHERE task_id=? ORDER BY sequence').all(taskId);
      let hash = null, stateVersion = null, latest = null;
      for (let i = 0; i < events.length; i++) {
        const event = events[i], payload = JSON.parse(event.payload);
        requireRuntime(event.sequence === i + 1 && payload.sequence === i + 1 && payload.task_id === taskId && payload.store_revision === i
          && event.previous_hash === hash && payload.previous_state_version === stateVersion
          && (stateVersion === null || payload.state_version >= stateVersion)
          && event.hash === digest({ previous_hash: hash, payload }), 'CORRUPT_RECOVERY', 'Event/version continuity failed');
        hash = event.hash; stateVersion = payload.state_version; latest = payload.data;
      }
      requireRuntime(events.length === task.revision + 1 && hash === task.event_hash && stateVersion === task.state_version
        && canonical(latest) === task.data, 'CORRUPT_RECOVERY', 'Task projection differs from event log');
      const snapshot = db.prepare('SELECT * FROM snapshots WHERE task_id=? ORDER BY event_offset DESC LIMIT 1').get(taskId);
      requireRuntime(snapshot && events[snapshot.event_offset - 1]?.hash === snapshot.event_hash
        && canonical(JSON.parse(events[snapshot.event_offset - 1].payload).data) === snapshot.data, 'CORRUPT_RECOVERY', 'Snapshot does not match its event offset');
      let restored = JSON.parse(snapshot.data);
      for (const event of events.slice(snapshot.event_offset)) restored = JSON.parse(event.payload).data;
      const audit = db.prepare('SELECT data FROM audit_entries WHERE task_id=? ORDER BY sequence').all(taskId).map(row => JSON.parse(row.data));
      requireRuntime(AuditLog.verify(audit) && canonical(audit) === canonical(restored.protocol_audit ?? []), 'CORRUPT_RECOVERY', 'Durable audit differs');
      const attempts = db.prepare('SELECT data FROM operation_attempts WHERE task_id=? ORDER BY attempt_id').all(taskId).map(row => JSON.parse(row.data));
      requireRuntime(canonical(attempts) === canonical([...(restored.operations ?? [])].sort((a, b) => a.attempt_id < b.attempt_id ? -1 : a.attempt_id > b.attempt_id ? 1 : 0)), 'CORRUPT_RECOVERY', 'Operation projection differs');
      return jsonCopy({ store_revision: task.revision, data: restored, snapshot_offset: snapshot.event_offset, replayed_events: events.length - snapshot.event_offset });
    });
  }
  async claim(key, hash, { task_id = null } = {}) {
    nonempty(key, 'key'); nonempty(hash, 'hash');
    return this.database.transaction(() => {
      const db = this.database.db, prior = db.prepare('SELECT * FROM inbox WHERE key=?').get(key);
      if (prior) {
        requireRuntime(prior.hash === hash, 'IDEMPOTENCY_CONFLICT', 'Idempotency key content changed');
        return jsonCopy({ claimed: false, hash, status: prior.status, result: prior.result === null ? null : JSON.parse(prior.result) });
      }
      db.prepare('INSERT INTO inbox VALUES(?,?,?,?,NULL)').run(key, hash, task_id, 'PENDING');
      return { claimed: true, hash, status: 'PENDING', result: null };
    });
  }
  #settle(key, result) {
    const update = this.database.db.prepare("UPDATE inbox SET status='SETTLED',result=? WHERE key=? AND status='PENDING'").run(canonical(jsonCopy(result)), key);
    requireRuntime(update.changes === 1, 'INVALID_IDEMPOTENCY_STATE', 'Only a pending request can settle');
  }
  async settle(key, result) { this.database.transaction(() => this.#settle(key, result)); }
  async pending(taskId) { return this.database.db.prepare("SELECT key FROM inbox WHERE task_id=? AND status='PENDING'").all(taskId).map(row => row.key); }
  #enqueue(id, taskId, payload) {
    nonempty(id, 'outbox id'); const hash = digest(payload), db = this.database.db;
    const prior = db.prepare('SELECT hash FROM outbox WHERE id=?').get(id);
    requireRuntime(!prior || prior.hash === hash, 'IDEMPOTENCY_CONFLICT', 'Outbox ID content changed');
    if (!prior) db.prepare('INSERT INTO outbox VALUES(?,?,?,?,?)').run(id, taskId, hash, canonical(payload), 'PENDING');
  }
  async enqueue(id, taskId, payload) { this.database.transaction(() => this.#enqueue(id, taskId, jsonCopy(payload))); }
  async outbox(taskId) { return this.database.db.prepare('SELECT * FROM outbox WHERE task_id=? ORDER BY id').all(taskId).map(row => jsonCopy({ ...row, payload: JSON.parse(row.payload) })); }
  async markOutbox(id, expected, status) {
    requireRuntime(['SENDING', 'DELIVERED', 'UNCERTAIN'].includes(status), 'INVALID_RUNTIME_CONTRACT', 'Invalid delivery status');
    const update = this.database.db.prepare('UPDATE outbox SET status=? WHERE id=? AND status=?').run(status, id, expected);
    requireRuntime(update.changes === 1, 'DELIVERY_CONFLICT', 'Outbox status changed');
  }
}
