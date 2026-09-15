import { assert, immutable } from './contracts.mjs';
import { requireRole } from './authority.mjs';
import { confinedPath, discover } from './repository.mjs';
import { executionSession } from './execution-session.mjs';

// Integration seam for Codex, not a shell runner or an LLM masquerading as Human.
// The host must bind each callback to its declared Operation and enforce OS/tool permissions.
export class CodexAdapter {
  #controller; #actor; #discover; #session;
  constructor({ controller, actor, discovery = discover }) {
    requireRole(actor, 'codex'); this.#controller = controller; this.#actor = immutable(actor); this.#discover = discovery;
    this.#session = executionSession(controller);
  }
  #idle() { assert(!this.#session.busy, 'OPERATION_IN_PROGRESS', 'Reference adapter serializes operations for the entire controller'); }
  #unchanged(version) {
    assert(this.#controller.snapshot.state_version === version, 'EXECUTION_INTERRUPTED', 'Execution changed while the operation was pending; its result cannot advance the current task');
  }
  async discover(options) {
    this.#idle();
    assert(['DISCOVERY', 'REVISION'].includes(this.#controller.state), 'INVALID_TRANSITION', 'Discovery requires DISCOVERY or REVISION');
    const version = this.#controller.snapshot.state_version;
    const savedOptions = immutable(options ?? {}); this.#session.busy = true;
    try {
      const result = await this.#discover(this.#controller.profile.repository, savedOptions);
      this.#unchanged(version); this.#controller.observe(this.#actor, result); this.#session.discoveryOptions = savedOptions; return result;
    } catch (error) {
      if (this.#controller.snapshot.state_version === version) this.#controller.block(this.#actor, 'REPOSITORY_FAILURE', `Discovery failed: ${error.message}`);
      throw error;
    } finally { this.#session.busy = false; }
  }
  async begin({ progress } = {}) {
    this.#idle();
    assert(['IMPLEMENTATION_PLANNED', 'REVISION'].includes(this.#controller.state), 'INVALID_TRANSITION', 'Begin requires a ready plan or revision');
    const version = this.#controller.snapshot.state_version; this.#session.busy = true;
    try {
      const fresh = await this.#discover(this.#controller.profile.repository, this.#session.discoveryOptions); this.#unchanged(version);
      this.#controller.begin(this.#actor, { fingerprint: fresh.fingerprint, progress });
    } catch (error) {
      if (this.#controller.snapshot.state_version === version) this.#controller.block(this.#actor, 'REPOSITORY_FAILURE', `Fresh Discovery failed: ${error.message}`);
      throw error;
    } finally { this.#session.busy = false; }
  }
  async execute(operationId, handler) {
    this.#idle();
    assert(this.#controller.state === 'IMPLEMENTING', 'INVALID_TRANSITION', 'Adapter requires IMPLEMENTING');
    const snapshot = this.#controller.snapshot;
    const operation = snapshot.plan.operations.find(o => o.id === operationId);
    assert(operation && typeof handler === 'function', 'INVALID_OPERATION', 'Operation must be present in approved implementation plan');
    if (!this.#controller.checkOperation(this.#actor, operation).allowed) return;
    const key = JSON.stringify([snapshot.decision_id, snapshot.revision_count, operation.id]);
    assert(!this.#session.attempted.has(key), 'OPERATION_ALREADY_ATTEMPTED', 'An operation can be attempted only once per implementation cycle');
    this.#session.busy = true;
    try {
      for (const path of operation.paths) await confinedPath(this.#controller.profile.repository, path);
      this.#unchanged(snapshot.state_version);
      this.#session.attempted.add(key);
      const result = await handler(immutable(operation));
      this.#unchanged(snapshot.state_version); return result;
    } catch (error) {
      if (this.#controller.snapshot.state_version === snapshot.state_version && this.#controller.state === 'IMPLEMENTING') this.#controller.block(this.#actor,
        error.code === 'INVALID_PATH' ? 'AUTHORITY_BOUNDARY_EXCEEDED' : 'REPOSITORY_FAILURE',
        `Adapter operation could not continue: ${error.message}`, [operation.id]);
      throw error;
    } finally { this.#session.busy = false; }
  }
}
