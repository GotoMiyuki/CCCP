import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ProcessToolRunner, canonicalRepository } from '../src/index.mjs';
import { operationFixture, approvalFixture, codex } from '../examples/fixtures.mjs';
import { prepareSimulation } from '../examples/runtime-workflow.mjs';
import { dockerHost } from './fixtures/docker-host.mjs';

const exec = promisify(execFile), dirs = [];
const real = { skip: process.env.CCCP_DOCKER_TESTS !== '1', timeout: 90000 };
after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'cccp-docker-')); dirs.push(dir); return dir; }
async function fixture(source, { write = true, policy = {} } = {}) {
  const dir = await directory(); await mkdir(join(dir, 'src')); await writeFile(join(dir, 'hidden.txt'), 'must not be visible');
  // The Host registers real paths. On macOS, tmpdir() may use the /var alias
  // while realpath resolves to /private/var, so model the registered identity.
  const repository = canonicalRepository(dir);
  const runner = await ProcessToolRunner.create({ context: 'desktop-linux', image: process.env.CCCP_DOCKER_IMAGE, namespace: dir, bindings: { 'op-1': {
    domain: 'internal_implementation', paths: ['src'], write, argv: ['/usr/local/bin/node', '-e', source],
  } } });
  const request = { context: { task_id: 'task', state_version: 0, principal: codex, delegation_ref: 'delegation-1', workspace_ref: 'workspace', correlation_id: 'docker' },
    attempt_id: 'attempt', operation: operationFixture(), delegation: approvalFixture({ repository }).snapshot.delegation,
    workspace: { task_id: 'task', workspace_ref: 'workspace', repository_identity: repository },
    policy: { cwd: repository, filesystem_allowlist: ['src'], environment_allowlist: [], network: 'deny', tool_allowlist: ['op-1'], enforced: true,
      timeout_ms: 10000, output_limit_bytes: 4096, resources: { memory_bytes: 134217728, cpu_ms: 10000, file_size_bytes: 1048576 }, ...policy }, simulation: false };
  return { dir, runner, request };
}
async function noContainer(result) {
  const output = await exec('docker', ['--context', 'desktop-linux', 'container', 'ls', '-aq', '--filter', `label=org.cccp.execution=${result.execution.identity}`], { windowsHide: true, timeout: 15000 });
  assert.equal(output.stdout.trim(), '');
}
test('ProcessToolRunner refuses mutable image tags before contacting an engine', async () => {
  await assert.rejects(ProcessToolRunner.create({ image: 'node:24-alpine' }), error => error.code === 'UNPINNED_IMAGE');
});
test('real Docker confines writes, excludes host environment and denies external network', real, async () => {
  const { dir, runner, request } = await fixture(`
    const fs=require('fs'),assert=require('assert'),net=require('net');
    assert.equal(process.cwd(),'/workspace'); assert.equal(process.env.CCCP_HOST_SECRET,undefined);
    assert.equal(fs.existsSync('/workspace/hidden.txt'),false);
    assert.throws(()=>fs.writeFileSync('/outside','no')); fs.writeFileSync('src/result','effect');
    const socket=net.connect(53,'1.1.1.1'); socket.setTimeout(500); socket.on('connect',()=>{process.exitCode=1;socket.destroy()});
    socket.on('error',()=>console.log('network denied')); socket.on('timeout',()=>{console.log('network denied');socket.destroy()});
  `);
  const priorSecret = process.env.CCCP_HOST_SECRET; process.env.CCCP_HOST_SECRET = 'synthetic-host-secret';
  let result;
  try { result = await runner.run(request); }
  finally { if (priorSecret === undefined) delete process.env.CCCP_HOST_SECRET; else process.env.CCCP_HOST_SECRET = priorSecret; }
  assert.equal(result.outcome, 'SUCCEEDED'); assert.equal(result.simulation, false);
  assert.equal(await readFile(join(dir, 'src', 'result'), 'utf8'), 'effect'); assert.match(result.stdout, /network denied/); await noContainer(result);
});
test('real Docker binding rejects undelegated paths and junctions before execution', real, async () => {
  const { dir, runner, request } = await fixture("require('fs').writeFileSync('src/result','bad')");
  await assert.rejects(runner.run({ ...request, operation: operationFixture({ paths: ['tests'] }) }), error => error.code === 'AUTHORITY_BOUNDARY_EXCEEDED');
  await mkdir(join(dir, 'outside')); await symlink(join(dir, 'outside'), join(dir, 'src', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await runner.run(request); assert.equal(result.error_code, 'UNSAFE_MOUNT'); assert.notEqual(result.outcome, 'SUCCEEDED');
  await rm(join(dir, 'src', 'escape'));
});
test('real nonzero exits distinguish clean failure from changed files, including ignored files', real, async () => {
  const clean = await fixture('process.exit(2)', { write: false });
  assert.equal((await clean.runner.run(clean.request)).outcome, 'FAILED_CLEAN');
  const changed = await fixture("const fs=require('fs');fs.mkdirSync('src/node_modules');fs.writeFileSync('src/node_modules/effect','changed');process.exit(2)");
  const result = await changed.runner.run(changed.request); assert.equal(result.outcome, 'EFFECT_UNKNOWN'); assert.equal(result.process_tree_stopped, true); await noContainer(result);
});
test('real timeout stops detached descendants and preserves partial effects as interrupted', real, async () => {
  const { dir, runner, request } = await fixture(`
    require('child_process').spawn(process.execPath,['-e',"setInterval(()=>require('fs').appendFileSync('/workspace/src/ticks','x'),20)"],{detached:true,stdio:'ignore'}).unref();
    setInterval(()=>{},1000);
  `, { policy: { timeout_ms: 1500 } });
  const result = await runner.run(request); assert.equal(result.outcome, 'INTERRUPTED'); assert.equal(result.interruption_reason, 'timeout'); assert.equal(result.process_tree_stopped, true);
  const first = await readFile(join(dir, 'src', 'ticks'), 'utf8'); await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(await readFile(join(dir, 'src', 'ticks'), 'utf8'), first); await noContainer(result);
});
test('real output flood is bounded and file-size limits are enforced by the container', real, async () => {
  const flood = await fixture("setInterval(()=>process.stdout.write('x'.repeat(32768)),1)");
  const result = await flood.runner.run(flood.request); assert.equal(result.outcome, 'INTERRUPTED'); assert.equal(result.interruption_reason, 'output_limit');
  assert.ok(Buffer.byteLength(result.stdout + result.stderr) <= 4096); await noContainer(result);
  const large = await fixture("require('fs').writeFileSync('src/large',Buffer.alloc(4194304))");
  assert.notEqual((await large.runner.run(large.request)).outcome, 'SUCCEEDED');
  const memory = await fixture('const retained=[];while(true)retained.push(Buffer.alloc(16777216,1))');
  const exhausted = await memory.runner.run(memory.request);
  assert.equal(exhausted.outcome, 'INTERRUPTED'); assert.equal(exhausted.interruption_reason, 'resource_or_signal'); await noContainer(exhausted);
});
test('real Host execution persists real evidence; Human Stop cannot be undone by completion', real, async () => {
  const dir = await directory(), fixture = await dockerHost(dir); await prepareSimulation(fixture);
  try {
    const executed = await fixture.call('executeTool', 'codex', { operation_id: 'op-1', attempt_id: 'real' }, { key: 'real' });
    const evidence = await fixture.providers.evidence.verify(executed.result.evidence_ref, { task_id: 'docker-task' });
    assert.equal(evidence.simulation, false); assert.equal(evidence.producer, 'process-tool-runner'); assert.equal(fixture.host.manifest.capabilities.real_agents, false);
  } finally { await fixture.host.close(); fixture.database.close(); }
  const stopDir = await directory(), stop = await dockerHost(stopDir, { source: "require('fs').writeFileSync('src/started','yes');setInterval(()=>{},1000)" });
  await prepareSimulation(stop);
  try {
    const running = stop.call('executeTool', 'codex', { operation_id: 'op-1', attempt_id: 'stop' }, { key: 'stop' });
    const rejected = assert.rejects(running, error => error.code === 'EXECUTION_INTERRUPTED');
    const deadline = Date.now() + 20000;
    while (true) { try { await readFile(join(stop.repository, 'src', 'started')); break; } catch { if (Date.now() > deadline) throw new Error('Tool did not start'); await new Promise(resolve => setTimeout(resolve, 25)); } }
    const identity = (await stop.providers.tool.inspect('stop')).identity;
    const container = JSON.parse((await exec('docker', ['--context', 'desktop-linux', 'container', 'inspect', `cccp-${identity}`], { windowsHide: true, timeout: 15000 })).stdout)[0];
    assert.equal(container.HostConfig.NetworkMode, 'none'); assert.equal(container.HostConfig.ReadonlyRootfs, true);
    assert.equal(container.HostConfig.Memory, 268435456); assert.equal(container.HostConfig.MemorySwap, 268435456);
    assert.equal(container.HostConfig.PidsLimit, 64); assert.equal(container.HostConfig.NanoCpus, 1000000000);
    assert.deepEqual(container.HostConfig.CapDrop, ['ALL']); assert.ok(container.HostConfig.SecurityOpt.includes('no-new-privileges'));
    await stop.call('stopTask', 'human', { reason: 'Container cancellation acceptance' }); await rejected;
    const observed = await stop.call('inspectTask', 'human'); assert.equal(observed.snapshot.human_stopped, true);
    assert.equal(observed.result.operations[0].result.process_tree_stopped, true);
  } finally { await stop.host.close(); stop.database.close(); }
});
test('real Host SIGKILL leaves an orphan container that recovery stops without rerunning its effect', real, async () => {
  const dir = await directory(), script = fileURLToPath(new URL('./fixtures/docker-host.mjs', import.meta.url));
  const child = fork(script, [dir], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  try {
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`Child did not start: ${errors}`)), 40000); child.once('message', () => { clearTimeout(timer); resolve(); }); child.once('error', reject); child.once('exit', () => { clearTimeout(timer); reject(new Error(errors)); }); });
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
    const recovered = await dockerHost(dir, { start: false, recover: true });
    try {
      const observed = await recovered.call('inspectTask', 'human'); assert.equal(observed.snapshot.state, 'BLOCKED');
      assert.equal(observed.result.operations[0].outcome, 'EFFECT_UNKNOWN'); assert.equal(observed.result.operations[0].reconciliation.stopped, true);
      assert.equal(await readFile(join(recovered.repository, 'src', 'orphan.txt'), 'utf8'), 'effect');
    } finally { await recovered.host.close(); recovered.database.close(); }
  } finally { child.kill(); }
});
