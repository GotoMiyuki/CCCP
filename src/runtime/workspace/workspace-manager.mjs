import { unsupported } from '../errors.mjs';
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { nonempty } from '../contracts.mjs';
import { requireRuntime } from '../errors.mjs';

// Repository identity is shared by the Host and workspace implementations.
export function canonicalRepository(path) {
  nonempty(path, 'repository path'); const identity = realpathSync.native(resolve(path));
  requireRuntime(statSync(identity).isDirectory(), 'INVALID_WORKSPACE', 'Repository must be a directory'); return identity;
}

// SPI contract: see docs/HOST_RUNTIME_SPEC.md for request and result shapes.
export class WorkspaceManager {
  async capabilities() { return unsupported('WorkspaceManager.capabilities'); }
  async createWorkspace() { return unsupported('WorkspaceManager.createWorkspace'); }
  async inspectWorkspace() { return unsupported('WorkspaceManager.inspectWorkspace'); }
  async acquireLease() { return unsupported('WorkspaceManager.acquireLease'); }
  async renewLease() { return unsupported('WorkspaceManager.renewLease'); }
  async releaseLease() { return unsupported('WorkspaceManager.releaseLease'); }
  async disposeWorkspace() { return unsupported('WorkspaceManager.disposeWorkspace'); }
}
