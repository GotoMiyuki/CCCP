import { ExecutionLifecycle, Bridge, AuditLog, MESSAGE_TYPES } from '../src/index.mjs';
import { approvalFixture, operationFixture, discoveryFixture, reportFixture, reviewFixture, codex } from './fixtures.mjs';

const decision = approvalFixture();
const execution = new ExecutionLifecycle({ decision });
const discovery = discoveryFixture();
execution.observe(codex, discovery);
execution.plan(codex, { summary: 'Synthetic low-risk bounded implementation', operations: [operationFixture()] });
execution.begin(codex, { fingerprint: discovery.fingerprint });
execution.report(codex, reportFixture(execution));
const bridge = new Bridge({ sessions: [{ id: 'demo', token: 'synthetic-demo-session-token', actor: codex, task_id: 'demo-task', repository: discovery.repository, allowed_types: MESSAGE_TYPES }],
  routes: { REVIEW_RESULT: ({ actor, envelope }) => execution.applyReview(actor, envelope.payload) } });
for (const level of ['R1', 'R2']) {
  const message = { protocol: 'CCCP', version: '1.0', message_type: 'REVIEW_RESULT', message_id: `message-${level}`, task_id: 'demo-task', timestamp: new Date().toISOString(), repository: discovery.repository,
    payload: reviewFixture(execution, level), idempotency_key: `demo-${level}` };
  await bridge.send('synthetic-demo-session-token', message);
  await bridge.send('synthetic-demo-session-token', message); // Exact retry is not applied twice.
}
execution.route(codex);
console.log(JSON.stringify({ notice: 'SIMULATION ONLY: synthetic Human approval, Discovery and Review evidence', state: execution.state, routing: execution.snapshot.routing,
  revision_count: execution.snapshot.revision_count, audit_valid: AuditLog.verify(execution.audit), messages_delivered: bridge.audit.filter(e => e.type === 'MESSAGE_DELIVERED').length }, null, 2));
