import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { requirements } from '../src/index.mjs';
import { realAgentHost, operations } from './fixtures/real-agent-host.mjs';
import { codex } from '../examples/fixtures.mjs';

const enabled = process.env.CCCP_REAL_AGENT_TESTS === '1';
const real = { skip: !enabled, timeout: 600000 };
const exec = promisify(execFile), crashFixture = fileURLToPath(new URL('./fixtures/real-agent-crash-child.mjs', import.meta.url));

async function writeAuditFixture(name, fixture, observed, refs) {
  const directory = process.env.CCCP_E2E_AUDIT_DIR;
  if (!directory) return;
  const artifacts = await Promise.all(refs.map(ref => fixture.providers.evidence.verify(ref, { task_id: fixture.context.task_id })));
  const agent_runs = observed.result.agent_runs.map(run => ({ run_id: run.run_id, kind: run.kind, review_level: run.review_level ?? null,
    status: run.status, provider: run.provider, provider_kind: run.provider_kind, provider_instance: run.provider_instance,
    model: run.model, principal: run.principal, execution_binding: run.execution_binding, output: run.output }));
  const value = { audit_format: 'cccp-m4-e2e-v1', scenario: name, captured_at: new Date().toISOString(), task_id: fixture.context.task_id,
    state: observed.snapshot.state, repository_snapshot: observed.snapshot.discovery, operation_count: observed.result.operations.length,
    operations: observed.result.operations.map(operation => ({ attempt_id: operation.attempt_id, operation_id: operation.operation_id,
      outcome: operation.outcome, evidence_ref: operation.evidence_ref, agent_run_id: operation.agent_run_id ?? null })),
    artifacts, agent_runs, protocol_audit: observed.result.protocol_audit };
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

async function independentReview(host, refs) {
  const level = 'R3', role = 'chatgpt';
  const run = await host.call('dispatchAgent', role, { kind: 'review', review_level: level, run_id: `real-${level.toLowerCase()}`,
    template_version: 'm4-review-v1', input: { evidence_refs: refs } });
  return host.call('submitReview', role, { review: run.result.output, evidence_refs: refs });
}

async function evidenceReview(host, specification, reportId, level, refs) {
  const evidence = refs.map(ref => ref.artifact_ref);
  return host.call('submitReview', 'codex', { review: { id: `verified-${level.toLowerCase()}`, report_id: reportId, review_level: level, reviewer: codex,
    decision: 'APPROVE', confidence: 1, findings: [], evidence, failed_requirements: [],
    requirements: level === 'R2' ? requirements(specification).map(item => ({ requirement_id: item.id, status: 'pass', evidence })) : [],
    implementation_status: 'pass', specification_compliance: 'pass', architecture_compliance: 'pass', boundary_violation: false,
    reason: 'Host verified the recorded real diff and test artifacts.' }, evidence_refs: refs });
}

test('real Codex implementation and independent ChatGPT R3 reach Human Acceptance', real, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cccp-m4-real-'));
  let fixture;
  try {
    fixture = await realAgentHost(directory);
    await fixture.call('discoverTask', 'codex'); await fixture.call('planTask', 'codex', { summary: 'Bounded fixture change', operations }); await fixture.call('beginTask', 'codex');
    const implementation = await fixture.call('dispatchAgent', 'codex', { kind: 'implement', run_id: 'real-implementation', template_version: 'm4-implement-v1',
      input: { instruction: 'Change only src/value.txt so its exact UTF-8 content is ready followed by one newline. Report specification and discovery identifiers exactly from the supplied CCCP context.' } });
    const applied = await fixture.call('executeTool', 'codex', { operation_id: 'apply-agent-change', attempt_id: 'apply-1', agent_run_id: 'real-implementation' }, 'apply-1');
    const tested = await fixture.call('executeTool', 'codex', { operation_id: 'run-fixture-tests', attempt_id: 'test-1' }, 'test-1');
    const refs = [applied.result.evidence_ref, tested.result.evidence_ref];
    const report = { ...implementation.result.output, evidence: refs.map(ref => ref.artifact_ref) };
    await fixture.call('submitReport', 'codex', report);
    await evidenceReview(fixture, fixture.specification, report.id, 'R1', refs);
    await evidenceReview(fixture, fixture.specification, report.id, 'R2', refs);
    await fixture.call('routeReview', 'codex'); await independentReview(fixture, refs);
    const observed = await fixture.call('inspectTask', 'human');
    assert.equal(observed.snapshot.state, 'HUMAN_ACCEPTANCE'); assert.equal(await readFile(join(fixture.workspace, 'src', 'value.txt'), 'utf8'), 'ready\n');
    assert.equal(observed.result.agent_runs.filter(run => run.kind === 'review' && run.review_level === 'R3').length, 1);
    assert.ok(requirements(fixture.specification).length > 0);
    await writeAuditFixture('normal', fixture, observed, refs);
    if (process.env.CCCP_HUMAN_ACCEPT === '1') {
      const accepted = await fixture.call('acceptTask', 'human', { reason: process.env.CCCP_HUMAN_ACCEPT_REASON ?? 'Human accepted the M4 evidence.' });
      assert.equal(accepted.snapshot.state, 'DONE');
    }
  } finally {
    if (fixture) { await fixture.host.close(); fixture.database.close(); }
    try { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  }
});

test('forced Host crash after real tools recovers without replay and completes independent R3', real, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cccp-m4-recovery-'));
  let fixture;
  try {
    try { await exec(process.execPath, [crashFixture, directory], { windowsHide: true, timeout: 300000, env: process.env }); assert.fail('Child should be killed'); }
    catch (error) { assert.match(error.stdout ?? '', /CRASH:after_real_tools/, error.stderr); }
    fixture = await realAgentHost(directory, { start: false, recover: true });
    let observed = await fixture.call('inspectTask', 'human');
    assert.equal(observed.snapshot.state, 'VERIFYING'); assert.equal(observed.result.operations.length, 2);
    const refs = observed.result.operations.map(operation => operation.evidence_ref);
    const reportId = observed.snapshot.report.id;
    await evidenceReview(fixture, fixture.specification, reportId, 'R1', refs);
    await evidenceReview(fixture, fixture.specification, reportId, 'R2', refs);
    await fixture.call('routeReview', 'codex'); await independentReview(fixture, refs);
    observed = await fixture.call('inspectTask', 'human');
    assert.equal(observed.snapshot.state, 'HUMAN_ACCEPTANCE'); assert.equal(observed.result.operations.length, 2);
    assert.equal(await readFile(join(fixture.workspace, 'src', 'value.txt'), 'utf8'), 'ready\n');
    await writeAuditFixture('recovery', fixture, observed, refs);
    if (process.env.CCCP_HUMAN_ACCEPT === '1') {
      observed = await fixture.call('acceptTask', 'human', { reason: process.env.CCCP_HUMAN_ACCEPT_REASON ?? 'Human accepted the M4 recovery evidence.' });
      assert.equal(observed.snapshot.state, 'DONE');
    }
  } finally {
    if (fixture) { await fixture.host.close(); fixture.database.close(); }
    try { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  }
});
