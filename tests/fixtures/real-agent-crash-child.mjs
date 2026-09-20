import { writeSync } from 'node:fs';
import { realAgentHost, operations } from './real-agent-host.mjs';

const directory = process.argv[2];
const fixture = await realAgentHost(directory);
await fixture.call('discoverTask', 'codex');
await fixture.call('planTask', 'codex', { summary: 'Bounded recovery fixture change', operations });
await fixture.call('beginTask', 'codex');
const implementation = await fixture.call('dispatchAgent', 'codex', { kind: 'implement', run_id: 'recovery-implementation', template_version: 'm4-implement-v1',
  input: { instruction: 'Change only src/value.txt so its exact UTF-8 content is ready followed by one newline. Report specification and discovery identifiers exactly from the supplied CCCP context.' } });
const applied = await fixture.call('executeTool', 'codex', { operation_id: 'apply-agent-change', attempt_id: 'recovery-apply', agent_run_id: 'recovery-implementation' }, 'recovery-apply');
const tested = await fixture.call('executeTool', 'codex', { operation_id: 'run-fixture-tests', attempt_id: 'recovery-test' }, 'recovery-test');
const refs = [applied.result.evidence_ref, tested.result.evidence_ref];
await fixture.call('submitReport', 'codex', { ...implementation.result.output, evidence: refs.map(ref => ref.artifact_ref) });
writeSync(1, 'CRASH:after_real_tools\n');
process.kill(process.pid, 'SIGKILL');
