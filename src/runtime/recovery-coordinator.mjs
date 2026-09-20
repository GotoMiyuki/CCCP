import { canonical } from '../audit.mjs';
import { controllerJournal } from './controller-journal.mjs';
import { jsonCopy } from './contracts.mjs';
import { requireRuntime } from './errors.mjs';
import { requiresReconciliation } from './tools/effect-reconciler.mjs';

const requiresAgentReconciliation = run => run.simulation === false && (run.status === 'RUNNING' || run.reconciliation_required === true
  || ['FAILED', 'INTERRUPTED'].includes(run.status) && run.external_execution_stopped !== true);

export async function recoverController({ state, workspace, tool, agent, taskId, context }) {
  await state.acquireTask(taskId);
  const stored = await state.recover(taskId), data = stored.data;
  requireRuntime(data.journal && data.workspace.workspace_ref === context.workspace_ref && data.approval.delegation.id === context.delegation_ref,
    'REFERENCE_MISMATCH', 'Recovery references do not match committed task');
  const journal = controllerJournal({ checkpoint: data.journal });
  requireRuntime(canonical(journal.controller.snapshot) === canonical(data.snapshot) && canonical(journal.controller.audit) === canonical(data.protocol_audit)
    && canonical(journal.approval) === canonical(data.approval), 'CORRUPT_RECOVERY', 'Controller reconstruction differs from stored projection');
  // Stop orphaned external execution before Git inspection. On Windows, a
  // still-mounted Docker worktree can temporarily lock the linked index.
  await workspace.reconcileRepository?.(data.workspace.repository_identity, tool);
  const registered = await workspace.inspectWorkspace(context.workspace_ref);
  requireRuntime(registered.repository_identity === data.workspace.repository_identity, 'REPOSITORY_MISMATCH', 'Recovery workspace identity changed');
  const bound = await workspace.createWorkspace(taskId, context.workspace_ref, data.workspace.base_revision);
  const operations = new Map(data.operations.map(operation => [operation.attempt_id, operation]));
  for (const [id, operation] of operations) if (requiresReconciliation(operation)) {
    // Real runners must prove their old execution is no longer active before any continuation.
    const simulation = (await tool.capabilities()).simulation;
    requireRuntime(typeof tool.reconcile === 'function' || simulation && operation.simulation, 'RECONCILIATION_REQUIRED', 'Real tool requires its reconciler even if a fake provider was installed after restart');
    const reconciliation = typeof tool.reconcile === 'function' ? await tool.reconcile({ task_id: taskId, attempt_id: id, workspace: bound, execution_binding: operation.execution_binding }) : { stopped: true, simulation: true };
    requireRuntime(reconciliation.stopped, 'RECONCILIATION_REQUIRED', 'Prior tool execution may still be running');
    operations.set(id, jsonCopy({ ...operation, phase: 'FINISHED', outcome: 'EFFECT_UNKNOWN', reconciliation, recovered: true }));
    if (journal.controller.state !== 'DONE') journal.controller.block(operation.context.principal, 'REPOSITORY_FAILURE', 'Recovered an unfinished tool attempt; effects require Discovery and reconciliation', [id]);
  }
  const lease = journal.controller.state === 'DONE' ? null : await workspace.acquireLease(bound.repository_identity, taskId, 'write');
  const runs = new Map();
  for (const run of data.agent_runs) {
    if (!requiresAgentReconciliation(run)) { runs.set(run.run_id, run); continue; }
    let reconciliation = { stopped: true, reason: 'simulated_host_restart' };
    if (run.simulation === false) {
      requireRuntime(typeof agent.reconcile === 'function', 'RECONCILIATION_REQUIRED', 'Real Agent provider must reconcile unfinished runs');
      reconciliation = await agent.reconcile(run);
      requireRuntime(reconciliation.stopped === true, 'RECONCILIATION_REQUIRED', 'Prior Agent execution may still be running');
    }
    runs.set(run.run_id, jsonCopy({ ...run, status: 'INTERRUPTED', accepted: false, external_execution_stopped: true,
      reconciliation_required: false, termination_reason: 'host_restarted', reconciliation }));
  }
  return { id: taskId, controller: journal.controller, journal, approval: journal.approval, workspace: bound, lease,
    revision: stored.store_revision, operations, runs,
    discoveryOptions: data.discovery_options, implementer: data.implementer, busy: false, fault: false, saving: Promise.resolve(), active: null };
}
