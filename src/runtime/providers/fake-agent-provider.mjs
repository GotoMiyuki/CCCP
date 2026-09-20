import { AgentProvider } from './agent-provider.mjs';
import { jsonCopy, nonempty, version, validateContext } from '../contracts.mjs';
import { requireRuntime, RuntimeError } from '../errors.mjs';

// Scripts are trusted constructor data; requests cannot install executable code.
export class FakeAgentProvider extends AgentProvider {
  #scripts; #runs = new Map(); #cancel = new Map();
  constructor({ scripts = {} } = {}) { super(); this.#scripts = jsonCopy(scripts); }
  async capabilities() { return { simulation: true, cancellation: true }; }
  async deliberate(request) { return this.#run('deliberate', request); }
  async implement(request) { return this.#run('implement', request); }
  async review(request) { return this.#run('review', request); }
  async #run(kind, input) {
    const request = jsonCopy(input); validateContext(request.context);
    nonempty(request.run_id, 'run_id'); nonempty(request.template_version, 'template_version');
    requireRuntime(!this.#runs.has(request.run_id), 'RUN_ALREADY_EXISTS', 'Run ID cannot be reused');
    const script = Object.hasOwn(this.#scripts, request.run_id) ? this.#scripts[request.run_id] : Object.hasOwn(this.#scripts, kind) ? this.#scripts[kind] : null;
    requireRuntime(script, 'FAKE_SCRIPT_MISSING', 'Host did not configure a fake Agent output');
    version(script.delay_ms ?? 0, 'delay_ms');
    const started = Date.now();
    let run = jsonCopy({ ...request, kind, provider: 'fake', model: 'scripted', principal: request.context.principal,
      role: request.context.principal.role, status: 'RUNNING', output: null, termination_reason: null,
      started_at: new Date(started).toISOString(), finished_at: null, usage: { tokens: 0, duration_ms: 0 }, simulation: true });
    this.#runs.set(request.run_id, run);
    if (script.delay_ms) await new Promise(resolve => {
      const timer = setTimeout(() => { this.#cancel.delete(request.run_id); resolve(); }, script.delay_ms);
      this.#cancel.set(request.run_id, () => { clearTimeout(timer); resolve(); });
    });
    const cancelled = this.#runs.get(request.run_id).status === 'INTERRUPTED';
    run = jsonCopy({ ...run, status: cancelled ? 'INTERRUPTED' : script.error ? 'FAILED' : 'COMPLETED',
      output: cancelled || script.error ? null : script.output ?? null,
      termination_reason: cancelled ? 'cancelled' : script.error ? 'scripted_failure' : 'completed',
      finished_at: new Date().toISOString(), usage: { tokens: 0, duration_ms: Date.now() - started } });
    this.#runs.set(request.run_id, run); this.#cancel.delete(request.run_id);
    if (script.error && !cancelled) throw new RuntimeError('AGENT_FAILED', 'Scripted fake Agent failure');
    return run;
  }
  async cancel(id) {
    const run = this.#runs.get(id);
    if (!run || run.status !== 'RUNNING') return false;
    this.#runs.set(id, jsonCopy({ ...run, status: 'INTERRUPTED', termination_reason: 'cancelled' }));
    this.#cancel.get(id)?.(); this.#cancel.delete(id); return true;
  }
  async inspect(id) { return this.#runs.has(id) ? jsonCopy(this.#runs.get(id)) : null; }
}
