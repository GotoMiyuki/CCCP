import { AuditLog, canonical, digest } from '../audit.mjs';
import { check } from '../contracts.mjs';
import { pathWithin, requireRole } from '../authority.mjs';
import { CodexAdapter } from '../adapter.mjs';
import { discover } from '../repository.mjs';
import { capabilityManifest } from './capability-manifest.mjs';
import { resolveRuntimeContext, checkTaskContext } from './runtime-context.mjs';
import { jsonCopy, nonempty, oneOf, record, validateFileChanges, validateRequest, validateToolResult } from './contracts.mjs';
import { canonicalRepository } from './workspace/workspace-manager.mjs';
import { requireRuntime, RuntimeError, unsupported } from './errors.mjs';
import { controllerJournal } from './controller-journal.mjs';
import { recoverController } from './recovery-coordinator.mjs';
import { requiresReconciliation } from './tools/effect-reconciler.mjs';

const hostActor = Object.freeze({ id: 'host-runtime', role: 'bridge' });
const constructionKey = Symbol('validated providers');
const owners = new WeakSet();
const roleFor = {
  startTask: ['human'], discoverTask: ['codex'], planTask: ['codex'], beginTask: ['codex'],
  executeTool: ['codex'], submitReport: ['codex'], submitReview: ['human', 'codex', 'chatgpt'],
  routeReview: ['human', 'codex'], acceptTask: ['human'], stopTask: ['human'], resumeTask: ['human', 'codex'],
  dispatchAgent: ['human', 'codex', 'chatgpt'], inspectTask: ['human', 'codex', 'chatgpt'], recoverTask: ['human', 'codex'],
};
const cycle = task => `${task.controller.snapshot.decision_id}:${task.controller.snapshot.revision_count}`;

