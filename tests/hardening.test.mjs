import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ExecutionLifecycle, CodexAdapter, check, errorsFor, CONTRACT, DEFAULT_ALLOWED, discover } from '../src/index.mjs';
import { approvalFixture, operationFixture, discoveryFixture, reportFixture, reviewFixture, human, codex } from '../examples/fixtures.mjs';

const raises = code => error => error.code === code;
const exec = promisify(execFile);
function planned() {
  const controller = new ExecutionLifecycle({ decision: approvalFixture() });
  controller.observe(codex, discoveryFixture()); controller.plan(codex, { summary: 'Bounded plan', operations: [operationFixture()] }); return controller;
}
function verifying() {
  const controller = planned(); controller.begin(codex, { fingerprint: controller.snapshot.discovery.fingerprint });
  controller.report(codex, reportFixture(controller)); return controller;
}
async function adapters() {
  const repository = await mkdtemp(join(tmpdir(), 'cccp-hardening-')); await mkdir(join(repository, 'src'));
  const controller = new ExecutionLifecycle({ decision: approvalFixture({ repository }) });
  const discovery = async () => discoveryFixture(repository);
  const first = new CodexAdapter({ controller, actor: codex, discovery });
  const second = new CodexAdapter({ controller, actor: codex, discovery });
  await first.discover(); controller.plan(codex, { summary: 'Two operations', operations: [operationFixture(), operationFixture({ id: 'op-2' })] }); await first.begin();
  return { controller, first, second, repository, discovery };
}

