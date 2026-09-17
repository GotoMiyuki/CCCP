import { ToolRunner } from './tool-runner.mjs';
import { jsonCopy, nonempty, version, validateContext, validateToolResult } from '../contracts.mjs';
import { requireRuntime, RuntimeError } from '../errors.mjs';

export class FakeToolRunner extends ToolRunner {
  #scripts; #runs = new Map(); #cancel = new Map();
  constructor({ scripts = {} } = {}) { super(); this.#scripts = jsonCopy(scripts); }
  async capabilities() { return { simulation: true, cancellation: true }; }
  async run(input) {
    const request = jsonCopy(input); validateContext(request.context); nonempty(request.attempt_id, 'attempt_id');
    requireRuntime(!this.#runs.has(request.attempt_id), 'ATTEMPT_ALREADY_EXISTS', 'Attempt ID cannot be reused');
    const script = Object.hasOwn(this.#scripts, request.operation.id) ? this.#scripts[request.operation.id] : null;
    requireRuntime(script, 'FAKE_SCRIPT_MISSING', 'Host did not configure this fake tool binding');
    version(script.delay_ms ?? 0, 'delay_ms');
    const started = Date.now();
    const initial = jsonCopy({ request, status: 'RUNNING', result: null, simulation: true });
    this.#runs.set(request.attempt_id, initial);
    if (script.delay_ms) await new Promise(resolve => {
      const timer = setTimeout(() => { this.#cancel.delete(request.attempt_id); resolve(); }, script.delay_ms);
      this.#cancel.set(request.attempt_id, () => { clearTimeout(timer); resolve(); });
    });
    const cancelled = this.#runs.get(request.attempt_id).status === 'INTERRUPTED';
    const result = validateToolResult({ outcome: cancelled ? 'INTERRUPTED' : script.error ? 'EFFECT_UNKNOWN' : script.outcome ?? 'SUCCEEDED',
      stdout: cancelled ? '' : script.stdout ?? 'SIMULATED TOOL OUTPUT', stderr: script.stderr ?? '',
      exit_code: cancelled || script.error ? null : script.exit_code ?? 0,
      started_at: new Date(started).toISOString(), finished_at: new Date().toISOString(),
      repository_before: request.repository_snapshot, repository_after: request.repository_snapshot, simulation: true });
    this.#runs.set(request.attempt_id, jsonCopy({ ...initial, status: 'COMPLETED', result })); this.#cancel.delete(request.attempt_id);
    if (script.error && !cancelled) throw new RuntimeError('TOOL_FAILED', 'Scripted fake tool failure; effects are unknown');
    return result;
  }
  async cancel(id) {
    const run = this.#runs.get(id);
    if (!run || run.status !== 'RUNNING') return false;
    this.#runs.set(id, jsonCopy({ ...run, status: 'INTERRUPTED' })); this.#cancel.get(id)?.(); this.#cancel.delete(id); return true;
  }
  async inspect(id) { return this.#runs.has(id) ? jsonCopy(this.#runs.get(id)) : null; }
}
