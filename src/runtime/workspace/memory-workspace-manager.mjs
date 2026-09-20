import { randomUUID } from 'node:crypto';
import { WorkspaceManager, canonicalRepository } from './workspace-manager.mjs';
import { jsonCopy, nonempty, oneOf } from '../contracts.mjs';
import { requireRuntime } from '../errors.mjs';

export class MemoryWorkspaceManager extends WorkspaceManager {
  #workspaces = new Map(); #leases = new Map(); #clock; #leaseMs;
  constructor({ workspaces = [], clock = () => Date.now(), leaseMs = 60000 } = {}) {
    super(); this.#clock = clock; this.#leaseMs = leaseMs;
    requireRuntime(Number.isFinite(leaseMs) && leaseMs > 0, 'INVALID_WORKSPACE', 'Positive lease duration required');
    for (const item of workspaces) {
      nonempty(item.workspace_ref, 'workspace_ref');
      requireRuntime(!this.#workspaces.has(item.workspace_ref), 'INVALID_WORKSPACE', 'Duplicate workspace reference');
      this.#workspaces.set(item.workspace_ref, jsonCopy({ workspace_ref: item.workspace_ref, repository_identity: canonicalRepository(item.repository), task_id: null, base_revision: null, simulation: true }));
    }
  }
  async capabilities() { return { simulation: true }; }
  async createWorkspace(taskId, repositoryRef, baseRevision = null) {
    nonempty(taskId, 'task_id');
    requireRuntime(baseRevision === null || typeof baseRevision === 'string', 'INVALID_WORKSPACE', 'Invalid base revision');
    const workspace = await this.inspectWorkspace(repositoryRef);
    requireRuntime(workspace.task_id === null || workspace.task_id === taskId, 'WORKSPACE_IN_USE', 'Workspace belongs to another task');
    const bound = jsonCopy({ ...workspace, task_id: taskId, base_revision: baseRevision });
    this.#workspaces.set(repositoryRef, bound); return bound;
  }
  async inspectWorkspace(ref) {
    const workspace = this.#workspaces.get(ref); requireRuntime(workspace, 'WORKSPACE_NOT_FOUND', 'Workspace is not registered');
    requireRuntime(canonicalRepository(workspace.repository_identity) === workspace.repository_identity, 'REPOSITORY_MISMATCH', 'Registered repository identity changed');
    return jsonCopy(workspace);
  }
  async acquireLease(identity, taskId, mode = 'write') {
    oneOf(mode, ['write'], 'lease mode'); nonempty(taskId, 'task_id');
    const repositoryIdentity = canonicalRepository(identity);
    const prior = this.#leases.get(repositoryIdentity);
    requireRuntime(!prior || prior.expires_at <= this.#clock(), 'LEASE_CONFLICT', 'Repository already has an active writer');
    const lease = jsonCopy({ lease_id: randomUUID(), repository_identity: repositoryIdentity, task_id: taskId, mode, expires_at: this.#clock() + this.#leaseMs, simulation: true });
    this.#leases.set(repositoryIdentity, lease); return lease;
  }
  async renewLease(id) {
    const lease = [...this.#leases.values()].find(l => l.lease_id === id);
    requireRuntime(lease && lease.expires_at > this.#clock(), 'LEASE_EXPIRED', 'Lease is missing or expired');
    const renewed = jsonCopy({ ...lease, expires_at: this.#clock() + this.#leaseMs }); this.#leases.set(lease.repository_identity, renewed); return renewed;
  }
  async releaseLease(id) {
    const lease = [...this.#leases.values()].find(l => l.lease_id === id);
    return lease ? this.#leases.delete(lease.repository_identity) : false;
  }
  async disposeWorkspace(ref) {
    const workspace = await this.inspectWorkspace(ref);
    requireRuntime(![...this.#leases.values()].some(l => l.repository_identity === workspace.repository_identity && l.expires_at > this.#clock()), 'WORKSPACE_IN_USE', 'Release active lease before disposing');
    this.#workspaces.set(ref, jsonCopy({ ...workspace, task_id: null, base_revision: null }));
    return true; // Registration remains; no filesystem deletion.
  }
}
