import test from 'node:test';
import assert from 'node:assert/strict';
import { DecisionLifecycle, ExecutionLifecycle, ContextStore, AuditLog, authorize, defaultProfile, check, CONTRACT, errorsFor, DEFAULT_RESTRICTED } from '../src/index.mjs';
import { approvalFixture, discoveryFixture, operationFixture, reportFixture, reviewFixture, human, codex, chatgpt } from '../examples/fixtures.mjs';

const raises = code => error => error.code === code;
function execution(options) { return new ExecutionLifecycle({ decision: approvalFixture(options) }); }
function implementing(options) {
  const e = execution(options); e.observe(codex, discoveryFixture()); e.plan(codex, { summary: 'Plan', operations: [operationFixture()] });
  e.begin(codex, { fingerprint: e.snapshot.discovery.fingerprint }); return e;
}
function verifying(options, reportPatch) { const e = implementing(options); e.report(codex, reportFixture(e, reportPatch)); return e; }
function routing(options, patch) {
  const e = verifying(options, patch); e.applyReview(codex, reviewFixture(e, 'R1')); e.applyReview(codex, reviewFixture(e, 'R2')); return e;
}
function revise(e, progress = 'New analysis and correction') {
  e.observe(codex, discoveryFixture()); e.begin(codex, { fingerprint: e.snapshot.discovery.fingerprint, progress }); e.report(codex, reportFixture(e));
}

