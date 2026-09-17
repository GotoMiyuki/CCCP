import { createHash } from 'node:crypto';
import { Bridge } from '../bridge.mjs';
import { canonical, digest } from '../audit.mjs';
import { jsonCopy } from './contracts.mjs';
import { requireRuntime } from './errors.mjs';

const hashToken = token => createHash('sha256').update(token).digest('hex');
export class DurableBridge {
  constructor({ state, sessions = [], routes = {}, clock = () => Date.now() }) {
    this.state = state; this.routes = Object.freeze({ ...routes }); this.clock = clock;
    state.database.transaction(() => {
      for (const { token, expires_at, ...session } of sessions) {
        requireRuntime(Number.isFinite(expires_at), 'INVALID_SESSION', 'Durable Bridge sessions require expiry');
        new Bridge({ sessions: [{ token, ...session }], routes: {} }); // Keep existing schema/grant checks.
        const grant = canonical({ kind: 'bridge', session, expires_at }), key = hashToken(token);
        const prior = state.database.db.prepare('SELECT grant_json FROM sessions WHERE token_hash=?').get(key);
        requireRuntime(!prior || prior.grant_json === grant, 'SESSION_CONFLICT', 'Bridge grant cannot be silently replaced');
        if (!prior) state.database.db.prepare('INSERT INTO sessions(token_hash,grant_json) VALUES(?,?)').run(key, grant);
      }
    });
  }
  #session(token) {
    const row = this.state.database.db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(hashToken(token));
    const grant = row ? JSON.parse(row.grant_json) : null;
    requireRuntime(grant?.kind === 'bridge' && !row.revoked && grant.expires_at > this.clock(), 'UNAUTHENTICATED', 'Durable Bridge session is unavailable');
    return grant.session;
  }
  async send(token, envelope) {
    const session = this.#session(token);
    const bridge = new Bridge({ sessions: [{ token, ...session }], routes: Object.fromEntries(Object.entries(this.routes).map(([type, handler]) => [type, async message => {
      const key = canonical(['bridge', session.id, envelope.message_id]);
      const prior = await this.state.claim(key, digest(envelope), { task_id: envelope.task_id });
      if (!prior.claimed) {
        requireRuntime(prior.status === 'SETTLED' && prior.result.ok, 'DELIVERY_UNCERTAIN', 'Previous delivery is uncertain; do not redeliver blindly'); return;
      }
      try { await handler(message); await this.state.settle(key, { ok: true }); }
      catch (error) { await this.state.settle(key, { ok: false, code: 'DELIVERY_UNCERTAIN' }); throw error; }
    }])) });
    return bridge.send(token, envelope);
  }
  async queue(token, envelope) {
    const session = this.#session(token), id = digest(['bridge-outbox', session.id, envelope.message_id]);
    const bridge = new Bridge({ sessions: [{ token, ...session }], routes: Object.fromEntries(session.allowed_types.map(type => [type,
      async ({ actor, envelope: message }) => this.state.enqueue(id, message.task_id, { kind: 'bridge', actor, envelope: message })])) });
    await bridge.send(token, envelope); return { id };
  }
  async flush(taskId, deliver, { retryUncertain = false } = {}) {
    const outcomes = [];
    for (const entry of await this.state.outbox(taskId)) {
      if (entry.payload.kind !== 'bridge' || entry.status === 'DELIVERED') continue;
      let status = entry.status;
      if (status === 'SENDING') {
        await this.state.markOutbox(entry.id, 'SENDING', 'UNCERTAIN'); status = 'UNCERTAIN';
      }
      if (status === 'UNCERTAIN' && !retryUncertain) { outcomes.push({ id: entry.id, status: 'UNCERTAIN' }); continue; }
      await this.state.markOutbox(entry.id, status, 'SENDING');
      try {
        await deliver(jsonCopy({ idempotency_key: entry.id, ...entry.payload }));
        await this.state.markOutbox(entry.id, 'SENDING', 'DELIVERED'); outcomes.push({ id: entry.id, status: 'DELIVERED' });
      } catch {
        await this.state.markOutbox(entry.id, 'SENDING', 'UNCERTAIN'); outcomes.push({ id: entry.id, status: 'UNCERTAIN' });
      }
    }
    return outcomes;
  }
}