test('a new block cannot erase an unresolved authority boundary', () => {
  const controller = planned(); controller.block(codex, 'AUTHORITY_BOUNDARY_EXCEEDED', 'Push not authorized');
  controller.block(codex, 'MISSING_INFORMATION', 'Need one more detail');
  assert.throws(() => controller.resume(codex, { resolution: 'Detail supplied' }), raises('NEW_AUTHORIZATION_REQUIRED'));
  assert.equal(controller.state, 'BLOCKED');
});
test('a new block cannot erase loop protection', () => {
  const controller = planned(); controller.block(codex, 'LOOP_PROTECTION', 'Budget exhausted');
  controller.block(codex, 'REPOSITORY_FAILURE', 'Workspace changed');
  assert.throws(() => controller.resume(codex, { resolution: 'Rescanned', discovery: discoveryFixture() }), raises('LOOP_PROTECTION'));
});
test('Specification blocks retain the Human resolution requirement', () => {
  const controller = planned(); controller.block(codex, 'SPECIFICATION_FAILURE', 'Conflicting requirements');
  controller.block(codex, 'MISSING_INFORMATION', 'Detail missing');
  assert.throws(() => controller.resume(codex, { resolution: 'I guessed' }), raises('AUTHORITY_BOUNDARY_EXCEEDED'));
});
test('Codex cannot resume a Human termination even after another block', () => {
  const controller = planned(); controller.override(human, 'Stop work');
  controller.block(codex, 'MISSING_INFORMATION', 'Additional observation');
  assert.throws(() => controller.resume(codex, { resolution: 'Continue anyway' }), raises('AUTHORITY_BOUNDARY_EXCEEDED'));
  controller.resume(human, { resolution: 'Explicitly resume work' }); assert.equal(controller.state, 'IMPLEMENTATION_PLANNED');
});
test('Codex cannot leave a Human termination through Replan', () => {
  const controller = planned(); controller.override(human, 'Stop work');
  assert.throws(() => controller.requestReplan(codex, { id: 'change', decision_id: controller.snapshot.decision_id, problem: 'Need another approach', suggested_change: 'Discuss', trade_offs: [], affected_boundaries: [], evidence: [] }), raises('AUTHORITY_BOUNDARY_EXCEEDED'));
  assert.equal(controller.state, 'BLOCKED');
});
test('recreated adapters cannot repeat an attempted operation', async () => {
  const { first, second } = await adapters(); let calls = 0;
  await first.execute('op-1', () => { calls++; });
  await assert.rejects(second.execute('op-1', () => { calls++; }), raises('OPERATION_ALREADY_ATTEMPTED')); assert.equal(calls, 1);
});
test('all adapters for a controller share the execution lock', async () => {
  const { first, second } = await adapters(); let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const pending = first.execute('op-1', () => barrier);
  try { await assert.rejects(second.execute('op-2', () => {}), raises('OPERATION_IN_PROGRESS')); }
  finally { release(); await pending; }
});
test('an in-flight operation prevents reporting completion', async () => {
  const { first, controller } = await adapters(); let release;
  const barrier = new Promise(resolve => { release = resolve; }); const pending = first.execute('op-1', () => barrier);
  try { assert.throws(() => controller.report(codex, reportFixture(controller)), raises('OPERATION_IN_PROGRESS')); }
  finally { release(); await pending; }
});
test('a different Codex identity cannot execute the active implementer plan', async () => {
  const { controller, discovery } = await adapters();
  const other = new CodexAdapter({ controller, actor: { id: 'other-codex', role: 'codex' }, discovery });
  let called = false;
  await assert.rejects(other.execute('op-1', () => { called = true; }), raises('AUTHORITY_BOUNDARY_EXCEEDED'));
  assert.equal(called, false);
});
test('Human stop during a running callback remains effective when it settles', async () => {
  const { controller, first } = await adapters(); let release; let entered;
  const started = new Promise(resolve => { entered = resolve; }); const barrier = new Promise(resolve => { release = resolve; });
  const pending = first.execute('op-1', () => { entered(); return barrier; });
  await started; controller.override(human, 'Stop during tool execution'); release();
  await assert.rejects(pending, raises('EXECUTION_INTERRUPTED'));
  assert.equal(controller.state, 'BLOCKED');
});
test('Schema names and references cannot resolve inherited Object properties', () => {
  assert.throws(() => check('constructor', {}), /Unknown contract/);
  assert.throws(() => errorsFor({ $ref: '#/$defs/__proto__' }, {}), /Unsupported schema reference/);
});
test('Review evidence must contain actual text', () => {
  const controller = verifying();
  assert.throws(() => controller.applyReview(codex, reviewFixture(controller, 'R1', { evidence: [' \t\n'] })), raises('INVALID_SCHEMA'));
  assert.equal(controller.state, 'VERIFYING');
});
test('sparse arrays cannot fabricate Review evidence', () => {
  const controller = verifying();
  assert.throws(() => controller.applyReview(codex, reviewFixture(controller, 'R1', { evidence: new Array(1) })), raises('INVALID_SCHEMA'));
});
test('invalid calendar dates cannot be normalized into valid timestamps', () => {
  assert.throws(() => check('Discovery', discoveryFixture(process.cwd(), { observed_at: '2026-02-31T00:00:00Z' })), raises('INVALID_SCHEMA'));
  assert.doesNotThrow(() => check('Discovery', discoveryFixture(process.cwd(), { observed_at: '2024-02-29T00:00:00+08:00' })));
});
test('exported schemas and default policy constants cannot be mutated', () => {
  assert.equal(Object.isFrozen(CONTRACT.$defs.Profile), true);
  assert.equal(Object.isFrozen(DEFAULT_ALLOWED), true);
});
test('changing only staged content changes the Discovery fingerprint', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'cccp-index-')); await mkdir(join(repository, 'src'));
  const file = join(repository, 'src', 'example.mjs');
  const git = args => exec('git', ['-C', repository, ...args], { windowsHide: true });
  await git(['init', '-b', 'main']); await writeFile(file, 'baseline'); await git(['add', '.']);
  await git(['-c', 'user.name=CCCP Test', '-c', 'user.email=cccp-test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
  await writeFile(file, 'staged-one'); await git(['add', '.']); await writeFile(file, 'working-tree'); const first = await discover(repository);
  await writeFile(file, 'staged-two'); await git(['add', '.']); await writeFile(file, 'working-tree'); const second = await discover(repository);
  assert.deepEqual(first.changed_files, second.changed_files); assert.notEqual(first.fingerprint, second.fingerprint);
});