export class HostRuntime {
  #providers; #manifest; #tasks = new Map(); #starting = new Set(); #audit = new AuditLog(); #discovery; #closed = false; #inflight = 0;
  static async create({ providers, requiredCapabilities = [], discovery = discover }) {
    const manifest = await capabilityManifest(providers, requiredCapabilities);
    requireRuntime(typeof discovery === 'function', 'INVALID_PROVIDER', 'Discovery must be installed by the host');
    const stateOwner = providers.state.database ?? providers.state;
    requireRuntime(!owners.has(stateOwner), 'STORE_ALREADY_OWNED', 'A Store/database connection supports one live HostRuntime owner');
    owners.add(stateOwner);
    return new HostRuntime(constructionKey, providers, manifest, discovery);
  }
  constructor(key, providers, manifest, discovery) {
    requireRuntime(key === constructionKey, 'INVALID_PROVIDER', 'Use HostRuntime.create');
    this.#providers = Object.freeze({ ...providers }); this.#manifest = manifest; this.#discovery = discovery;
  }
  get manifest() { return this.#manifest; }
  get audit() { return this.#audit.entries; }
  async close() {
    requireRuntime(!this.#inflight && !this.#starting.size && [...this.#tasks.values()].every(task => !task.busy && !task.active), 'RUNTIME_BUSY', 'Finish or cancel active operations before closing');
    this.#closed = true;
    for (const task of this.#tasks.values()) {
      await task.saving;
      for (const operation of task.operations.values()) if (operation.simulation === false && requiresReconciliation(operation)) {
        const result = await this.#providers.tool.reconcile({ task_id: task.id, attempt_id: operation.attempt_id, workspace: task.workspace, execution_binding: operation.execution_binding });
        requireRuntime(result.stopped, 'RECONCILIATION_REQUIRED', 'Do not release lease while tool may still run');
      }
      if (task.lease) { await this.#providers.workspace.releaseLease(task.lease.lease_id); task.lease = null; }
    }
    owners.delete(this.#providers.state.database ?? this.#providers.state);
  }
  #log(type, action, context, code = null) {
    this.#audit.append(type, context?.principal ?? hostActor, {
      action, task_id: context?.task_id ?? null, correlation_id: context?.correlation_id ?? null, code,
    });
  }
  #data(task) {
    return jsonCopy({ approval: task.approval, workspace: task.workspace, snapshot: task.controller.snapshot,
      journal: task.journal.export(), implementer: task.implementer,
      protocol_audit: task.controller.audit, discovery_options: task.discoveryOptions, operations: [...task.operations.values()], agent_runs: [...task.runs.values()], simulation: this.#manifest.simulation });
  }
  async #save(task, options = {}) {
    // Serialize only the short store write, never the pending Agent/tool execution.
    const saved = task.saving.then(async () => {
      requireRuntime(!task.fault, 'RUNTIME_STATE_UNAVAILABLE', 'Task storage failed; M1 cannot recover it');
      const value = await this.#providers.state.compareAndSwap(task.id, task.revision, this.#data(task), options);
      task.revision = value.store_revision;
    });
    task.saving = saved.catch(() => { task.fault = true; });
    try { await saved; }
    catch (cause) { task.fault = true; throw new RuntimeError('RUNTIME_STATE_UNAVAILABLE', 'Could not record Controller state; task is unavailable', { cause }); }
  }
  #response(task, context, result = null) {
    return jsonCopy({ context: { ...context, state_version: task.controller.snapshot.state_version }, snapshot: task.controller.snapshot, result });
  }
  #unchanged(task, context) {
    requireRuntime(task.controller.snapshot.state_version === context.state_version, 'EXECUTION_INTERRUPTED', 'Task changed while provider was pending');
  }
  #adapter(task, context) {
    return new CodexAdapter({ controller: task.controller, actor: context.principal, discovery: this.#discovery });
  }
  async #call(action, input, perform, { create = false, readOnly = false, stop = false } = {}) {
    let request, context, task, key, claimed = false, locked = false, creating = false, performed = false;
    this.#inflight++;
    try {
      requireRuntime(!this.#closed, 'RUNTIME_CLOSED', 'Host is closed');
      request = validateRequest(input);
      context = resolveRuntimeContext(request.context, await this.#providers.identity.authenticate(request.credential));
      requireRole(context.principal, ...roleFor[action]);
      // Capability rejection must also work after restart, when no live task exists.
      if (action === 'recoverTask') {
        if (!this.#manifest.capabilities.crash_recovery) unsupported('crash_recovery');
        return await this.#recover(context);
      }
      task = this.#tasks.get(context.task_id);
      if (!create) {
        requireRuntime(task, 'TASK_NOT_FOUND', 'Task is not live in this HostRuntime');
        checkTaskContext(context, task, { readOnly: true });
        requireRuntime(!task.fault || readOnly || stop, 'RUNTIME_STATE_UNAVAILABLE', 'Task storage failed');
        const workspace = await this.#providers.workspace.inspectWorkspace(context.workspace_ref);
        requireRuntime(workspace.task_id === task.id && workspace.repository_identity === task.workspace.repository_identity, 'REFERENCE_MISMATCH', 'Workspace binding changed');
      }
      if (request.idempotency_key && !readOnly) {
        key = canonical([context.task_id, context.principal, action, request.idempotency_key]);
        const prior = await this.#providers.state.claim(key, digest({ context: request.context, principal: context.principal, payload: request.payload }), { task_id: context.task_id });
        if (!prior.claimed) {
          requireRuntime(prior.status === 'SETTLED', 'OPERATION_IN_PROGRESS', 'Identical request is still pending');
          if (!prior.result.ok) throw new RuntimeError(prior.result.code, 'Previous attempt failed; request is not retried');
          this.#log('RUNTIME_REPLAY', action, context); return prior.result.response;
        }
        claimed = true;
      }
      if (create) {
        requireRuntime(!task && !this.#starting.has(context.task_id), 'TASK_EXISTS', 'Task already exists or is being created');
        requireRuntime(context.state_version === 0, 'STALE_STATE_VERSION', 'Creation requires state_version=0');
        this.#starting.add(context.task_id); creating = true;
      } else {
        checkTaskContext(context, task, { readOnly });
        if (!stop && !readOnly) {
          requireRuntime(!task.busy, 'OPERATION_IN_PROGRESS', 'Another task operation is pending');
          task.busy = true; locked = true;
        }
      }
      this.#log('RUNTIME_CALL', action, context); performed = true;
      const result = await perform(task, context, request.payload, request);
      task = this.#tasks.get(context.task_id);
      const response = this.#response(task, context, result ?? null);
      if (!readOnly) await this.#save(task, { settlements: claimed ? [{ key, result: { ok: true, response } }] : [],
        outbox: claimed ? [{ id: digest(key), payload: { type: 'RUNTIME_RECEIPT', response } }] : [] });
      claimed = false;
      if (task.controller.state === 'DONE' && task.lease) {
        await this.#providers.workspace.releaseLease(task.lease.lease_id); task.lease = null;
      }
      this.#log('RUNTIME_RESULT', action, context); return response;
    } catch (error) {
      task ??= context ? this.#tasks.get(context.task_id) : undefined;
      if (performed && task && !readOnly && !task.fault) {
        try {
          await this.#save(task, { settlements: claimed ? [{ key, result: { ok: false, code: error.code ?? 'RUNTIME_FAILURE' } }] : [] }); claimed = false;
        } catch (saveError) { error = saveError; }
      }
      if (claimed && !task?.fault) {
        try { await this.#providers.state.settle(key, { ok: false, code: error.code ?? 'RUNTIME_FAILURE' }); }
        catch { if (task) task.fault = true; error = new RuntimeError('RUNTIME_STATE_UNAVAILABLE', 'Unable to settle operation record'); }
      }
      this.#log('RUNTIME_REJECTED', action, context, error.code ?? 'RUNTIME_FAILURE'); throw error;
    } finally {
      if (locked && task) task.busy = false;
      if (creating) this.#starting.delete(context.task_id);
      this.#inflight--;
    }
  }
  async #recover(context) {
    requireRuntime(!this.#tasks.has(context.task_id) && !this.#starting.has(context.task_id), 'TASK_EXISTS', 'Recovery requires a new Host instance without this live task');
    this.#starting.add(context.task_id);
    try {
      const task = await recoverController({ state: this.#providers.state, workspace: this.#providers.workspace, tool: this.#providers.tool,
        agent: this.#providers.agent, taskId: context.task_id, context });
      this.#tasks.set(task.id, task);
      const pending = await this.#providers.state.pending(task.id);
      await this.#save(task, { settlements: pending.map(key => ({ key, result: { ok: false, code: 'DELIVERY_UNCERTAIN' } })) });
      this.#log('RUNTIME_RECOVERED', 'recoverTask', context);
      return this.#response(task, context, { recovered: true, uncertain_requests: pending.length });
    } finally { this.#starting.delete(context.task_id); }
  }
  async startTask(request) {
    return this.#call('startTask', request, async (_, context, payload) => {
      record(payload, 'Directed input', ['intent', 'decision', 'specification', 'delegation', 'profile']);
      requireRuntime(context.delegation_ref === payload.delegation?.id, 'REFERENCE_MISMATCH', 'Creation Delegation reference differs');
      requireRuntime(await this.#providers.state.read(context.task_id) === null, 'TASK_EXISTS', 'Stored task cannot be restored from a snapshot');
      const registered = await this.#providers.workspace.inspectWorkspace(context.workspace_ref);
      requireRuntime(registered.task_id === null, 'WORKSPACE_IN_USE', 'Creation requires an unbound workspace');
      requireRuntime(registered.repository_identity === canonicalRepository(payload.profile?.repository), 'REPOSITORY_MISMATCH', 'Profile and registered workspace must identify the same directory');
      const journal = controllerJournal({ payload, principal: context.principal });
      const controller = journal.controller;
      await this.#providers.state.acquireTask?.(context.task_id);
      await this.#providers.workspace.reconcileRepository?.(registered.repository_identity, this.#providers.tool);
      const lease = await this.#providers.workspace.acquireLease(registered.repository_identity, context.task_id, 'write');
      let workspace;
      try { workspace = await this.#providers.workspace.createWorkspace(context.task_id, context.workspace_ref, null); }
      catch (error) { await this.#providers.workspace.releaseLease(lease.lease_id); throw error; }
      const task = { id: context.task_id, controller, journal, approval: journal.approval, workspace, lease, revision: 0,
        operations: new Map(), runs: new Map(), busy: false, fault: false, saving: Promise.resolve(), implementer: null, active: null, discoveryOptions: {} };
      this.#tasks.set(task.id, task);
      try { const stored = await this.#providers.state.create(task.id, this.#data(task)); task.revision = stored.store_revision; }
      catch (cause) { task.fault = true; throw new RuntimeError('RUNTIME_STATE_UNAVAILABLE', 'Task storage creation failed', { cause }); }
      return { simulation: this.#manifest.simulation };
    }, { create: true });
  }
  async inspectTask(request) {
    return this.#call('inspectTask', request, task => ({ specification: task.controller.specification, delegation: task.controller.delegation,
      protocol_audit: task.controller.audit, operations: [...task.operations.values()], agent_runs: [...task.runs.values()], storage_available: !task.fault, simulation: this.#manifest.simulation }), { readOnly: true });
  }
  async discoverTask(request) {
    return this.#call('discoverTask', request, async (task, context, payload) => {
      const result = await this.#adapter(task, context).discover(payload); task.discoveryOptions = jsonCopy(payload); return result;
    });
  }
  async planTask(request) {
    return this.#call('planTask', request, (task, context, payload) => task.controller.plan(context.principal, payload));
  }
  async beginTask(request) {
    return this.#call('beginTask', request, async (task, context, payload) => {
      await this.#adapter(task, context).begin(payload);
      if (task.controller.state === 'IMPLEMENTING') task.implementer = context.principal.id;
    });
  }
  async submitReport(request) {
    return this.#call('submitReport', request, (task, context, payload) => task.controller.report(context.principal, payload));
  }
  async routeReview(request) {
    return this.#call('routeReview', request, (task, context) => task.controller.route(context.principal));
  }
  async acceptTask(request) {
    return this.#call('acceptTask', request, (task, context, payload) => task.controller.accept(context.principal, payload.reason));
  }
  async stopTask(request) {
    return this.#call('stopTask', request, (task, context, payload) => {
      task.controller.override(context.principal, payload.reason, { state: 'BLOCKED' });
      // Cancellation cannot delay the recorded Human stop or undo its authority.
      if (task.active) {
        const { provider, id } = task.active;
        Promise.resolve().then(() => provider.cancel(id)).catch(() => this.#log('CANCELLATION_FAILED', 'stopTask', context, 'CANCELLATION_FAILED'));
      }
    }, { stop: true });
  }
  async resumeTask(request) {
    return this.#call('resumeTask', request, async (task, context, payload) => {
      let discovery;
      if (task.controller.snapshot.blocked_reports.some(b => b.category === 'REPOSITORY_FAILURE')) {
        discovery = await this.#discovery(task.controller.profile.repository, task.discoveryOptions); this.#unchanged(task, context);
      }
      task.controller.resume(context.principal, { resolution: payload.resolution, discovery });
    });
  }
  async recoverTask(request) {
    return this.#call('recoverTask', request, () => unsupported('crash_recovery'), { readOnly: true });
  }
  async dispatchAgent(request) {
    return this.#call('dispatchAgent', request, async (task, context, payload) => {
      record(payload, 'Agent dispatch', ['kind', 'run_id', 'template_version', 'input', 'review_level']);
      record(payload.input, 'Agent input');
      oneOf(payload.kind, ['deliberate', 'implement', 'review'], 'Agent kind');
      nonempty(payload.run_id, 'run_id'); nonempty(payload.template_version, 'template_version');
      requireRuntime(!task.runs.has(payload.run_id), 'RUN_ALREADY_EXISTS', 'Run cannot be reused');
      const state = task.controller.state;
      let output_schema;
      if (payload.kind === 'implement') {
        requireRole(context.principal, 'codex');
        requireRuntime(state === 'IMPLEMENTING' && task.implementer === context.principal.id, 'AUTHORITY_BOUNDARY_EXCEEDED', 'Only the active implementer can dispatch implementation');
        output_schema = 'ImplementationReport';
      } else if (payload.kind === 'review') {
        oneOf(payload.review_level, ['R1', 'R2', 'R3'], 'review level');
        requireRuntime(state === { R1: 'VERIFYING', R2: 'SPEC_REVIEW', R3: 'ARCHITECTURE_REVIEW' }[payload.review_level], 'INVALID_TRANSITION', 'Review run requires the corresponding review stage');
        requireRole(context.principal, ...(payload.review_level === 'R3' ? ['human', 'chatgpt'] : ['human', 'codex']));
        if (payload.review_level === 'R3') requireRuntime(context.principal.id !== task.implementer, 'AUTHORITY_BOUNDARY_EXCEEDED', 'R3 requires another principal and run');
        output_schema = 'ReviewResult';
      } else {
        requireRuntime(['DISCOVERY', 'IMPLEMENTATION_PLANNED'].includes(state), 'INVALID_TRANSITION', 'Deliberation is candidate-only before implementation');
        output_schema = 'Proposal';
      }
      let agentInput = payload.input;
      if (payload.kind === 'review' && this.#manifest.provider_capabilities.agent.simulation === false) {
        const refs = payload.input.evidence_refs;
        requireRuntime(Array.isArray(refs) && refs.length > 0, 'INVALID_EVIDENCE', 'Real review requires verified evidence references');
        const artifacts = [];
        for (const ref of refs) artifacts.push(await this.#providers.evidence.verify(ref, { task_id: task.id }));
        requireRuntime(artifacts.every(artifact => artifact.simulation === false), 'INVALID_EVIDENCE', 'Real review cannot rely on simulated artifacts');
        if (payload.review_level === 'R3') requireRuntime(artifacts.some(a => a.type === 'DIFF') && artifacts.some(a => a.type === 'TEST_RUN'),
          'INVALID_EVIDENCE', 'Independent R3 requires real diff and test artifacts');
        if (payload.review_level === 'R3') for (const artifact of artifacts.filter(item => item.type === 'DIFF')) {
          let delta; try { delta = JSON.parse(artifact.content); } catch { delta = null; }
          const attempt = task.operations.get(artifact.operation_id), source = attempt && task.runs.get(attempt.agent_run_id);
          requireRuntime(delta?.format === 'cccp-file-delta-v1' && delta.source_run_id === attempt?.agent_run_id && source?.status === 'COMPLETED'
            && delta.changes?.some(change => change.changed), 'INVALID_EVIDENCE', 'R3 DIFF must be an actual delta bound to a completed implementation run');
        }
        const latestSnapshot = [...task.operations.values()].map(operation => operation.result?.repository_after).filter(Boolean).at(-1)
          ?? task.controller.snapshot.discovery;
        agentInput = { decision: task.approval.decision, specification: task.controller.specification, report: task.controller.snapshot.report,
          repository_snapshot: latestSnapshot, artifacts };
      }
      const agentSimulation = this.#manifest.provider_capabilities.agent.simulation;
      const runRequest = jsonCopy({ ...payload, input: agentInput, context, input_schema: 'RuntimeAgentInput', output_schema,
        context_snapshot: task.controller.snapshot, repository_snapshot: task.controller.snapshot.discovery ?? { repository: task.workspace.repository_identity },
        delegation: task.controller.delegation, allowed_tools: payload.kind === 'implement' ? ['read_repository'] : [], simulation: agentSimulation });
      task.runs.set(payload.run_id, jsonCopy({ run_id: payload.run_id, context, kind: payload.kind, review_level: payload.review_level ?? null,
        provider: this.#manifest.provider_capabilities.agent.backend ?? 'fake', status: 'RUNNING', simulation: agentSimulation }));
      task.active = { provider: this.#providers.agent, id: payload.run_id };
      try {
        await this.#save(task); this.#unchanged(task, context);
        let pending;
        if (typeof this.#providers.agent.dispatch === 'function') {
          const onBinding = async binding => {
            const current = task.runs.get(payload.run_id);
            requireRuntime(current?.status === 'RUNNING', 'EXECUTION_INTERRUPTED', 'Agent binding arrived after run termination');
            task.runs.set(payload.run_id, jsonCopy({ ...current, execution_binding: binding }));
            await this.#save(task); this.#unchanged(task, context);
          };
          const dispatched = this.#providers.agent.dispatch(payload.kind, runRequest, { onBinding });
          task.runs.set(payload.run_id, jsonCopy({ ...task.runs.get(payload.run_id), execution_binding: dispatched.binding }));
          await this.#save(task); pending = dispatched.result;
        } else pending = this.#providers.agent[payload.kind](runRequest);
        const run = jsonCopy(await pending);
        requireRuntime(run.run_id === payload.run_id && canonical(run.context) === canonical(context) && run.simulation === agentSimulation, 'INVALID_RUNTIME_CONTRACT', 'Agent result binding mismatch');
        task.runs.set(payload.run_id, run); this.#unchanged(task, context);
        requireRuntime(run.status === 'COMPLETED', 'EXECUTION_INTERRUPTED', 'Agent run did not complete');
        check(output_schema, run.output);
        if (payload.kind === 'implement' && !agentSimulation) {
          const changes = validateFileChanges(run.artifacts?.file_changes);
          requireRuntime(changes.every(change => task.controller.delegation.paths.some(root => pathWithin(change.path, root))),
            'AUTHORITY_BOUNDARY_EXCEEDED', 'Agent file changes exceed Delegation paths');
        }
        if (payload.kind === 'review') requireRuntime(canonical(run.output.reviewer) === canonical(context.principal) && run.output.review_level === payload.review_level, 'AUTHORITY_BOUNDARY_EXCEEDED', 'Agent cannot impersonate another reviewer');
        if (payload.kind === 'review' && !agentSimulation && run.output.decision === 'APPROVE') {
          const allowed = new Set(agentInput.artifacts.map(a => a.artifact_ref));
          const cited = [...run.output.evidence, ...run.output.requirements.flatMap(item => item.evidence)];
          requireRuntime(cited.length > 0 && cited.every(ref => allowed.has(ref)), 'INVALID_EVIDENCE', 'Agent review cited evidence outside its frozen input');
        }
        return run;
      } catch (error) {
        const run = task.runs.get(payload.run_id);
        task.runs.set(payload.run_id, jsonCopy({ ...run, status: run.status === 'RUNNING' ? 'FAILED' : run.status,
          accepted: false, error_code: error.code ?? 'AGENT_FAILED' })); throw error;
      } finally { task.active = null; }
    });
  }
  async executeTool(request) {
    return this.#call('executeTool', request, async (task, context, payload, input) => {
      record(payload, 'Tool dispatch', ['operation_id', 'attempt_id', 'agent_run_id']); nonempty(payload.operation_id, 'operation_id'); nonempty(payload.attempt_id, 'attempt_id');
      nonempty(input.idempotency_key, 'idempotency_key');
      requireRuntime(!task.operations.has(payload.attempt_id), 'ATTEMPT_ALREADY_EXISTS', 'Attempt cannot be reused');
      task.lease = await this.#providers.workspace.renewLease(task.lease.lease_id); this.#unchanged(task, context);
      const adapter = this.#adapter(task, context);
      return adapter.execute(payload.operation_id, async operation => {
        const attempt = { attempt_id: payload.attempt_id, operation_id: operation.id, context, cycle: cycle(task), phase: 'RUNNING', outcome: null, result: null, evidence_ref: null, simulation: this.#manifest.provider_capabilities.tool.simulation };
        if (typeof this.#providers.tool.describeAttempt === 'function') attempt.execution_binding = jsonCopy(await this.#providers.tool.describeAttempt({ task_id: task.id, attempt_id: payload.attempt_id, workspace: task.workspace }));
        this.#unchanged(task, context);
        task.operations.set(payload.attempt_id, jsonCopy(attempt));
        task.active = { provider: this.#providers.tool, id: payload.attempt_id };
        let result;
        try {
          // Commit the attempted-operation identity before the external side effect.
          await this.#save(task); this.#unchanged(task, context);
          let agent_input;
          if (payload.agent_run_id) {
            const source = task.runs.get(payload.agent_run_id);
            requireRuntime(source?.status === 'COMPLETED' && source.kind === 'implement' && source.context.principal.id === context.principal.id,
              'INVALID_RUNTIME_CONTRACT', 'Tool input must come from the active implementer run');
            agent_input = { file_changes: validateFileChanges(source.artifacts?.file_changes), source_run_id: source.run_id };
            requireRuntime(agent_input.file_changes.every(change => operation.paths.some(root => pathWithin(change.path, root))),
              'AUTHORITY_BOUNDARY_EXCEEDED', 'Agent file changes exceed the approved Operation paths');
          }
          result = validateToolResult(await this.#providers.tool.run({ context, attempt_id: payload.attempt_id, operation,
            delegation: task.controller.delegation, workspace: task.workspace, repository_snapshot: task.controller.snapshot.discovery,
            ...(agent_input ? { agent_input } : {}),
            policy: { cwd: task.workspace.repository_identity, filesystem_allowlist: operation.paths, environment_allowlist: [], network: 'deny',
              tool_allowlist: [operation.id], timeout_ms: 30000, output_limit_bytes: 1048576, resources: { cpu_ms: 30000, memory_bytes: 268435456, file_size_bytes: 1048576 }, enforced: this.#manifest.capabilities.os_sandbox },
            simulation: this.#manifest.provider_capabilities.tool.simulation }), { allowReal: !this.#manifest.provider_capabilities.tool.simulation });
          task.operations.set(payload.attempt_id, jsonCopy({ ...attempt, phase: 'FINISHED', outcome: result.outcome, result }));
          this.#unchanged(task, context);
          if (result.outcome !== 'SUCCEEDED') {
            task.controller.block(context.principal, 'REPOSITORY_FAILURE', `Tool outcome ${result.outcome}; rediscover before any further execution`, [payload.attempt_id]);
            throw new RuntimeError(result.outcome, 'Tool did not succeed; no automatic retry');
          }
          const type = payload.agent_run_id ? 'DIFF' : operation.domain === 'test_implementation' ? 'TEST_RUN' : 'COMMAND_RUN';
          const repository_snapshot = result.repository_after ?? task.controller.snapshot.discovery;
          requireRuntime(type !== 'DIFF' || result.file_delta?.source_run_id === payload.agent_run_id, 'INVALID_EVIDENCE', 'DIFF requires an applied file delta');
          const evidence_ref = await this.#providers.evidence.put({ type, task_id: task.id, operation_id: payload.attempt_id,
            repository_snapshot, producer: result.simulation ? 'fake-tool-runner' : 'process-tool-runner', principal: context.principal,
            status: 'pass', content: JSON.stringify(type === 'DIFF' ? result.file_delta : result), simulation: result.simulation });
          this.#unchanged(task, context);
          task.operations.set(payload.attempt_id, jsonCopy({ ...attempt, phase: 'FINISHED', outcome: result.outcome, result, evidence_ref, evidence_refs: [evidence_ref],
            ...(payload.agent_run_id ? { agent_run_id: payload.agent_run_id } : {}) }));
          return { ...result, evidence_ref };
        } catch (error) {
          if (!result) task.operations.set(payload.attempt_id, jsonCopy({ ...attempt, phase: 'FINISHED', outcome: 'EFFECT_UNKNOWN', error_code: error.code ?? 'TOOL_FAILED' }));
          throw error;
        } finally { task.active = null; }
      });
    });
  }
  async submitReview(request) {
    return this.#call('submitReview', request, async (task, context, payload) => {
      record(payload, 'Review submission', ['review', 'evidence_refs']); check('ReviewResult', payload.review);
      requireRuntime(canonical(payload.review.reviewer) === canonical(context.principal), 'AUTHORITY_BOUNDARY_EXCEEDED', 'Reviewer must match authenticated sender');
      requireRuntime(Array.isArray(payload.evidence_refs), 'INVALID_EVIDENCE', 'Explicit evidence_refs required');
      const validated = new Set();
      for (const ref of payload.evidence_refs) {
        const artifact = await this.#providers.evidence.verify(ref, { task_id: task.id }); this.#unchanged(task, context);
        const attempt = task.operations.get(artifact.operation_id);
        const snapshots = [task.controller.snapshot.discovery?.fingerprint, attempt?.result?.repository_before?.fingerprint, attempt?.result?.repository_after?.fingerprint];
        requireRuntime(attempt?.cycle === cycle(task) && (attempt.evidence_refs ?? [attempt.evidence_ref]).some(item => item?.artifact_ref === artifact.artifact_ref)
          && snapshots.includes(artifact.repository_snapshot.fingerprint),
        'INVALID_EVIDENCE', 'Evidence must come from a recorded operation in this execution cycle and Discovery');
        if (payload.review.decision === 'APPROVE') requireRuntime(artifact.status === 'pass', 'INVALID_EVIDENCE', 'Unknown/failed evidence cannot support APPROVE');
        validated.add(artifact.artifact_ref);
      }
      if (payload.review.decision === 'APPROVE') {
        const references = [...payload.review.evidence, ...payload.review.requirements.flatMap(r => r.evidence)];
        requireRuntime(validated.size > 0 && references.length > 0 && references.every(ref => validated.has(ref)), 'INVALID_EVIDENCE', 'Review evidence must refer to verified artifacts');
      }
      if (payload.review.review_level === 'R3' && this.#manifest.capabilities.independent_r3) {
        const source = [...task.runs.values()].find(run => run.kind === 'review' && run.review_level === 'R3' && run.status === 'COMPLETED'
          && run.context.principal.id === context.principal.id && canonical(run.output) === canonical(payload.review));
        const implementation = [...task.runs.values()].find(run => run.kind === 'implement' && run.status === 'COMPLETED' && run.context.principal.id === task.implementer);
        requireRuntime(source && implementation && source.context.principal.id !== task.implementer && source.provider_kind === 'chatgpt-reviewer'
          && source.provider_instance !== implementation.provider_instance && source.run_id !== implementation.run_id
          && source.execution_binding?.thread_id !== implementation.execution_binding?.thread_id,
        'AUTHORITY_BOUNDARY_EXCEEDED',
          'R3 must be the unchanged output of an independent real review run');
      }
      task.controller.applyReview(context.principal, payload.review);
    });
  }
}
