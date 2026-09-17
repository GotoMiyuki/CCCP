import { writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { durableFixture } from './durable-host.mjs';
import { prepareSimulation, simulationReport, simulationReview } from '../../examples/runtime-workflow.mjs';
import { SqliteDatabase, SqliteStateStore, DurableBridge } from '../../src/index.mjs';
import { codex } from '../../examples/fixtures.mjs';

const [phase, directory] = process.argv.slice(2);
const crash = () => { writeSync(1, `CRASH:${phase}\n`); process.kill(process.pid, 'SIGKILL'); };
if (phase === 'cas') {
  const database = await SqliteDatabase.open({ path: join(directory, 'cas.sqlite') });
  try {
    await new SqliteStateStore({ database }).compareAndSwap('task', 0, { snapshot: { state_version: 1 }, writer: process.pid }); console.log('CAS_OK');
  } catch (error) { console.log(error.code); } finally { database.close(); }
} else {
  const sim = await durableFixture(directory, { start: false });
  if (phase.startsWith('approval_')) {
    sim.database.fault = point => {
      if (point !== (phase === 'approval_before' ? 'state_staged' : 'after_commit')) return;
      if (sim.database.db.prepare('SELECT 1 FROM tasks').get()) crash();
    };
    await sim.call('startTask', 'human', sim.initialPayload, { key: 'create' });
  } else if (phase === 'outbox_after_send') {
    const session = { id: 'crash-bridge', token: 'crash-bridge-token', actor: codex, task_id: 'outbox-task',
      repository: { path: directory, branch: null, commit: null }, allowed_types: ['DISCOVERY_REQUEST'], expires_at: 4102444800000 };
    const bridge = new DurableBridge({ state: sim.providers.state, sessions: [session] });
    await bridge.queue(session.token, { protocol: 'CCCP', version: '1.0', message_type: 'DISCOVERY_REQUEST', message_id: 'outbox-message', task_id: session.task_id,
      repository: session.repository, timestamp: '2026-09-17T00:00:00Z', payload: { related_paths: ['src'] } });
    await bridge.flush('outbox-task', async message => { writeFileSync(join(directory, 'delivery.txt'), message.idempotency_key); crash(); });
  } else {
    await sim.call('startTask', 'human', sim.initialPayload, { key: 'create' }); await prepareSimulation(sim);
    if (phase === 'tool_started') {
      sim.providers.tool.run = async () => { writeFileSync(join(directory, 'effect.txt'), 'one effect'); crash(); };
      await sim.call('executeTool', 'codex', { operation_id: 'op-1', attempt_id: 'crashed-attempt' }, { key: 'crashed-tool' });
    } else if (phase === 'stop_after') {
      sim.database.fault = point => {
        if (point === 'after_commit' && JSON.parse(sim.database.db.prepare('SELECT data FROM tasks').get().data).snapshot.human_stopped) crash();
      };
      await sim.call('stopTask', 'human', { reason: 'Persisted Human Stop before crash' }, { key: 'stop' });
    } else if (phase === 'r2_after') {
      const executed = await sim.call('executeTool', 'codex', { operation_id: 'op-1', attempt_id: 'attempt' }, { key: 'tool' }), ref = executed.result.evidence_ref;
      await sim.call('submitReport', 'codex', simulationReport(sim, executed.snapshot));
      await sim.call('submitReview', 'codex', { review: simulationReview(sim, 'R1', ref), evidence_refs: [ref] });
      sim.database.fault = point => {
        if (point === 'after_commit' && JSON.parse(sim.database.db.prepare('SELECT data FROM tasks').get().data).snapshot.state === 'REVIEW_ROUTING') crash();
      };
      await sim.call('submitReview', 'codex', { review: simulationReview(sim, 'R2', ref), evidence_refs: [ref] }, { key: 'r2' });
    } else throw new Error(`Unknown crash phase: ${phase}`);
  }
  throw new Error('Expected the process to be killed at the injected crash point');
}
