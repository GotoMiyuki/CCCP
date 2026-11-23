import { randomBytes, randomUUID } from 'node:crypto';
import {
  captureAgentFiles, DeepSeekReviewProvider, effectSnapshot, HostRuntime, ProcessToolRunner,
  RoutedAgentProvider, SqliteEvidenceStore, SqliteIdentityProvider,
} from '../runtime/index.mjs';
import { DeepSeekImplementer } from './deepseek-implementer.mjs';
import { demoFiles } from './date-demo.mjs';

const implementer = { id: 'chat-date-implementer', role: 'codex' };
const reviewer = { id: 'chat-date-independent-reviewer', role: 'chatgpt' };
const operations = [
  { id: 'apply-date-candidate', domain: 'internal_implementation', paths: [...demoFiles], changes_decision: false, description: 'Apply candidate files within the demo scope' },
  { id: 'test-date-candidate', domain: 'test_implementation', paths: [...demoFiles], changes_decision: false, description: 'Run date tests in a read-only container' },
];
const defaultImage = 'node@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81';
const applyFiles = `
const { writeFileSync } = require('node:fs');
const paths = new Set(${JSON.stringify(demoFiles)});
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const { file_changes } = JSON.parse(input);
  if (!file_changes.every(change => paths.has(change.path))) throw new Error('Candidate targets an unbound path');
  for (const change of file_changes) writeFileSync('/workspace/' + change.path, change.content, 'utf8');
});
`;

