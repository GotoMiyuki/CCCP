import { mkdir, lstat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { canonical, digest } from '../../audit.mjs';
import { WorkspaceManager, canonicalRepository } from './workspace-manager.mjs';
import { RepositoryLease } from './repository-lease.mjs';
import { nonempty, jsonCopy } from '../contracts.mjs';
import { requireRuntime } from '../errors.mjs';
import { processAlive } from '../stores/sqlite-database.mjs';
import { requiresReconciliation } from '../tools/effect-reconciler.mjs';
import { safeGit } from '../../safe-git.mjs';
import { SqliteStateStore } from '../stores/sqlite-state-store.mjs';

const git = async (cwd, args) => (await safeGit(cwd, args)).stdout.trim();
function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith(`..`) && !isAbsolute(rel);
}

export class GitWorkspaceManager extends WorkspaceManager {
  static async create({ database, root, workspaces = [], leaseMs = 60000, clock }) {
    await mkdir(root, { recursive: true }); const canonicalRoot = canonicalRepository(root);
    const manager = new GitWorkspaceManager({ database, root: canonicalRoot, leaseMs, clock });
    for (const input of workspaces) await manager.register(input);
    return manager;
  }
  constructor({ database, root, leaseMs, clock }) {
    super(); this.database = database; this.root = root;
    this.leases = new RepositoryLease({ database, leaseMs, ...(clock ? { clock } : {}) });
  }
  async capabilities() { return { simulation: false, backend: 'git-worktree', durable: this.database.durable, cross_process: true }; }
  async register({ workspace_ref, repository, baseRevision = 'HEAD' }) {
    nonempty(workspace_ref, 'workspace_ref'); nonempty(baseRevision, 'baseRevision');
    const source = canonicalRepository(repository);
    const base = await git(source, ['rev-parse', '--verify', '--end-of-options', `${baseRevision}^{commit}`]);
    const common = canonicalRepository(await git(source, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    const prior = this.database.db.prepare('SELECT data FROM workspaces WHERE ref=?').get(workspace_ref);
    if (prior) {
      const value = JSON.parse(prior.data);
      requireRuntime(value.source_repository === source && value.base_revision === base && value.repository_ref === common, 'REFERENCE_MISMATCH', 'Registered workspace source/base cannot change');
      return this.inspectWorkspace(workspace_ref);
    }
    const target = resolve(this.root, digest(workspace_ref).slice(0, 24));
    requireRuntime(inside(this.root, target), 'INVALID_WORKSPACE', 'Worktree destination must stay within managed root');
    try { await lstat(target); throw new Error('Managed destination already exists; will not overwrite it'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await git(source, ['worktree', 'add', '--detach', '--', target, base]);
    const workspace = jsonCopy({ workspace_ref, repository_identity: canonicalRepository(target), repository_ref: common,
      source_repository: source, base_revision: base, task_id: null, simulation: false });
    this.database.db.prepare('INSERT INTO workspaces VALUES(?,?)').run(workspace_ref, canonical(workspace));
    return workspace;
  }
  async inspectWorkspace(ref) {
    const row = this.database.db.prepare('SELECT data FROM workspaces WHERE ref=?').get(ref);
    requireRuntime(row, 'WORKSPACE_NOT_FOUND', 'Workspace is not registered'); const workspace = JSON.parse(row.data);
    requireRuntime(inside(this.root, workspace.repository_identity) && canonicalRepository(workspace.repository_identity) === workspace.repository_identity, 'INVALID_WORKSPACE', 'Workspace identity or managed boundary changed');
    const common = canonicalRepository(await git(workspace.repository_identity, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    const top = canonicalRepository(await git(workspace.repository_identity, ['rev-parse', '--show-toplevel']));
    requireRuntime(common === workspace.repository_ref && top === workspace.repository_identity, 'REPOSITORY_MISMATCH', 'Worktree now belongs to a different repository or working directory'); return jsonCopy(workspace);
  }
  async createWorkspace(taskId, ref, baseRevision = null) {
    nonempty(taskId, 'task_id'); const workspace = await this.inspectWorkspace(ref);
    requireRuntime(baseRevision === null || baseRevision === workspace.base_revision, 'REFERENCE_MISMATCH', 'Task base revision differs');
    return this.database.transaction(() => {
      const latest = JSON.parse(this.database.db.prepare('SELECT data FROM workspaces WHERE ref=?').get(ref).data);
      requireRuntime(latest.task_id === null || latest.task_id === taskId, 'WORKSPACE_IN_USE', 'Workspace belongs to another task');
      const bound = jsonCopy({ ...latest, task_id: taskId }); this.database.db.prepare('UPDATE workspaces SET data=? WHERE ref=?').run(canonical(bound), ref); return bound;
    });
  }
  #repository(identity) {
    const workspace = this.database.db.prepare('SELECT data FROM workspaces').all().map(row => JSON.parse(row.data)).find(row => row.repository_identity === identity);
    requireRuntime(workspace, 'WORKSPACE_NOT_FOUND', 'Lease requires a registered worktree'); return workspace.repository_ref;
  }
  async acquireLease(identity, taskId, mode) { return this.leases.acquire(this.#repository(identity), taskId, mode); }
  async reconcileRepository(identity, tool) {
    const repository = this.#repository(identity);
    const prior = this.database.db.prepare('SELECT * FROM repository_leases WHERE identity=?').get(repository);
    if (!prior) return;
    requireRuntime(!processAlive(prior.pid), 'LEASE_CONFLICT', 'A live owner cannot be displaced, even after expiry');
    const hasTask = this.database.db.prepare('SELECT task_id FROM tasks WHERE task_id=?').get(prior.task_id);
    const attempts = hasTask ? (await new SqliteStateStore({ database: this.database }).recover(prior.task_id)).data.operations ?? [] : [];
    requireRuntime(hasTask || !this.database.db.prepare('SELECT 1 FROM operation_attempts WHERE task_id=?').get(prior.task_id), 'CORRUPT_RECOVERY', 'Attempts exist without a committed task');
    const workspace = this.database.db.prepare('SELECT data FROM workspaces').all().map(row => JSON.parse(row.data)).find(w => w.task_id === prior.task_id && w.repository_ref === repository);
    for (const operation of attempts) {
      if (requiresReconciliation(operation)) {
        requireRuntime(workspace && typeof tool.reconcile === 'function', 'RECONCILIATION_REQUIRED', 'Orphaned execution requires its original runner and workspace');
        const result = await tool.reconcile({ task_id: prior.task_id, attempt_id: operation.attempt_id, workspace, execution_binding: operation.execution_binding });
        requireRuntime(result.stopped, 'RECONCILIATION_REQUIRED', 'Old container has not been proven stopped');
      }
    }
    this.database.transaction(() => {
      requireRuntime(!processAlive(prior.pid), 'LEASE_CONFLICT', 'Owner is alive');
      this.database.db.prepare('DELETE FROM repository_leases WHERE identity=? AND lease_id=? AND owner=?').run(repository, prior.lease_id, prior.owner);
    });
  }
  async renewLease(id) { return this.leases.renew(id); }
  async releaseLease(id) { return this.leases.release(id); }
  async disposeWorkspace(ref, { discardChanges = false } = {}) {
    const workspace = await this.inspectWorkspace(ref); this.leases.assertFree(workspace.repository_ref);
    const status = await git(workspace.repository_identity, ['status', '--porcelain']);
    requireRuntime(discardChanges || !status, 'DIRTY_WORKSPACE', 'Explicit discardChanges required for a dirty worktree');
    const target = canonicalRepository(workspace.repository_identity);
    requireRuntime(inside(this.root, target), 'INVALID_WORKSPACE', 'Refuse cleanup outside managed root');
    await git(workspace.source_repository, ['worktree', 'remove', ...(discardChanges ? ['--force'] : []), '--', target]);
    this.database.db.prepare('DELETE FROM workspaces WHERE ref=?').run(ref); return true;
  }
}
