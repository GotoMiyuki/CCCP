import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteDatabase, SqliteStateStore, DurableBridge } from '../src/index.mjs';
import { durableFixture } from './fixtures/durable-host.mjs';

const exec = promisify(execFile), fixture = fileURLToPath(new URL('./fixtures/crash-host.mjs', import.meta.url));
const paths = [];
after(async () => { for (const path of paths) await rm(path, { recursive: true, force: true }); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'cccp-crash-')); paths.push(path); await mkdir(join(path, 'repo', 'src'), { recursive: true }); return path; }
async function killed(phase, path) {
  try { await exec(process.execPath, [fixture, phase, path], { windowsHide: true, timeout: 15000 }); assert.fail('Child should have been killed'); }
  catch (error) { assert.match(error.stdout ?? '', new RegExp(`CRASH:${phase}`), error.stderr); }
}
const raises = code => error => error.code === code;

for (const phase of ['approval_before', 'approval_after']) test(`real process kill ${phase} does not fabricate or lose committed approval`, async t => {
  const path = await directory(); await killed(phase, path);
  const sim = await durableFixture(path, { start: false }); t.after(() => sim.database.close());
  if (phase === 'approval_before') assert.equal(await sim.providers.state.read('durable-task'), null);
  else {
    const recovered = await sim.call('recoverTask', 'human'); assert.equal(recovered.snapshot.state, 'DISCOVERY');
    assert.equal((await sim.providers.state.read('durable-task')).data.approval.approval.actor.role, 'human');
  }
});

test('real kill after a side effect recovers EFFECT_UNKNOWN and cannot rerun the attempted operation', async t => {
  const path = await directory(); await killed('tool_started', path);
  const sim = await durableFixture(path, { start: false, recover: true }); t.after(() => sim.database.close());
  const observed = await sim.call('inspectTask', 'human'); assert.equal(observed.snapshot.state, 'BLOCKED');
  assert.equal(observed.result.operations[0].outcome, 'EFFECT_UNKNOWN'); assert.equal(await readFile(join(path, 'effect.txt'), 'utf8'), 'one effect');
  assert.equal((await sim.providers.state.pending('durable-task')).length, 0);
  await sim.call('resumeTask', 'codex', { resolution: 'Fixture effect inspected; original operation must not repeat' });
  const plan = observed.snapshot.plan;
  await sim.call('planTask', 'codex', plan); await sim.call('beginTask', 'codex');
  await assert.rejects(sim.call('executeTool', 'codex', { operation_id: 'op-1', attempt_id: 'new-attempt' }, { key: 'new-key' }), raises('OPERATION_ALREADY_ATTEMPTED'));
});

test('real kill after R2 commit preserves Review and its settled inbox receipt', async t => {
  const path = await directory(); await killed('r2_after', path);
  const sim = await durableFixture(path, { start: false, recover: true }); t.after(() => sim.database.close());
  const view = await sim.call('inspectTask', 'human'); assert.equal(view.snapshot.state, 'REVIEW_ROUTING'); assert.equal(view.snapshot.reviews.R2.decision, 'APPROVE');
  const rows = sim.database.db.prepare("SELECT * FROM inbox WHERE key LIKE '%submitReview%'").all();
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 'SETTLED'); assert.equal(JSON.parse(rows[0].result).ok, true);
  assert.equal((await sim.call('routeReview', 'codex')).snapshot.state, 'DONE');
});

test('real kill after Human Stop cannot be resumed by Codex after restart', async t => {
  const path = await directory(); await killed('stop_after', path);
  const sim = await durableFixture(path, { start: false, recover: true }); t.after(() => sim.database.close());
  assert.equal((await sim.call('inspectTask', 'human')).snapshot.human_stopped, true);
  await assert.rejects(sim.call('resumeTask', 'codex', { resolution: 'Unapproved restart' }), raises('AUTHORITY_BOUNDARY_EXCEEDED'));
});

test('real kill after outbox delivery leaves UNCERTAIN and retains the stable idempotency key', async t => {
  const path = await directory(); await killed('outbox_after_send', path);
  const database = await SqliteDatabase.open({ path: join(path, 'runtime.sqlite') }); t.after(() => database.close());
  const state = new SqliteStateStore({ database }), bridge = new DurableBridge({ state });
  const deliveredKey = await readFile(join(path, 'delivery.txt'), 'utf8');
  const results = await bridge.flush('outbox-task', async () => assert.fail('Must not silently redeliver'));
  assert.equal(results[0].status, 'UNCERTAIN'); assert.equal(results[0].id, deliveredKey);
});

test('two actual processes using the same old Store revision have exactly one CAS winner', async t => {
  const path = await directory(), database = await SqliteDatabase.open({ path: join(path, 'cas.sqlite') }); t.after(() => database.close());
  await new SqliteStateStore({ database }).create('task', { snapshot: { state_version: 0 } });
  const results = await Promise.all([1, 2].map(() => exec(process.execPath, [fixture, 'cas', path], { windowsHide: true })));
  assert.equal(results.filter(r => r.stdout.includes('CAS_OK')).length, 1); assert.equal(results.filter(r => r.stdout.includes('STORE_CONFLICT')).length, 1);
});
