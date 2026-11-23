import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { canonical, digest } from '../audit.mjs';
import { check, defaultProfile } from '../contracts.mjs';
import {
  AgentProvider, FakeAgentProvider, FakeToolRunner, GitWorkspaceManager, HostRuntime, SqliteDatabase,
  SqliteEvidenceStore, SqliteIdentityProvider, SqliteStateStore, canonicalRepository, readableReviewInput,
  requiresReconciliation, ToolRunner,
} from '../runtime/index.mjs';
import { requiresAgentReconciliation } from '../runtime/recovery-coordinator.mjs';
import { snapshotProject } from './config.mjs';
import { validateDraft } from './responses.mjs';
import { demoFiles, demoId } from './date-demo.mjs';
import { executeDateDemo } from './demo-execution.mjs';
import { requirements } from '../decision.mjs';

const human = Object.freeze({ id: 'local-human', role: 'human' });
const clauses = (prefix, values) => values.map((text, index) => ({ id: `${prefix}-${index + 1}`, text }));

// Recovery retains real-run semantics. The base ports reject execution.
const reviewOnlyCapabilities = Object.freeze({ simulation: false, backend: 'review-only' });
class ReviewOnlyAgent extends AgentProvider {
  async capabilities() { return reviewOnlyCapabilities; }
}
class ReviewOnlyTool extends ToolRunner {
  async capabilities() { return reviewOnlyCapabilities; }
}

export function draftProfile(project, repository) {
  const profile = defaultProfile(repository);
  profile.delegation.forbidden = project.forbiddenOperations;
  profile.verification_commands = project.verificationCommands;
  profile.review.require_r3 = true;
  profile.review.human_acceptance = true;
  return profile;
}

async function verifyBase(project, commit) {
  const current = await snapshotProject(project);
  if (current.repository !== project.repository || current.commit !== commit) {
    throw new Error('仓库基线已变化。请用 /draft 生成基于当前提交的新草稿，再确认新版');
  }
}

export async function prepareApproval(session, version, worktreeRoot) {
  const entry = session.drafts.at(-1);
  if (!entry || entry.version !== version || entry.messageCount !== session.messages.length) {
    throw new Error('请确认最新讨论对应的草稿版本。有后续讨论时，请先用 /draft 生成新版');
  }
  const { draft } = validateDraft({ ...entry.content, questions: [] }, session.project);
  if (session.project.demo === demoId && (draft.suggested_paths.length !== demoFiles.length
      || !demoFiles.every(file => draft.suggested_paths.includes(file)))) {
    throw new Error('可运行的示例草稿需要同时列出 src/date.mjs 和 tests/checks.mjs。请补充授权范围并重新生成草稿');
  }
  const baseCommit = entry.baseCommit ?? session.project.commit;
  await verifyBase(session.project, baseCommit);
  await mkdir(worktreeRoot, { recursive: true });

  const taskId = randomUUID();
  const workspaceRef = `chat-${taskId}`;
  const profile = draftProfile(session.project, GitWorkspaceManager.worktreePath(canonicalRepository(worktreeRoot), workspaceRef));
  const intent = { id: `${taskId}-intent`, objective: draft.goal };
  const decision = {
    id: `${taskId}-decision`, intent_id: intent.id, proposal_id: `${session.id}-draft-${version}`,
    goal: draft.goal, selected_approach: draft.approach,
    constraints: [...new Set(draft.constraints)], non_goals: [...new Set(draft.non_goals)],
    important_trade_offs: [], rejected_alternatives: [],
  };
  const verification = profile.verification_commands.map(command => `运行项目配置中的验证命令 ${JSON.stringify(command)}`);
  const specification = {
    id: `${taskId}-specification`, decision_id: decision.id,
    objective: { id: 'OBJ-1', text: draft.goal },
    scope: clauses('S', draft.suggested_paths),
    constraints: clauses('C', decision.constraints),
    non_goals: clauses('N', decision.non_goals),
    acceptance_criteria: clauses('AC', draft.acceptance_criteria),
    invariants: [], expected_behavior: [],
    verification_criteria: clauses('V', verification.length ? verification : ['按验收条件逐条核对结果']),
  };
  const delegation = {
    id: `${taskId}-delegation`, decision_id: decision.id, paths: draft.suggested_paths,
    allowed: profile.delegation.allowed, forbidden: profile.delegation.forbidden,
  };
  const payload = { intent, decision, specification, delegation, profile };
  for (const [key, contract] of [['intent', 'Intent'], ['decision', 'Decision'], ['specification', 'Specification'], ['delegation', 'Delegation'], ['profile', 'Profile']]) {
    check(contract, payload[key]);
  }
  return {
    sessionId: session.id, draftVersion: version, actor: human, approvedAt: new Date().toISOString(),
    repository: session.project.repository, baseCommit, payloadHash: digest(payload),
    ...(session.project.demo === demoId ? { demo: demoId } : {}),
    request: {
      context: { task_id: taskId, workspace_ref: workspaceRef, delegation_ref: delegation.id, state_version: 0, correlation_id: taskId },
      idempotency_key: `approve-v${version}`, payload,
    },
  };
}

