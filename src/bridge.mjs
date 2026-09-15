import { assert, check, immutable } from './contracts.mjs';
import { canonical, digest, AuditLog } from './audit.mjs';

const senders = {
  DISCOVERY_REQUEST: ['human', 'chatgpt', 'codex'], DISCOVERY_REPORT: ['codex'],
  DESIGN_PROPOSAL: ['human', 'chatgpt', 'codex'], DECISION_REQUEST: ['human', 'chatgpt', 'codex'], DESIGN_DECISION: ['human'],
  IMPLEMENT_REQUEST: ['human', 'chatgpt', 'codex'], IMPLEMENT_REPORT: ['codex'],
  REVIEW_REQUEST: ['human', 'chatgpt', 'codex'], REVIEW_RESULT: ['human', 'chatgpt', 'codex'],
  CHANGE_PROPOSAL: ['human', 'chatgpt', 'codex'], REPLAN_PROPOSAL: ['human', 'chatgpt', 'codex'], BLOCKED_REPORT: ['human', 'chatgpt', 'codex'],
};

// Host installs authenticated session grants and transport destinations. The bridge
// validates and forwards; recipients still apply Decision / Lifecycle policy.
export class Bridge {
  #sessions = new Map(); #routes; #messages = new Map(); #keys = new Map(); #audit;
  constructor({ sessions, routes, audit = new AuditLog() }) {
    this.#audit = audit; this.#routes = new Map(Object.entries(routes));
    for (const session of sessions) {
      check('Principal', session.actor); check('Repository', session.repository);
      assert(typeof session.token === 'string' && session.token.length >= 16 && !this.#sessions.has(session.token), 'INVALID_SESSION', 'Session tokens must be unique and at least 16 characters');
      assert(typeof session.id === 'string' && session.id.length > 0 && ![...this.#sessions.values()].some(s => s.id === session.id), 'INVALID_SESSION', 'Session IDs must be unique');
      assert(typeof session.task_id === 'string' && session.task_id && Array.isArray(session.allowed_types) && session.allowed_types.every(t => Object.hasOwn(senders, t)), 'INVALID_SESSION', 'Session needs a task and valid message grants');
      const { token, ...grant } = session; this.#sessions.set(token, immutable(grant));
    }
  }
  async send(token, envelope) {
    const session = this.#sessions.get(token);
    assert(session, 'UNAUTHENTICATED', 'No authenticated session'); check('Envelope', envelope);
    const message = immutable(envelope);
    assert(session.allowed_types.includes(message.message_type) && senders[message.message_type].includes(session.actor.role), 'AUTHORITY_BOUNDARY_EXCEEDED', 'Session cannot send this message type');
    assert(message.task_id === session.task_id && canonical(message.repository) === canonical(session.repository), 'SESSION_SCOPE_EXCEEDED', 'Task / repository does not match session grant');
    if (message.message_type === 'REVIEW_RESULT') {
      assert(canonical(message.payload.reviewer) === canonical(session.actor), 'AUTHORITY_BOUNDARY_EXCEEDED', 'Review sender cannot impersonate another participant');
      assert(message.payload.review_level !== 'R3' || ['chatgpt', 'human'].includes(session.actor.role), 'AUTHORITY_BOUNDARY_EXCEEDED', 'R3 requires an independent architecture reviewer');
    }
    const handler = this.#routes.get(message.message_type);
    assert(typeof handler === 'function', 'ROUTE_UNAVAILABLE', 'No transport destination installed');
    const hash = digest(message);
    const id = canonical([session.id, message.message_id]);
    const key = message.idempotency_key ? canonical([session.id, message.idempotency_key]) : null;
    const prior = this.#messages.get(id) ?? (key ? this.#keys.get(key) : undefined);
    if (prior) { assert(prior.hash === hash, 'IDEMPOTENCY_CONFLICT', 'A message ID / idempotency key cannot be reused for different content'); return prior.promise; }
    // Install the in-flight record before delivery, covering concurrent retries.
    const record = { hash, promise: null };
    record.promise = Promise.resolve().then(async () => {
      this.#audit.append('MESSAGE_FORWARDED', session.actor, { session_id: session.id, envelope: message });
      try {
        await handler(immutable({ actor: session.actor, session_id: session.id, envelope: message }));
        const receipt = immutable({ message_id: message.message_id, delivered: true });
        this.#audit.append('MESSAGE_DELIVERED', session.actor, receipt); return receipt;
      } catch {
        this.#audit.append('DELIVERY_UNCERTAIN', session.actor, { message_id: message.message_id });
        assert(false, 'DELIVERY_UNCERTAIN', 'Recipient failed; resolve delivery outcome before issuing a new request. Retrying this message will not redeliver it.');
      }
    });
    this.#messages.set(id, record); if (key) this.#keys.set(key, record);
    return record.promise;
  }
  get audit() { return this.#audit.entries; }
}
