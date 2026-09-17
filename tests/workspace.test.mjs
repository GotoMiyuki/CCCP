import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { SqliteDatabase, SqliteStateStore, GitWorkspaceManager, effectSnapshot, executionOutcome, discover } from '../src/index.mjs';

const exec = promisify(execFile), dirs = [], raises = code => error => error.code === code;
after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cccp-workspace-')); dirs.push(dir); const repo = join(dir, 'repo');
  await mkdir(join(repo, 'src'), { recursive: true }); await writeFile(join(repo, 'src', 'file.txt'), 'original');
  const git = args => exec('git', args, { cwd: repo, windowsHide: true });
  await git(['init']); await git(['add', '.']); await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  const database = await SqliteDatabase.open({ path: join(dir, 'runtime.sqlite') }); t.after(() => database.close());
  const manager = await GitWorkspaceManager.create({ database, root: join(dir, 'workspaces') });
  return { dir, repo, database, manager };
}
test('Git worktrees pin a commit, preserve binding, share one repository lease and refuse dirty/live cleanup', async t => {
  const { repo, manager } = await fixture(t);
  const a = await manager.register({ workspace_ref: 'a', repository: repo }), b = await manager.register({ workspace_ref: 'b', repository: repo });
  assert.notEqual(a.repository_identity, b.repository_identity); assert.equal(a.repository_ref, b.repository_ref); assert.match(a.base_revision, /^[a-f0-9]{40}$/);
  await manager.createWorkspace('task', 'a'); await assert.rejects(manager.createWorkspace('other', 'a'), raises('WORKSPACE_IN_USE'));
  const lease = await manager.acquireLease(a.repository_identity, 'task', 'write');
  await assert.rejects(manager.acquireLease(b.repository_identity, 'other', 'write'), raises('LEASE_CONFLICT'));
  await assert.rejects(manager.disposeWorkspace('a'), raises('WORKSPACE_IN_USE'));
  assert.equal((await manager.renewLease(lease.lease_id)).lease_id, lease.lease_id); await manager.releaseLease(lease.lease_id);
  await writeFile(join(a.repository_identity, 'src', 'file.txt'), 'changed');
  await assert.rejects(manager.disposeWorkspace('a'), raises('DIRTY_WORKSPACE'));
  await manager.disposeWorkspace('a', { discardChanges: true }); await manager.disposeWorkspace('b');
});
test('expired live cross-process owner blocks takeover; a dead owner requires explicit reconciliation', async t => {
  const { dir, repo, manager, database } = await fixture(t), workspace = await manager.register({ workspace_ref: 'a', repository: repo });
  await manager.createWorkspace('child-task', 'a');
  const script = fileURLToPath(new URL('./fixtures/workspace-lease.mjs', import.meta.url));
  const child = fork(script, [join(dir, 'runtime.sqlite'), workspace.repository_ref, 'hold'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', code => reject(new Error(`Lease child exited: ${code}`))); });
  await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(manager.acquireLease(workspace.repository_identity, 'next'), raises('LEASE_CONFLICT'));
  await assert.rejects(manager.reconcileRepository(workspace.repository_identity, {}), raises('LEASE_CONFLICT'));
  const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
  await assert.rejects(manager.acquireLease(workspace.repository_identity, 'next'), raises('RECONCILIATION_REQUIRED'));
  await new SqliteStateStore({ database }).create('child-task', { operations: [{ attempt_id: 'orphan', phase: 'RUNNING', simulation: false, execution_binding: { identity: 'original' } }] });
  await assert.rejects(manager.reconcileRepository(workspace.repository_identity, { reconcile: async () => ({ stopped: false }) }), raises('RECONCILIATION_REQUIRED'));
  await manager.reconcileRepository(workspace.repository_identity, { reconcile: async input => { assert.equal(input.execution_binding.identity, 'original'); return { stopped: true }; } });
  const lease = await manager.acquireLease(workspace.repository_identity, 'next'); await manager.releaseLease(lease.lease_id);
});
test('mount inventory rejects traversal, junctions, hard links and Git metadata, and includes ignored files', async t => {
  const { repo, dir } = await fixture(t);
  await assert.rejects(effectSnapshot(repo, ['../outside']), raises('INVALID_PATH'));
  await assert.rejects(effectSnapshot(repo, ['.']), raises('UNSAFE_MOUNT'));
  await assert.rejects(effectSnapshot(repo, ['.git']), raises('UNSAFE_MOUNT'));
  await mkdir(join(repo, 'src', 'node_modules')); await writeFile(join(repo, 'src', 'node_modules', 'ignored'), 'before');
  const before = await effectSnapshot(repo, ['src']); await writeFile(join(repo, 'src', 'node_modules', 'ignored'), 'after');
  assert.notEqual((await effectSnapshot(repo, ['src'])).fingerprint, before.fingerprint);
  await mkdir(join(dir, 'outside')); await symlink(join(dir, 'outside'), join(repo, 'src', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(effectSnapshot(repo, ['src']), raises('UNSAFE_MOUNT')); await rm(join(repo, 'src', 'escape'));
  await link(join(repo, 'src', 'file.txt'), join(repo, 'src', 'alias'));
  await assert.rejects(effectSnapshot(repo, ['src']), raises('UNSAFE_MOUNT'));
});
test('interruption and uncertain process lifetime cannot become FAILED_CLEAN', () => {
  const before = { fingerprint: 'a' }, after = { fingerprint: 'a' };
  assert.equal(executionOutcome({ exitCode: 1, stopped: true, before, after }), 'FAILED_CLEAN');
  assert.equal(executionOutcome({ exitCode: 1, stopped: true, interrupted: 'timeout', before, after }), 'INTERRUPTED');
  assert.equal(executionOutcome({ exitCode: 0, stopped: false, before, after }), 'EFFECT_UNKNOWN');
  assert.equal(executionOutcome({ exitCode: 1, stopped: true, before, after: { fingerprint: 'changed' } }), 'EFFECT_UNKNOWN');
});

test('Host Git checkout and Discovery do not execute repository hooks, fsmonitor or filters', async t => {
  const { dir, repo, manager } = await fixture(t), marker = join(dir, 'host-command-ran').replaceAll('\\', '/');
  const git = args => exec('git', args, { cwd: repo, windowsHide: true });
  await writeFile(join(repo, '.gitattributes'), 'src/* filter=fixture\n');
  await git(['add', '.gitattributes']); await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'attributes']);
  const hook = join(repo, '.git', 'hooks', 'post-checkout');
  await writeFile(hook, `#!/bin/sh\necho hook >> "${marker}"\n`, { mode: 0o755 });
  const command = `echo filter >> "${marker}"`;
  await git(['config', 'filter.fixture.smudge', command]); await git(['config', 'filter.fixture.clean', command]);
  await git(['config', 'filter.fixture.required', 'true']); await git(['config', 'core.fsmonitor', hook.replaceAll('\\', '/')]);
  const workspace = await manager.register({ workspace_ref: 'hook-free', repository: repo });
  await discover(workspace.repository_identity);
  await assert.rejects(effectSnapshot(dir, ['host-command-ran']), error => error.code === 'ENOENT');
  await manager.disposeWorkspace('hook-free');
});
