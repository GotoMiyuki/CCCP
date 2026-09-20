import { join } from 'node:path';
import { SqliteDatabase, SqliteStateStore, SqliteEvidenceStore, SqliteIdentityProvider, MemoryWorkspaceManager, FakeToolRunner, FakeAgentProvider, HostRuntime, defaultProfile } from '../../src/index.mjs';
import { approvalFixture, human, codex, chatgpt, discoveryFixture } from '../../examples/fixtures.mjs';

export async function durableFixture(directory, { start = true, recover = false, tool, agent, fault, taskId = 'durable-task', humanAcceptance = false, discovery = async path => discoveryFixture(path) } = {}) {
  const repository = join(directory, 'repo');
  const database = await SqliteDatabase.open({ path: join(directory, 'runtime.sqlite') });
  if (fault) database.fault = fault;
  const providers = {
    state: new SqliteStateStore({ database, snapshotInterval: 3 }), evidence: new SqliteEvidenceStore({ database }),
    identity: new SqliteIdentityProvider({ database, sessions: [human, codex, chatgpt].map(principal => ({ credential: `durable-${principal.role}`,
      principal, task_ids: [taskId], expires_at: 4102444800000 })) }),
    workspace: new MemoryWorkspaceManager({ workspaces: [{ workspace_ref: 'durable-workspace', repository }] }),
    tool: tool ?? new FakeToolRunner({ scripts: { 'op-1': { stdout: 'Durable simulation' } } }), agent: agent ?? new FakeAgentProvider(),
  };
  const host = await HostRuntime.create({ providers, discovery });
  const configuredProfile = defaultProfile(repository);
  if (humanAcceptance) { configuredProfile.review.human_acceptance = true; configuredProfile.review.require_r3 = true; }
  const { intent, decision, specification, delegation, profile } = approvalFixture({ repository, profile: configuredProfile }).snapshot;
  const context = { task_id: taskId, delegation_ref: delegation.id, workspace_ref: 'durable-workspace', state_version: 0, correlation_id: 'durable' };
  let serial = 0;
  const request = (role, payload = {}, { key } = {}) => ({ credential: `durable-${role}`, context: { ...context, correlation_id: `call-${++serial}` }, payload, ...(key ? { idempotency_key: key } : {}) });
  const update = response => { context.state_version = response.context.state_version; return response; };
  const call = async (method, role, payload = {}, options) => update(await host[method](request(role, payload, options)));
  if (start) await call('startTask', 'human', { intent, decision, specification, delegation, profile }, { key: 'create' });
  if (recover) await call('recoverTask', 'human');
  return { host, database, providers, context, request, update, call, specification, repository, initialPayload: { intent, decision, specification, delegation, profile } };
}
