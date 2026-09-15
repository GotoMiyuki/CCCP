import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CONTRACT, DECISION_STATES, EXECUTION_STATES } from '../src/contracts.mjs';

const outputs = {
  'core.schema.json': CONTRACT,
  ...Object.fromEntries(Object.entries({ 'message-envelope': 'Envelope', 'delegation': 'Delegation', 'permissions': 'Permissions', 'project-profile': 'Profile', 'review-result': 'ReviewResult', 'specification': 'Specification' }).map(([file, def]) => [`${file}.schema.json`, { ...CONTRACT, $id: `urn:cccp:implementation:0.1:${file}`, $ref: `#/$defs/${def}` }])),
  'state-machine.schema.json': { $schema: CONTRACT.$schema, $id: 'urn:cccp:implementation:0.1:state-machine', type: 'object', properties: {
    decision_state: { enum: DECISION_STATES }, execution_state: { enum: EXECUTION_STATES }, revision_count: { type: 'integer', minimum: 0 },
  }, required: ['decision_state', 'execution_state', 'revision_count'], additionalProperties: false },
  'state-machine.json': {
    protocol: 'CCCP', version: '1.0', implementation_revision: '0.1',
    decision: {
      states: DECISION_STATES,
      transitions: [
        ['INTENT', 'PROPOSAL', 'propose'], ['PROPOSAL', 'DELIBERATION', 'deliberate'], ['DELIBERATION', 'DECISION_PENDING', 'requestDecision'],
        ['DECISION_PENDING', 'APPROVED', 'Human approve'], ['DECISION_PENDING', 'REJECTED', 'Human reject'], ['APPROVED', 'SPECIFIED', 'specify'], ['SPECIFIED', 'DELEGATED', 'Human delegate'],
      ],
      refinements: { propose_from: ['PROPOSAL', 'DELIBERATION'], deliberate_from: ['DELIBERATION'] },
      directed: ['INTENT', 'APPROVED', 'Human directly supplies the chosen design (Guide section 32)'],
    },
    execution: {
      states: EXECUTION_STATES,
      transitions: [
        ['DISCOVERY', 'IMPLEMENTATION_PLANNED', 'plan with Discovery and authorization'], ['IMPLEMENTATION_PLANNED', 'IMPLEMENTING', 'begin with fresh Reality'],
        ['IMPLEMENTING', 'VERIFYING', 'report'], ['VERIFYING', 'SPEC_REVIEW', 'R1 APPROVE with evidence'], ['SPEC_REVIEW', 'REVIEW_ROUTING', 'R2 all requirements PASS'],
        ['REVIEW_ROUTING', 'DONE', 'R3 not required'], ['REVIEW_ROUTING', 'ARCHITECTURE_REVIEW', 'R3 required'],
        ['ARCHITECTURE_REVIEW', 'DONE', 'R3 APPROVE'], ['ARCHITECTURE_REVIEW', 'HUMAN_ACCEPTANCE', 'R3 APPROVE and profile requires acceptance'], ['HUMAN_ACCEPTANCE', 'DONE', 'Human accept'],
        ...['VERIFYING', 'SPEC_REVIEW', 'ARCHITECTURE_REVIEW'].flatMap(state => [[state, 'REVISION', 'REVISION_RECOMMENDED and loop policy permits'], [state, 'REPLAN_PROPOSED', 'REPLAN_RECOMMENDED']]),
        ['REVISION', 'IMPLEMENTING', 'fresh Reality and new progress information'],
      ],
      replan_handoff: { from: 'REPLAN_PROPOSED', decision_layer: 'DECISION_PENDING / Deliberation', return_to: 'DISCOVERY', requires: 'New Human-approved Decision + Specification + Delegation' },
    },
    common: { blocked: 'Any state can enter BLOCKED with a structured reason', resume: 'Return to recorded appropriate state after resolution; repository conflicts rediscover; authority changes require Human authorization; loop budgets cannot be silently reset', override: 'Human may explicitly accept DONE or terminate BLOCKED; preserve review evidence and audit override' },
  },
};
const directory = fileURLToPath(new URL('../schemas/', import.meta.url));
const check = process.argv.includes('--check');
if (!check) await mkdir(directory, { recursive: true });
for (const [name, schema] of Object.entries(outputs)) {
  const content = `${JSON.stringify(schema, null, 2)}\n`; const path = `${directory}${name}`;
  if (check) {
    if (await readFile(path, 'utf8').catch(() => '') !== content) throw new Error(`${name} is out of date; run npm run schemas`);
  } else await writeFile(path, content);
}
console.log(`${check ? 'Checked' : 'Exported'} ${Object.keys(outputs).length} schema / state artifacts.`);
