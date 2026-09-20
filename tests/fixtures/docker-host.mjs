import { access, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HostRuntime, SqliteDatabase, SqliteStateStore, SqliteEvidenceStore, SqliteIdentityProvider, GitWorkspaceManager, ProcessToolRunner, FakeAgentProvider } from '../../src/index.mjs';
import { approvalFixture, human, codex } from '../../examples/fixtures.mjs';
import { prepareSimulation } from '../../examples/runtime-workflow.mjs';
const exec = promisify(execFile);

export async function dockerHost(directory, { source = "require('fs').writeFileSync('src/result.txt','one real effect'); console.log('real command')", start = true, recover = false } = {}) {
  const repository = join(directory, 'repo');
  try { await access(join(repository, '.git')); }
  catch {
    await mkdir(join(repository, 'src'), { recursive: true }); await writeFile(join(repository, 'src', 'input.txt'), 'fixture');
    const git = args => exec('git', args, { cwd: repository, windowsHide: true });
    await git(['init']); await git(['add', '.']); await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  }
  const database = await SqliteDatabase.open({ path: join(directory, 'runtime.sqlite') });
  try {
    const workspace = await GitWorkspaceManager.create({ database, root: join(directory, 'workspaces') });
    const registered = await workspace.register({ workspace_ref: 'docker-workspace', repository });
    const tool = await ProcessToolRunner.create({ context: 'desktop-linux', image: process.env.CCCP_DOCKER_IMAGE, bindings: {
      'op-1': { domain: 'internal_implementation', paths: ['src'], write: true, argv: ['/usr/local/bin/node', '-e', source] },
    } });
    const providers = { workspace, tool, state: new SqliteStateStore({ database }), evidence: new SqliteEvidenceStore({ database }), agent: new FakeAgentProvider(),
      identity: new SqliteIdentityProvider({ database, sessions: [human, codex].map(principal => ({ credential: `docker-${principal.role}`, principal, task_ids: ['docker-task'], expires_at: 4102444800000 })) }) };
    const host = await HostRuntime.create({ providers, requiredCapabilities: ['crash_recovery', 'os_sandbox', 'cross_process_leases'] });
    const { intent, decision, specification, delegation, profile } = approvalFixture({ repository: registered.repository_identity }).snapshot;
    const context = { task_id: 'docker-task', workspace_ref: 'docker-workspace', delegation_ref: delegation.id, state_version: 0, correlation_id: 'docker' }; let serial = 0;
    const request = (role, payload = {}, { key } = {}) => ({ credential: `docker-${role}`, context: { ...context, correlation_id: `docker-${++serial}` }, payload, ...(key ? { idempotency_key: key } : {}) });
    const update = response => { context.state_version = response.context.state_version; return response; };
    const call = async (method, role, payload, options) => update(await host[method](request(role, payload, options)));
    if (start) await call('startTask', 'human', { intent, decision, specification, delegation, profile });
    if (recover) await call('recoverTask', 'human');
    return { host, providers, database, call, request, update, context, specification, repository: registered.repository_identity };
  } catch (error) { database.close(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2]) {
  const fixture = await dockerHost(process.argv[2], { source: "require('fs').writeFileSync('src/orphan.txt','effect'); setInterval(()=>{},1000)" });
  await prepareSimulation(fixture);
  const running = fixture.call('executeTool', 'codex', { operation_id: 'op-1', attempt_id: 'orphan' }, { key: 'orphan' });
  const deadline = Date.now() + 20000;
  while (true) {
    try { await access(join(fixture.repository, 'src', 'orphan.txt')); break; }
    catch { if (Date.now() >= deadline) throw new Error('Container never produced its effect'); await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  process.send?.({ phase: 'effect', repository: fixture.repository });
  await running;
}
