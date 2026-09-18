import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ChatGPTReviewProvider, CodexAgentProvider, GitWorkspaceManager, HostRuntime, OpenAIReviewProvider, ProcessToolRunner,
  RoutedAgentProvider, SqliteDatabase, SqliteEvidenceStore, SqliteIdentityProvider, SqliteStateStore, defaultProfile } from '../../src/index.mjs';
import { approvalFixture, chatgpt, codex, human } from '../../examples/fixtures.mjs';

const exec = promisify(execFile);
const applySource = `let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{const fs=require('fs'),p=require('path');const input=JSON.parse(data);for(const change of input.file_changes){if(!change.path.startsWith('src/')||change.path.includes('..'))throw Error('invalid path');const target=p.resolve('/workspace',change.path);if(!target.startsWith('/workspace/src/'))throw Error('escaped path');fs.writeFileSync(target,change.content)}});`;

export async function realAgentHost(directory, { start = true, recover = false, taskId = 'm4-real-task' } = {}) {
  const repository = join(directory, 'fixture-repository');
  try { await access(join(repository, '.git')); }
  catch {
    await mkdir(join(repository, 'src'), { recursive: true }); await mkdir(join(repository, 'tests'), { recursive: true });
    await writeFile(join(repository, 'src', 'value.txt'), 'pending\n');
    await writeFile(join(repository, 'tests', 'verify.mjs'), "import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';assert.equal(await readFile('src/value.txt','utf8'),'ready\\n');console.log('fixture pass');\n");
    const git = args => exec('git', args, { cwd: repository, windowsHide: true });
    await git(['init']); await git(['add', '.']); await git(['-c', 'user.name=CCCP Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture baseline']);
  }
  const database = await SqliteDatabase.open({ path: join(directory, 'runtime.sqlite') });
  try {
    const workspace = await GitWorkspaceManager.create({ database, root: join(directory, 'workspaces') });
    const registered = await workspace.register({ workspace_ref: 'm4-workspace', repository });
    const tool = await ProcessToolRunner.create({ context: process.env.CCCP_DOCKER_CONTEXT, image: process.env.CCCP_DOCKER_IMAGE, bindings: {
      'apply-agent-change': { domain: 'internal_implementation', paths: ['src'], write: true, accepts_agent_input: true, argv: ['/usr/local/bin/node', '-e', applySource] },
      'run-fixture-tests': { domain: 'test_implementation', paths: ['src', 'tests'], write: false, argv: ['/usr/local/bin/node', '/workspace/tests/verify.mjs'] },
    } });
    const implementer = new CodexAgentProvider({ cwd: registered.repository_identity, model: process.env.CCCP_CODEX_MODEL });
    const reviewer = process.env.OPENAI_API_KEY && process.env.CCCP_REVIEW_MODEL
      ? new OpenAIReviewProvider({ apiKey: process.env.OPENAI_API_KEY, model: process.env.CCCP_REVIEW_MODEL })
      : new ChatGPTReviewProvider({ cwd: registered.repository_identity, model: process.env.CCCP_REVIEW_MODEL ?? process.env.CCCP_CODEX_MODEL });
    const providers = { workspace, tool, agent: new RoutedAgentProvider({ implementer, reviewer }), state: new SqliteStateStore({ database }),
      evidence: new SqliteEvidenceStore({ database }), identity: new SqliteIdentityProvider({ database, sessions: [human, codex, chatgpt].map(principal => ({
        credential: `m4-${principal.role}`, principal, task_ids: [taskId], expires_at: 4102444800000 })) }) };
    const host = await HostRuntime.create({ providers, requiredCapabilities: ['durable_state', 'crash_recovery', 'real_agents', 'os_sandbox', 'independent_r3', 'cross_process_leases'] });
    const profile = defaultProfile(registered.repository_identity); profile.review.require_r3 = true; profile.review.human_acceptance = true;
    profile.verification_commands = [['node', 'tests/verify.mjs']];
    const directed = approvalFixture({ repository: registered.repository_identity, profile, delegationPatch: { paths: ['src', 'tests'] } }).snapshot;
    const context = { task_id: taskId, workspace_ref: 'm4-workspace', delegation_ref: directed.delegation.id, state_version: 0, correlation_id: 'm4' };
    let serial = 0;
    const request = (role, payload = {}, key) => ({ credential: `m4-${role}`, context: { ...context, correlation_id: `m4-${++serial}` }, payload, ...(key ? { idempotency_key: key } : {}) });
    const update = response => { context.state_version = response.context.state_version; return response; };
    const call = async (method, role, payload = {}, key) => update(await host[method](request(role, payload, key)));
    if (start) await call('startTask', 'human', { intent: directed.intent, decision: directed.decision, specification: directed.specification,
      delegation: directed.delegation, profile: directed.profile }, 'start');
    if (recover) await call('recoverTask', 'human');
    return { host, database, providers, call, request, update, context, workspace: registered.repository_identity, specification: directed.specification };
  } catch (error) { database.close(); throw error; }
}

export const operations = [
  { id: 'apply-agent-change', domain: 'internal_implementation', paths: ['src'], changes_decision: false, description: 'Apply the real Codex structured file change' },
  { id: 'run-fixture-tests', domain: 'test_implementation', paths: ['src', 'tests'], changes_decision: false, description: 'Run the fixture acceptance test' },
];