export function createTaskHandoff(chatDatabasePath) {
  const runtimePath = join(dirname(chatDatabasePath), 'chat-runtime.sqlite');
  const worktreeRoot = join(dirname(chatDatabasePath), 'chat-worktrees');

  async function committedTask(state, approval) {
    const context = approval.request.context;
    const stored = await state.recover(context.task_id).catch(error => {
      if (error.code === 'TASK_NOT_FOUND') return null;
      throw error;
    });
    if (!stored) return null;
    const { data } = stored;
    if (digest(data.journal.payload) !== approval.payloadHash
        || canonical(data.approval.approval.actor) !== canonical(approval.actor)
        || data.workspace.workspace_ref !== context.workspace_ref || data.workspace.task_id !== context.task_id
        || data.workspace.repository_identity !== approval.request.payload.profile.repository
        || data.workspace.source_repository !== approval.repository || data.workspace.base_revision !== approval.baseCommit) {
      throw new Error('任务记录与本地批准内容不一致，无法确认交接结果');
    }
    const task = {
      id: context.task_id, state: data.snapshot.state, modelRuns: data.agent_runs.length, operations: data.operations.length,
      workspace: data.workspace.repository_identity,
    };
    if (approval.demo !== demoId) return task;

    const cycle = `${data.snapshot.decision_id}:${data.snapshot.revision_count}`;
    const attempts = data.operations.filter(item => item.cycle === cycle);
    const lastDeferral = data.protocol_audit.findLast(entry => entry.type === 'HUMAN_ACCEPTANCE_DEFERRED');
    const acceptance = data.protocol_audit.findLast(entry => entry.type === 'EXECUTION_TRANSITION'
      && entry.data.to === 'DONE' && typeof entry.data.acceptance === 'string');
    const evidence = new SqliteEvidenceStore({ database: state.database });
    const artifacts = await Promise.all(attempts.filter(item => item.evidence_ref).map(item =>
      evidence.verify(item.evidence_ref, { task_id: context.task_id, operation_id: item.attempt_id })));
    return { ...task,
      diff: readableReviewInput({ artifacts }).readable_diffs?.flatMap(item => item.files) ?? [],
      evidenceTypes: Object.fromEntries(artifacts.map(item => [item.artifact_ref, item.type])),
      test: attempts.findLast(item => item.operation_id === 'test-date-candidate'),
      reviews: Object.values(data.snapshot.reviews),
      clauses: requirements(data.approval.specification),
      blocked: data.snapshot.blocked, changeProposal: data.snapshot.change_proposal,
      lastDeferral, acceptance,
      unsettled: [
        ...data.agent_runs.filter(requiresAgentReconciliation).map(item => `Agent ${item.run_id}`),
        ...data.operations.filter(requiresReconciliation).map(item => `工具 ${item.attempt_id}`),
      ],
    };
  }

  async function withState(work) {
    const database = await SqliteDatabase.open({ path: runtimePath });
    try { return await work(new SqliteStateStore({ database }), database); }
    finally { database.close(); }
  }

  async function decideAcceptance(approval, method, reason) {
    if (approval.demo !== demoId) throw new Error('当前人工验收入口适用于日期示例任务');
    return withState(async (state, database) => {
      const task = await committedTask(state, approval);
      if (method === 'acceptTask' && task?.acceptance) return task;
      if (task?.state !== 'HUMAN_ACCEPTANCE') throw new Error('任务尚未到达待人工验收。请用 /task 查看当前状态');
      if (task.unsettled.length) throw new Error('RECONCILIATION_REQUIRED：请用 /task 查看待对账操作');
      if (method === 'deferAcceptance' && task.lastDeferral?.data.reason === reason) return task;

      const workspace = await GitWorkspaceManager.create({ database, root: worktreeRoot });
      const context = approval.request.context;
      const credential = randomBytes(32).toString('hex');
      const identity = new SqliteIdentityProvider({ database, sessions: [{
        credential, principal: approval.actor, task_ids: [context.task_id], expires_at: Date.now() + 300000,
      }] });
      let host;
      try {
        host = await HostRuntime.create({
          providers: { state, workspace, identity, evidence: new SqliteEvidenceStore({ database }),
            agent: new ReviewOnlyAgent(), tool: new ReviewOnlyTool() },
          requiredCapabilities: ['durable_state', 'crash_recovery'],
        });
        const recovered = await host.recoverTask({ context, credential, payload: {} });
        const current = await committedTask(state, approval);
        if (method === 'acceptTask') {
          // A confirmation may have committed while this terminal was opening the task.
          if (current.acceptance) return current;
          if ((await snapshotProject({ repository: current.workspace })).commit !== approval.baseCommit) {
            throw new Error('验收工作区的基准提交已变化。请保留当前改动并从新基线创建任务');
          }
        } else if (current.lastDeferral?.data.reason === reason) return current;

        await host[method]({
          context: recovered.context, credential, payload: { reason }, idempotency_key: `${method}-${randomUUID()}`,
        });
        return committedTask(state, approval);
      } finally {
        try { await host?.close(); }
        finally { await identity.revoke(credential); }
      }
    });
  }

  return {
    demoRepository: join(dirname(chatDatabasePath), 'chat-date-demo'),
    prepare: (session, version) => prepareApproval(session, version, worktreeRoot),
    inspect: approval => withState(state => committedTask(state, approval)),
    accept: (approval, reason) => decideAcceptance(approval, 'acceptTask', reason),
    defer: (approval, reason) => decideAcceptance(approval, 'deferAcceptance', reason),
    async run(approval, options) {
      if (approval.demo !== demoId) throw new Error('当前 /run 支持用 --demo 创建的日期校验任务');
      return withState(async (state, database) => {
        const existing = await committedTask(state, approval);
        if (!existing) throw new Error('请先批准草稿并创建任务');
        if (existing.state !== 'DISCOVERY') return existing;
        const workspace = await GitWorkspaceManager.create({ database, root: worktreeRoot });
        await executeDateDemo({ state, database, workspace, approval, ...options });
        return committedTask(state, approval);
      });
    },
    async submit(approval) {
      const { request, actor, repository, baseCommit } = approval;
      const { context, payload } = request;
      if (digest(payload) !== approval.payloadHash || canonical(actor) !== canonical(human)) {
        throw new Error('本地批准内容与提交请求不一致');
      }
      return withState(async (state, database) => {
        // One owner spans workspace registration, the Runtime call, and the receipt check.
        await state.acquireTask(context.task_id);
        const existing = await committedTask(state, approval);
        if (existing) return existing;
        if ((await state.pending(context.task_id)).length) {
          throw new Error('Runtime 已收到提交但尚无已提交任务（DELIVERY_UNCERTAIN）。请用 /task 核对');
        }
        await verifyBase({ repository }, baseCommit);
        const workspace = await GitWorkspaceManager.create({ database, root: worktreeRoot });
        const registered = await workspace.register({ workspace_ref: context.workspace_ref, repository, baseRevision: baseCommit });
        if (registered.repository_identity !== payload.profile.repository) throw new Error('工作区与获批路径不一致');

        const credential = randomBytes(32).toString('hex');
        const identity = new SqliteIdentityProvider({ database, sessions: [{
          credential, principal: actor, task_ids: [context.task_id], expires_at: Date.now() + 300000,
        }] });
        const host = await HostRuntime.create({
          providers: { state, workspace, identity, evidence: new SqliteEvidenceStore({ database }),
            agent: new FakeAgentProvider(), tool: new FakeToolRunner() },
          requiredCapabilities: ['durable_state', 'cross_process_leases'],
        });
        try {
          await host.startTask({ ...request, credential });
          const committed = await committedTask(state, approval);
          if (!committed) throw new Error('Runtime 已返回但未找到持久任务。请用 /task 核对');
          return committed;
        } finally {
          try { await host.close(); }
          finally { await identity.revoke(credential); }
        }
      });
    },
  };
}
