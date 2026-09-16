import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Bridge, MESSAGE_TYPES, ExecutionLifecycle, CodexAdapter, discover, confinedPath, check, DecisionLifecycle } from '../src/index.mjs';
import { approvalFixture, operationFixture, reportFixture, human, codex, chatgpt, reviewFixture } from '../examples/fixtures.mjs';

const exec = promisify(execFile);
const raises = code => error => error.code === code;
const repository = { path: process.cwd(), branch: null, commit: null };
const token = 'test-session-secret-not-a-production-token';
const session = (actor = codex) => ({ id: 's1', token, actor, task_id: 'task-1', repository, allowed_types: MESSAGE_TYPES });
const message = (patch = {}) => ({ protocol: 'CCCP', version: '1.0', message_type: 'DISCOVERY_REQUEST', message_id: 'message-1', task_id: 'task-1', timestamp: '2026-09-15T00:00:00Z', repository, payload: { related_paths: ['src'] }, idempotency_key: 'retry-1', ...patch });

test('Bridge authenticates session and does not infer authority from message content', async () => {
  let calls = 0;
  const bridge = new Bridge({ sessions: [session()], routes: { DISCOVERY_REQUEST: () => { calls++; } } });
  await assert.rejects(bridge.send('wrong', message()), raises('UNAUTHENTICATED'));
  await assert.rejects(bridge.send(token, message({ actor: human })), raises('INVALID_SCHEMA'));
  assert.equal(calls, 0);
});
test('Bridge rejects AI DESIGN_DECISION even if session lists that type', async () => {
  let delivered = false;
  const bridge = new Bridge({ sessions: [session()], routes: { DESIGN_DECISION: () => { delivered = true; } } });
  await assert.rejects(bridge.send(token, message({ message_type: 'DESIGN_DECISION', payload: approvalFixture().snapshot.decision })), raises('AUTHORITY_BOUNDARY_EXCEEDED'));
  assert.equal(delivered, false);
});
test('Bridge forwards Human Decision without itself creating execution or granting autonomy', async () => {
  let forwarded;
  const bridge = new Bridge({ sessions: [session(human)], routes: { DESIGN_DECISION: value => { forwarded = value; } } });
  const envelope = message({ message_type: 'DESIGN_DECISION', payload: approvalFixture().snapshot.decision });
  await bridge.send(token, envelope); assert.deepEqual(forwarded.envelope, envelope); assert.deepEqual(forwarded.actor, human);
  assert.equal(bridge.state, undefined);
});
test('Bridge enforces task and repository snapshot grants', async () => {
  const bridge = new Bridge({ sessions: [session()], routes: { DISCOVERY_REQUEST: () => {} } });
  await assert.rejects(bridge.send(token, message({ task_id: 'other' })), raises('SESSION_SCOPE_EXCEEDED'));
  await assert.rejects(bridge.send(token, message({ repository: { ...repository, commit: 'ungranted-commit' } })), raises('SESSION_SCOPE_EXCEEDED'));
});
test('Bridge concurrent exact retries deliver once and return the same receipt', async () => {
  let deliveries = 0;
  const bridge = new Bridge({ sessions: [session()], routes: { DISCOVERY_REQUEST: async () => { deliveries++; await new Promise(resolve => setTimeout(resolve, 5)); } } });
  const results = await Promise.all(Array.from({ length: 12 }, () => bridge.send(token, message())));
  assert.equal(deliveries, 1); assert.ok(results.every(r => r.delivered));
  assert.equal(bridge.audit.filter(e => e.type === 'MESSAGE_FORWARDED').length, 1);
  assert.equal(JSON.stringify(bridge.audit).includes(token), false);
});
test('Bridge retries cannot reuse an identity for different content', async () => {
  const bridge = new Bridge({ sessions: [session()], routes: { DISCOVERY_REQUEST: () => {} } });
  await bridge.send(token, message());
  await assert.rejects(bridge.send(token, message({ payload: { related_paths: ['different'] } })), raises('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(bridge.send(token, message({ message_id: 'different-id' })), raises('IDEMPOTENCY_CONFLICT'));
});
test('uncertain delivery is audited and never blindly executed again', async () => {
  let deliveries = 0;
  const bridge = new Bridge({ sessions: [session()], routes: { DISCOVERY_REQUEST: () => { deliveries++; throw new Error('failed after side effect'); } } });
  await assert.rejects(bridge.send(token, message()), raises('DELIVERY_UNCERTAIN'));
  await assert.rejects(bridge.send(token, message()), raises('DELIVERY_UNCERTAIN')); assert.equal(deliveries, 1);
  assert.ok(bridge.audit.some(e => e.type === 'DELIVERY_UNCERTAIN'));
});
test('Bridge checks grants, installed routes, protocol version and Review identity', async () => {
  const limited = new Bridge({ sessions: [{ ...session(), allowed_types: [] }], routes: {} });
  await assert.rejects(limited.send(token, message()), raises('AUTHORITY_BOUNDARY_EXCEEDED'));
  const bridge = new Bridge({ sessions: [session()], routes: { REVIEW_RESULT: () => {} } });
  await assert.rejects(bridge.send(token, message()), raises('ROUTE_UNAVAILABLE'));
  await assert.rejects(bridge.send(token, message({ version: '1.1' })), raises('INVALID_SCHEMA'));
  const review = { id: 'r', report_id: 'report', review_level: 'R3', reviewer: chatgpt, decision: 'APPROVE', confidence: 1, findings: [], evidence: ['e'], failed_requirements: [], requirements: [], implementation_status: 'pass', specification_compliance: 'pass', architecture_compliance: 'pass', boundary_violation: false, reason: 'Pass' };
  await assert.rejects(bridge.send(token, message({ message_type: 'REVIEW_RESULT', payload: review })), raises('AUTHORITY_BOUNDARY_EXCEEDED'));
});

async function temporaryRepository() {
  const directory = await mkdtemp(join(tmpdir(), 'cccp-test-'));
  await mkdir(join(directory, 'src')); await writeFile(join(directory, 'src', 'example.mjs'), 'export const value = 1;\n');
  return directory;
}
test('real non-Git discovery reports unknown tests and fingerprints content changes', async () => {
  const directory = await temporaryRepository(); const first = await discover(directory);
  assert.equal(first.working_tree_status, 'not_git'); assert.equal(first.repository.commit, null); assert.equal(first.test_status, 'unknown');
  assert.deepEqual(first.related_files, ['src/example.mjs']);
  await writeFile(join(directory, 'src', 'example.mjs'), 'export const value = 2;\n'); const second = await discover(directory);
  assert.notEqual(first.fingerprint, second.fingerprint); assert.equal(second.fingerprint, (await discover(directory)).fingerprint);
});
test('Git discovery handles unborn, dirty, clean and detached HEAD without changing repository', async () => {
  const directory = await temporaryRepository();
  const git = args => exec('git', ['-C', directory, ...args], { windowsHide: true });
  await git(['init', '-b', 'main']); const unborn = await discover(directory);
  assert.equal(unborn.repository.branch, 'main'); assert.equal(unborn.repository.commit, null); assert.equal(unborn.working_tree_status, 'dirty');
  await git(['add', 'src/example.mjs']); await git(['-c', 'user.name=CCCP Test', '-c', 'user.email=cccp-test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'test fixture']);
  const clean = await discover(directory); assert.equal(clean.working_tree_status, 'clean'); assert.match(clean.repository.commit, /^[0-9a-f]{40,64}$/);
  await git(['checkout', '--detach']); const detached = await discover(directory); assert.equal(detached.repository.branch, null); assert.equal(detached.repository.commit, clean.repository.commit);
  await writeFile(join(directory, 'src', 'example.mjs'), 'export const value = 3;\n'); const dirty = await discover(directory);
  assert.equal(dirty.working_tree_status, 'dirty'); assert.ok(dirty.changed_files.includes('src/example.mjs')); assert.notEqual(dirty.fingerprint, detached.fingerprint);
});
test('Git renamed filenames with spaces are parsed as paths', async () => {
  const directory = await temporaryRepository(); const git = args => exec('git', ['-C', directory, ...args], { windowsHide: true });
  await git(['init', '-b', 'main']); await git(['add', '.']);
  await git(['-c', 'user.name=CCCP Test', '-c', 'user.email=cccp-test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'test fixture']);
  await git(['mv', 'src/example.mjs', 'src/renamed example.mjs']);
  const result = await discover(directory); assert.ok(result.changed_files.includes('src/renamed example.mjs')); assert.ok(result.changed_files.includes('src/example.mjs'));
});
test('stale Context is recorded as a conflict; it cannot substitute for discovery', async () => {
  const directory = await temporaryRepository();
  const context = [{ id: 'old', kind: 'REPOSITORY_FACT', content: 'Old snapshot', source_commit: 'old-commit', updated_at: '2026-09-15T00:00:00Z', generated_by: codex, status: 'current' }];
  const result = await discover(directory, { context }); assert.equal(result.context_conflicts.length, 1);
});
test('filesystem confinement rejects parent paths and symlink escapes', async () => {
  const directory = await temporaryRepository(); const outside = await temporaryRepository();
  await assert.rejects(confinedPath(directory, '../secret'), raises('INVALID_PATH'));
  await symlink(outside, join(directory, 'src', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(confinedPath(directory, 'src/escape/new-file'), raises('INVALID_PATH'));
  const result = await discover(directory); assert.ok(result.related_files.includes('src/escape')); assert.equal(result.related_files.includes('src/escape/src/example.mjs'), false);
});
test('adapter executes a declared operation and completes the real-file low-risk workflow', async () => {
  const directory = await temporaryRepository(); const e = new ExecutionLifecycle({ decision: approvalFixture({ repository: directory }) });
  const adapter = new CodexAdapter({ controller: e, actor: codex }); await adapter.discover();
  e.plan(codex, { summary: 'Change a private constant', operations: [operationFixture()] }); await adapter.begin();
  await adapter.execute('op-1', async operation => { assert.equal(operation.domain, 'internal_implementation'); await writeFile(join(directory, 'src', 'example.mjs'), 'export const value = 4;\n'); });
  assert.equal(await readFile(join(directory, 'src', 'example.mjs'), 'utf8'), 'export const value = 4;\n');
  await assert.rejects(adapter.execute('op-1', () => {}), raises('OPERATION_ALREADY_ATTEMPTED'));
  e.report(codex, reportFixture(e)); e.applyReview(codex, reviewFixture(e, 'R1')); e.applyReview(codex, reviewFixture(e, 'R2')); e.route(codex); assert.equal(e.state, 'DONE');
});
test('adapter accepts Discovery canonical paths for a symlinked repository alias', async () => {
  const directory = await temporaryRepository(); const alias = `${directory}-alias`;
  await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const e = new ExecutionLifecycle({ decision: approvalFixture({ repository: alias }) });
  const result = await new CodexAdapter({ controller: e, actor: codex }).discover();
  assert.equal(e.snapshot.discovery.repository.path, result.repository.path);
});
test('adapter cannot override fresh fingerprint or start after an unexpected file edit', async () => {
  const directory = await temporaryRepository(); const e = new ExecutionLifecycle({ decision: approvalFixture({ repository: directory }) });
  const adapter = new CodexAdapter({ controller: e, actor: codex }); const before = await adapter.discover();
  e.plan(codex, { summary: 'Plan', operations: [operationFixture()] }); await writeFile(join(directory, 'src', 'example.mjs'), 'changed externally');
  await adapter.begin({ fingerprint: before.fingerprint }); assert.equal(e.state, 'BLOCKED');
  await assert.rejects(adapter.execute('op-1', () => { throw new Error('must not execute'); }), raises('INVALID_TRANSITION'));
});
test('adapter rejects unplanned operations and serializes in-flight callbacks', async () => {
  const directory = await temporaryRepository(); const e = new ExecutionLifecycle({ decision: approvalFixture({ repository: directory }) });
  const adapter = new CodexAdapter({ controller: e, actor: codex }); await adapter.discover();
  e.plan(codex, { summary: 'Plan', operations: [operationFixture(), operationFixture({ id: 'op-2' })] }); await adapter.begin();
  await assert.rejects(adapter.execute('unknown', () => {}), raises('INVALID_OPERATION'));
  let release; const barrier = new Promise(resolve => { release = resolve; });
  const pending = adapter.execute('op-1', () => barrier);
  await assert.rejects(adapter.execute('op-2', () => {}), raises('OPERATION_IN_PROGRESS')); release(); await pending;
});
test('adapter failures block and retain the attempted operation identity', async () => {
  const directory = await temporaryRepository(); const e = new ExecutionLifecycle({ decision: approvalFixture({ repository: directory }) });
  const adapter = new CodexAdapter({ controller: e, actor: codex }); await adapter.discover(); e.plan(codex, { summary: 'Plan', operations: [operationFixture()] }); await adapter.begin();
  await assert.rejects(adapter.execute('op-1', () => { throw new Error('Tool failed'); }), /Tool failed/); assert.equal(e.state, 'BLOCKED');
  e.resume(codex, { resolution: 'Tool recovered and Reality checked', discovery: await discover(directory) });
  e.plan(codex, { summary: 'Recovered plan', operations: [operationFixture()] }); await adapter.begin();
  await assert.rejects(adapter.execute('op-1', () => {}), raises('OPERATION_ALREADY_ATTEMPTED'));
});
test('adapter reports inaccessible Reality as BLOCKED', async () => {
  const directory = await temporaryRepository(); const e = new ExecutionLifecycle({ decision: approvalFixture({ repository: directory }) });
  const adapter = new CodexAdapter({ controller: e, actor: codex, discovery: async () => { throw new Error('Repository unavailable'); } });
  await assert.rejects(adapter.discover(), /Repository unavailable/); assert.equal(e.state, 'BLOCKED'); assert.equal(e.snapshot.blocked.category, 'REPOSITORY_FAILURE');
});
test('adapter symlink boundary violations create Change Proposal before any tool call', async () => {
  const directory = await temporaryRepository(); const outside = await temporaryRepository();
  await symlink(outside, join(directory, 'src', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const e = new ExecutionLifecycle({ decision: approvalFixture({ repository: directory }) }); const adapter = new CodexAdapter({ controller: e, actor: codex });
  await adapter.discover(); e.plan(codex, { summary: 'Escaping link', operations: [operationFixture({ paths: ['src/escape/new-file'] })] }); await adapter.begin();
  let called = false; await assert.rejects(adapter.execute('op-1', () => { called = true; }), raises('INVALID_PATH'));
  assert.equal(called, false); assert.equal(e.state, 'BLOCKED'); assert.ok(e.snapshot.change_proposal);
});
test('Directed mode accepts an explicit Human design without fabricated deliberation', () => {
  const snapshot = approvalFixture().snapshot;
  const directed = DecisionLifecycle.directed({ ...snapshot, actor: human }); assert.equal(directed.state, 'DELEGATED');
  assert.equal(directed.audit.some(e => e.data.mode === 'Directed'), true);
  assert.equal(directed.audit.some(e => e.data.to === 'DELIBERATION'), false);
  assert.throws(() => DecisionLifecycle.directed({ ...snapshot, actor: codex }), raises('AUTHORITY_BOUNDARY_EXCEEDED'));
});
test('emitted schemas are valid JSON and match the checked-in schema source', async () => {
  const result = await exec(process.execPath, ['scripts/export-schemas.mjs', '--check'], { cwd: process.cwd(), windowsHide: true });
  assert.match(result.stdout, /Checked 9/);
  const schema = JSON.parse(await readFile(new URL('../schemas/message-envelope.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.$ref, '#/$defs/Envelope'); check('Envelope', message());
});