export async function executeDateDemo({ state, database, workspace, approval, env, fetchImpl, signal, progress }) {
  const apiKey = env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw new Error('运行示例需要 DEEPSEEK_API_KEY');
  const model = env.CCCP_CODING_MODEL?.trim() || 'deepseek-flash';
  const reviewModel = env.CCCP_DEEPSEEK_MODEL?.trim() || 'deepseek-flash';
  progress(`实施与 R2：DeepSeek ${model} · 独立 R3：DeepSeek ${reviewModel}`);
  const tool = await ProcessToolRunner.create({
    context: env.CCCP_DOCKER_CONTEXT, image: env.CCCP_DOCKER_IMAGE || defaultImage,
    bindings: {
      [operations[0].id]: { domain: operations[0].domain, paths: demoFiles, write: true,
        accepts_agent_input: true, argv: ['/usr/local/bin/node', '-e', applyFiles] },
      [operations[1].id]: { domain: operations[1].domain, paths: demoFiles, write: false,
        argv: ['/usr/local/bin/node', '--test', '/workspace/tests/checks.mjs'] },
    },
  });
  let context = { ...approval.request.context };
  const credentials = new Map([approval.actor, implementer, reviewer].map(actor => [actor, randomBytes(32).toString('hex')]));
  const identity = new SqliteIdentityProvider({ database, sessions: [...credentials].map(([principal, credential]) => ({
    principal, credential, task_ids: [context.task_id], expires_at: Date.now() + 30 * 60 * 1000,
  })) });
  let host;
  try {
    const agent = new RoutedAgentProvider({
      implementer: new DeepSeekImplementer({ apiKey, model, fetchImpl }),
      reviewer: new DeepSeekReviewProvider({ apiKey, model: reviewModel, fetchImpl, providerId: 'chat-deepseek-r3', readableDiffs: true }),
    });
    host = await HostRuntime.create({
      providers: { state, workspace, identity, tool, agent, evidence: new SqliteEvidenceStore({ database }) },
      requiredCapabilities: ['durable_state', 'crash_recovery', 'real_agents', 'os_sandbox', 'independent_r3', 'cross_process_leases'],
    });
    const call = async (method, actor, payload = {}, key) => {
      signal?.throwIfAborted();
      const response = await host[method]({
        context, credential: credentials.get(actor), payload, ...(key ? { idempotency_key: key } : {}),
      });
      const { principal: _principal, ...next } = response.context;
      context = next;
      return response;
    };
    let current = await call('recoverTask', approval.actor);
    if (current.snapshot.state !== 'DISCOVERY') return;
    const { specification, decision, profile } = approval.request.payload;
    let revisionNote;
    do {
      const cycle = randomUUID();
      progress('读取已批准的工作区…');
      const found = await call('discoverTask', implementer, { relatedPaths: demoFiles });
      if (found.snapshot.discovery.base_commit !== approval.baseCommit
          || (!revisionNote && found.snapshot.discovery.working_tree_status !== 'clean')) {
        throw new Error('工作区与获批基线不一致，请检查 /task 中的工作区');
      }
      await effectSnapshot(profile.repository, demoFiles, { maxBytes: 64 * 1024 });
      const files = await captureAgentFiles(profile.repository, demoFiles.map(path => ({ path, content: '' })));
      const sourceFiles = files.map(file => ({
        path: file.path, content: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(file.content_base64, 'base64')),
      }));

      current = await call('planTask', implementer, { summary: decision.goal, operations });
      if (current.snapshot.state === 'BLOCKED') return;
      current = await call('beginTask', implementer, revisionNote ? { progress: revisionNote } : {});
      if (current.snapshot.state !== 'IMPLEMENTING') return;
      progress('DeepSeek 正在生成候选改动…');
      const runId = `${cycle}-implementation`;
      const implementation = await call('dispatchAgent', implementer, {
        kind: 'implement', run_id: runId, template_version: 'chat-date-v1',
        input: { decision, specification, source_files: sourceFiles, revision_feedback: revisionNote ?? null },
      });

      progress('在 Docker 中应用候选改动…');
      const applied = await call('executeTool', implementer, {
        operation_id: operations[0].id, attempt_id: `${cycle}-apply`, agent_run_id: runId,
      }, `${cycle}-apply`);
      progress('在只读容器中执行日期测试…');
      const tested = await call('executeTool', implementer, {
        operation_id: operations[1].id, attempt_id: `${cycle}-test`,
      }, `${cycle}-test`);
      const refs = [applied.result.evidence_ref, tested.result.evidence_ref];
      const evidence = refs.map(ref => ref.artifact_ref);
      const changed = applied.result.file_delta.changes.filter(file => file.changed).map(file => file.path);
      const report = {
        ...implementation.result.output,
        summary: changed.length ? `Applied changes to ${changed.join(', ')}. The configured date test command exited successfully.` : 'The candidate did not change any files.',
        changed_files: changed, evidence,
      };
      await call('submitReport', implementer, report);
      current = await call('submitReview', implementer, { evidence_refs: refs, review: {
        id: `${cycle}-r1`, report_id: report.id, review_level: 'R1', reviewer: implementer,
        decision: changed.length ? 'APPROVE' : 'BLOCKED', confidence: 1,
        findings: [], evidence, failed_requirements: [], requirements: [], boundary_violation: false,
        implementation_status: changed.length ? 'pass' : 'unknown', specification_compliance: 'unknown', architecture_compliance: 'unknown',
        reason: changed.length ? 'Recorded DIFF has changes and the read-only test command passed.' : 'No actual change is available for review.',
      } });
      if (current.snapshot.state !== 'SPEC_REVIEW') return;

      const review = async (level, actor) => {
        const judged = await call('dispatchAgent', actor, {
          kind: 'review', review_level: level, run_id: `${cycle}-${level}`, template_version: 'chat-date-review-v1',
          input: { evidence_refs: refs },
        });
        current = await call('submitReview', actor, { review: judged.result.output, evidence_refs: refs });
        return judged.result.output;
      };
      progress('R2 正在按规格逐条核对差异与测试证据…');
      let judgment = await review('R2', implementer);
      if (current.snapshot.state === 'REVIEW_ROUTING') {
        current = await call('routeReview', implementer);
        if (current.snapshot.state === 'ARCHITECTURE_REVIEW') {
          progress('独立 R3 正在审查决策、授权和证据…');
          judgment = await review('R3', reviewer);
        }
      }
      revisionNote = current.snapshot.state === 'REVISION' ? JSON.stringify({
        level: judgment.review_level, reason: judgment.reason, findings: judgment.findings,
      }) : undefined;
      if (revisionNote) progress('审查要求修订，Runtime 将按授权范围和修订预算处理。');
    } while (revisionNote);
  } finally {
    try { await host?.close(); }
    finally { for (const credential of credentials.values()) await identity.revoke(credential); }
  }
}