test('Human approval is required; consensus and Bridge cannot approve', () => {
  for (const actor of [codex, chatgpt, { id: 'bridge', role: 'bridge' }]) {
    const flow = new DecisionLifecycle({ intent: { id: 'i', objective: 'goal' }, profile: defaultProfile(process.cwd()), actor: human });
    flow.propose(codex, { id: 'p', intent_id: 'i', approach: 'a', trade_offs: [], alternatives: [] });
    flow.deliberate(chatgpt, 'Both AIs agree'); flow.requestDecision(codex);
    assert.throws(() => flow.approve(actor, approvalFixture().snapshot.decision), raises('AUTHORITY_BOUNDARY_EXCEEDED'));
    assert.equal(flow.state, 'DECISION_PENDING');
  }
});
test('Human owns Intent and Profile authorization', () => {
  assert.throws(() => new DecisionLifecycle({ intent: { id: 'i', objective: 'x' }, profile: defaultProfile('.'), actor: codex }), raises('AUTHORITY_BOUNDARY_EXCEEDED'));
});
test('execution cannot begin from Proposal or a forged serialized approval', () => {
  assert.throws(() => new ExecutionLifecycle({ decision: approvalFixture().snapshot }), raises('DECISION_NOT_READY'));
  const flow = new DecisionLifecycle({ intent: { id: 'i', objective: 'x' }, profile: defaultProfile('.'), actor: human });
  assert.throws(() => new ExecutionLifecycle({ decision: flow }), raises('DECISION_NOT_READY'));
});
test('approved snapshots and grants are immutable', () => {
  const flow = approvalFixture(); assert.throws(() => flow.snapshot.delegation.allowed.push('push'), TypeError);
  assert.throws(() => { flow.snapshot.decision.goal = 'different'; }, TypeError);
});
test('decision block restores the appropriate stage', () => {
  const flow = new DecisionLifecycle({ intent: { id: 'i', objective: 'x' }, profile: defaultProfile('.'), actor: human });
  flow.block(codex, 'Need detail'); flow.resume(human, 'Detail supplied'); assert.equal(flow.state, 'INTENT');
});
test('schemas reject malformed messages, unknown fields, invalid confidence and protocol versions', () => {
  assert.throws(() => check('Envelope', { protocol: 'CCCP', version: '1.1' }), raises('INVALID_SCHEMA'));
  assert.throws(() => check('Intent', { id: 'i', objective: 'x', approved: true }), raises('INVALID_SCHEMA'));
  const e = verifying(); assert.throws(() => check('ReviewResult', reviewFixture(e, 'R1', { confidence: NaN })), raises('INVALID_SCHEMA'));
  assert.throws(() => check('ReviewResult', reviewFixture(e, 'R1', { confidence: 1.1 })), raises('INVALID_SCHEMA'));
  assert.throws(() => errorsFor({ unsupported: true }, {}), /Unsupported schema keyword/);
  assert.deepEqual(errorsFor({ $ref: '#/$defs/Principal' }, codex), []);
  assert.ok(CONTRACT.$defs.Specification.required.includes('invariants'));
});
for (const domain of DEFAULT_RESTRICTED) test(`default boundary denies ${domain}`, () => {
  const flow = approvalFixture(); assert.equal(authorize(operationFixture({ domain }), flow.snapshot.delegation, flow.snapshot.profile).allowed, false);
});
test('ordinary necessary implementation remains autonomous', () => {
  const flow = approvalFixture({ delegationPatch: { allowed: [] } });
  assert.equal(authorize(operationFixture(), flow.snapshot.delegation, flow.snapshot.profile).allowed, true);
});
test('an explicit deny wins over grants', () => {
  const flow = approvalFixture({ delegationPatch: { forbidden: ['internal_implementation'] } });
  assert.equal(authorize(operationFixture(), flow.snapshot.delegation, flow.snapshot.profile).allowed, false);
});
test('explicit profile override still requires push permission and never approves a changed Decision', () => {
  const profile = defaultProfile(process.cwd()); profile.delegation.forbidden = profile.delegation.forbidden.filter(d => d !== 'push'); profile.delegation.allowed.push('push');
  const delegation = approvalFixture().snapshot.delegation;
  assert.equal(authorize(operationFixture({ domain: 'push' }), delegation, profile).allowed, false);
  profile.permissions.push = true;
  assert.equal(authorize(operationFixture({ domain: 'push' }), delegation, profile).allowed, true);
  assert.equal(authorize(operationFixture({ domain: 'push', changes_decision: true }), delegation, profile).allowed, false);
  delete profile.permissions.push; profile.permissions.harmless = true;
  assert.equal(authorize(operationFixture({ domain: 'push', permission: 'harmless' }), delegation, profile).allowed, false);
});
for (const path of ['../secret', '/etc/passwd', 'C:\\secret', 'src/../../secret', 'src/file:stream']) test(`path cannot escape: ${path}`, () => {
  const flow = approvalFixture(); assert.throws(() => authorize(operationFixture({ paths: [path] }), flow.snapshot.delegation, flow.snapshot.profile), raises('INVALID_PATH'));
});
test('path prefix does not grant similarly named siblings', () => {
  const flow = approvalFixture(); assert.equal(authorize(operationFixture({ paths: ['src-evil/file'] }), flow.snapshot.delegation, flow.snapshot.profile).allowed, false);
});
test('denied operation produces Change Proposal and structured BLOCKED', () => {
  const e = execution(); e.observe(codex, discoveryFixture()); e.plan(codex, { summary: 'Illegal plan', operations: [operationFixture({ domain: 'public_api_change' })] });
  assert.equal(e.state, 'BLOCKED'); check('ChangeProposal', e.snapshot.change_proposal); check('BlockedReport', e.snapshot.blocked);
  assert.equal(e.snapshot.blocked.category, 'AUTHORITY_BOUNDARY_EXCEEDED');
  assert.throws(() => e.resume(codex, { resolution: 'I approve myself' }), raises('NEW_AUTHORIZATION_REQUIRED'));
});
test('escaped plan or report paths become explicit authority escalation', () => {
  const e = execution(); e.observe(codex, discoveryFixture());
  e.plan(codex, { summary: 'Escaping plan', operations: [operationFixture({ paths: ['../secret'] })] });
  assert.equal(e.state, 'BLOCKED'); assert.ok(e.snapshot.change_proposal);
  const implemented = implementing(); implemented.report(codex, reportFixture(implemented, { changed_files: ['../secret'] }));
  assert.equal(implemented.state, 'BLOCKED'); assert.ok(implemented.snapshot.change_proposal);
});
test('discovery is required and stale Reality blocks implementation', () => {
  const e = execution(); assert.throws(() => e.plan(codex, { summary: 'x', operations: [operationFixture()] }), raises('DISCOVERY_REQUIRED'));
  e.observe(codex, discoveryFixture()); e.plan(codex, { summary: 'x', operations: [operationFixture()] }); e.begin(codex, { fingerprint: 'different' });
  assert.equal(e.state, 'BLOCKED'); e.resume(codex, { resolution: 'Re-observed Reality', discovery: discoveryFixture() }); assert.equal(e.state, 'DISCOVERY');
});
test('Discovery cannot silently change the project repository', () => {
  const e = execution(); assert.throws(() => e.observe(codex, discoveryFixture('C:/different-repository')), raises('REPOSITORY_MISMATCH'));
});
test('implementation report cannot silently expand planned file scope', () => {
  const e = implementing(); e.report(codex, reportFixture(e, { changed_files: ['tests/unplanned.mjs'] })); assert.equal(e.state, 'BLOCKED'); assert.ok(e.snapshot.change_proposal);
});
test('R1 alone cannot complete execution or approve R2', () => {
  const e = verifying(); e.applyReview(codex, reviewFixture(e, 'R1')); assert.equal(e.state, 'SPEC_REVIEW');
  assert.throws(() => e.route(codex), raises('INVALID_TRANSITION'));
});
test('review creation has no side effects; controller applies the judgment', () => {
  const e = verifying(); const review = reviewFixture(e, 'R1'); assert.equal(e.state, 'VERIFYING'); e.applyReview(codex, review); assert.equal(e.state, 'SPEC_REVIEW');
});
test('low-risk delegated path passes R1 and R2 and skips R3', () => {
  const e = routing(); assert.equal(e.state, 'REVIEW_ROUTING'); assert.equal(e.route(codex).required, false); assert.equal(e.state, 'DONE');
  assert.equal(e.snapshot.reviews.R3, undefined);
});
for (const patch of [{ implementation_status: 'unknown' }, { implementation_status: 'fail' }, { evidence: [] }]) test(`R1 cannot assume PASS: ${JSON.stringify(patch)}`, () => {
  const e = verifying(); e.applyReview(codex, reviewFixture(e, 'R1', patch)); assert.equal(e.state, 'BLOCKED');
});
test('R2 requires requirement-to-evidence coverage, including constraints and non-goals', () => {
  const e = verifying(); e.applyReview(codex, reviewFixture(e, 'R1'));
  const r = reviewFixture(e, 'R2'); r.requirements = r.requirements.filter(c => c.requirement_id !== 'NG-1'); e.applyReview(codex, r); assert.equal(e.state, 'BLOCKED');
});
test('R2 UNKNOWN never passes; human resolution resumes R2 without rerunning R1', () => {
  const e = verifying(); e.applyReview(codex, reviewFixture(e, 'R1')); const r = reviewFixture(e, 'R2'); r.requirements[0].status = 'unknown'; e.applyReview(codex, r);
  assert.equal(e.state, 'BLOCKED'); assert.throws(() => e.resume(codex, { resolution: 'Guess PASS' }), raises('AUTHORITY_BOUNDARY_EXCEEDED'));
  e.resume(human, { resolution: 'Evidence now provided within the existing specification' }); assert.equal(e.state, 'SPEC_REVIEW');
  e.applyReview(codex, reviewFixture(e, 'R2')); assert.equal(e.state, 'REVIEW_ROUTING');
});
test('unknown and duplicate requirement IDs are rejected without transition', () => {
  const e = verifying(); e.applyReview(codex, reviewFixture(e, 'R1')); const r = reviewFixture(e, 'R2'); r.requirements[0].requirement_id = 'imagined';
  assert.throws(() => e.applyReview(codex, r), raises('INVALID_REVIEW')); assert.equal(e.state, 'SPEC_REVIEW');
});
for (const trigger of ['architecture_sensitive', 'cross_module_responsibility', 'public_api_or_contract', 'near_delegation_boundary', 'significant_plan_deviation', 'uncertain_decision_compliance', 'reality_context_conflict', 'profile_requires_review']) test(`default R3 trigger: ${trigger}`, () => {
  const e = routing(undefined, { triggers: [trigger] }); e.route(codex); assert.equal(e.state, 'ARCHITECTURE_REVIEW');
});
test('R3 also considers risk, deviations and uncertain architecture judgment', () => {
  for (const patch of [{ risk: 'unknown' }, { risk: 'high' }, { unexpected_deviations: ['responsibility moved'] }]) {
    const e = routing(undefined, patch); e.route(codex); assert.equal(e.state, 'ARCHITECTURE_REVIEW');
  }
  const e = verifying(); e.applyReview(codex, reviewFixture(e, 'R1')); e.applyReview(codex, reviewFixture(e, 'R2', { architecture_compliance: 'unknown' })); e.route(codex); assert.equal(e.state, 'ARCHITECTURE_REVIEW');
});
test('Project Profile can customize triggers', () => {
  const profile = defaultProfile(process.cwd()); profile.review.triggers = ['custom_sensitive'];
  const e = routing({ profile }, { triggers: ['architecture_sensitive'] }); e.route(codex); assert.equal(e.state, 'DONE');
  const sensitive = routing({ profile }, { triggers: ['custom_sensitive'] }); sensitive.route(codex); assert.equal(sensitive.state, 'ARCHITECTURE_REVIEW');
});
test('R3 uses an independent reviewer, and profile can require Human acceptance', () => {
  const profile = defaultProfile(process.cwd()); profile.review.human_acceptance = true;
  const e = routing({ profile }); e.route(codex);
  assert.throws(() => e.applyReview(codex, reviewFixture(e, 'R3', { reviewer: codex })), raises('AUTHORITY_BOUNDARY_EXCEEDED'));
  const impersonator = { id: codex.id, role: 'chatgpt' };
  assert.throws(() => e.applyReview(impersonator, reviewFixture(e, 'R3', { reviewer: impersonator })), raises('INDEPENDENCE_REQUIRED'));
  e.applyReview(chatgpt, reviewFixture(e, 'R3')); assert.equal(e.state, 'HUMAN_ACCEPTANCE');
  assert.throws(() => e.accept(codex, 'accept'), raises('AUTHORITY_BOUNDARY_EXCEEDED')); e.accept(human, 'Accepted'); assert.equal(e.state, 'DONE');
});
test('R3 drift can recommend a bounded revision', () => {
  const e = routing(undefined, { triggers: ['architecture_sensitive'] }); e.route(codex);
  e.applyReview(chatgpt, reviewFixture(e, 'R3', { decision: 'REVISION_RECOMMENDED', architecture_compliance: 'fail', reason: 'Restore original responsibilities' })); assert.equal(e.state, 'REVISION');
});
test('R1/R2 implementation failures revise without changing Decision', () => {
  for (const level of ['R1', 'R2']) {
    const e = verifying(); if (level === 'R2') e.applyReview(codex, reviewFixture(e, 'R1'));
    e.applyReview(codex, reviewFixture(e, level, { decision: 'REVISION_RECOMMENDED', reason: 'Fix implementation bug' }));
    assert.equal(e.state, 'REVISION'); const id = e.snapshot.decision_id; revise(e); assert.equal(e.state, 'VERIFYING'); assert.equal(e.snapshot.decision_id, id);
  }
});
test('revision budgets stop automatic retries without changing Architecture', () => {
  const profile = defaultProfile(process.cwd()); profile.review.max_revision_attempts = 2;
  const e = verifying({ profile });
  for (let n = 0; n < 3; n++) {
    e.applyReview(codex, reviewFixture(e, 'R1', { decision: 'REVISION_RECOMMENDED', reason: `failure-${n}`, failure_signature: `failure-${n}` }));
    if (n < 2) { assert.equal(e.state, 'REVISION'); revise(e, `new information ${n}`); }
  }
  assert.equal(e.state, 'BLOCKED'); assert.equal(e.snapshot.revision_count, 2); assert.equal(e.snapshot.blocked.category, 'LOOP_PROTECTION');
  assert.throws(() => e.resume(human, { resolution: 'Reset budget' }), raises('LOOP_PROTECTION'));
});
test('repeated identical failure blocks before budget is exhausted', () => {
  const profile = defaultProfile(process.cwd()); profile.review.max_revision_attempts = 10;
  const e = verifying({ profile }); const patch = { decision: 'REVISION_RECOMMENDED', failure_signature: 'same contract violation' };
  e.applyReview(codex, reviewFixture(e, 'R1', patch)); revise(e); e.applyReview(codex, reviewFixture(e, 'R1', patch)); assert.equal(e.state, 'BLOCKED'); assert.equal(e.snapshot.revision_count, 1);
});
test('revision requires new progress information', () => {
  const e = verifying(); e.applyReview(codex, reviewFixture(e, 'R1', { decision: 'REVISION_RECOMMENDED' }));
  e.begin(codex, { fingerprint: e.snapshot.discovery.fingerprint }); assert.equal(e.state, 'BLOCKED');
});
test('rediscovery during Revision cannot bypass revision count or progress checks', () => {
  const e = verifying(); e.applyReview(codex, reviewFixture(e, 'R1', { decision: 'REVISION_RECOMMENDED' }));
  e.begin(codex, { fingerprint: 'stale', progress: 'new fix' }); assert.equal(e.state, 'BLOCKED');
  e.resume(codex, { resolution: 'Rediscovered after workspace edit', discovery: discoveryFixture() });
  e.plan(codex, { summary: 'Updated plan', operations: [operationFixture()] });
  e.begin(codex, { fingerprint: e.snapshot.discovery.fingerprint, progress: 'new fix' });
  assert.equal(e.state, 'IMPLEMENTING'); assert.equal(e.snapshot.revision_count, 1);
});
test('stale report reviews cannot approve a new implementation', () => {
  const e = verifying(); const old = reviewFixture(e, 'R1'); e.applyReview(codex, reviewFixture(e, 'R1', { decision: 'REVISION_RECOMMENDED' })); revise(e);
  assert.throws(() => e.applyReview(codex, old), raises('STALE_REVIEW')); assert.equal(e.state, 'VERIFYING');
});
test('Replan waits for a new Human Decision, Specification and Delegation', () => {
  const e = verifying(); e.applyReview(codex, reviewFixture(e, 'R1', { decision: 'REPLAN_RECOMMENDED', reason: 'Approved architecture cannot meet objective' }));
  assert.equal(e.state, 'REPLAN_PROPOSED'); assert.ok(e.snapshot.change_proposal);
  assert.throws(() => e.begin(codex, { fingerprint: 'x' }), raises('INVALID_TRANSITION'));
  assert.throws(() => e.adoptDecision(codex, approvalFixture({ suffix: '2' })), raises('AUTHORITY_BOUNDARY_EXCEEDED'));
  assert.throws(() => e.adoptDecision(human, approvalFixture()), raises('NEW_AUTHORIZATION_REQUIRED'));
  e.adoptDecision(human, approvalFixture({ suffix: '2' })); assert.equal(e.state, 'DISCOVERY'); assert.equal(e.snapshot.decision_id, 'decision-2');
});
test('Human override is explicit and never forges review PASS', () => {
  const e = execution(); assert.throws(() => e.override(codex, 'Finish', { state: 'DONE' }), raises('AUTHORITY_BOUNDARY_EXCEEDED'));
  e.override(human, 'Accept using final authority', { state: 'DONE' }); assert.equal(e.state, 'DONE'); assert.deepEqual(e.snapshot.reviews, {});
  assert.ok(e.audit.some(entry => entry.type === 'HUMAN_OVERRIDE')); assert.equal(AuditLog.verify(e.audit), true);
});
test('Context inference cannot be promoted or paraphrased as a Human Decision', () => {
  const store = new ContextStore(); const entry = { id: 'context-1', kind: 'AI_INFERENCE', content: 'AI believes this is approved', source_commit: null, updated_at: new Date().toISOString(), generated_by: codex, status: 'current' };
  store.put(codex, entry); const decision = approvalFixture();
  assert.throws(() => store.put(codex, { ...entry, kind: 'HUMAN_DECISION', decision_id: decision.snapshot.decision.id }, { decision }), raises('CONTEXT_AUTHORITY_CONFLICT'));
  assert.throws(() => store.put(codex, { ...entry, id: 'new', kind: 'HUMAN_DECISION', decision_id: decision.snapshot.decision.id }, { decision }), raises('CONTEXT_AUTHORITY_CONFLICT'));
  store.put(codex, { ...entry, id: 'real-decision', kind: 'HUMAN_DECISION', decision_id: decision.snapshot.decision.id, content: JSON.stringify(decision.snapshot.decision) }, { decision });
  assert.equal(store.freshness('different-commit')[0].needs_discovery, true); assert.equal(store.freshness(null)[0].needs_discovery, true);
});
test('audit entries are immutable and tampering is detectable', () => {
  const e = routing(); e.route(codex); assert.equal(AuditLog.verify(e.audit), true);
  const tampered = structuredClone(e.audit); tampered[0].data.decision.decision.goal = 'changed'; assert.equal(AuditLog.verify(tampered), false);
});
