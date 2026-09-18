import { AgentProvider } from './agent-provider.mjs';
import { jsonCopy, validateCapabilities } from '../contracts.mjs';
import { requireRuntime } from '../errors.mjs';

const requireMethods = (provider, methods, label) => requireRuntime(methods.every(method => typeof provider?.[method] === 'function'),
  'INVALID_PROVIDER', `${label} provider is incomplete`);

export class RoutedAgentProvider extends AgentProvider {
  #implementer; #reviewer; #routes = new Map();
  constructor({ implementer, reviewer }) {
    super();
    requireMethods(implementer, ['capabilities', 'deliberate', 'implement', 'review', 'dispatch', 'cancel', 'inspect', 'reconcile'], 'Implementer');
    requireMethods(reviewer, ['capabilities', 'review', 'dispatch', 'cancel', 'inspect', 'reconcile'], 'Reviewer');
    this.#implementer = implementer; this.#reviewer = reviewer;
  }
  async capabilities() {
    const [implementer, reviewer] = await Promise.all([this.#implementer.capabilities(), this.#reviewer.capabilities()]).then(items => items.map(validateCapabilities));
    requireRuntime(implementer.provider_id && reviewer.provider_id && implementer.provider_id !== reviewer.provider_id
      && reviewer.review_boundary === 'independent-run', 'INVALID_PROVIDER', 'Independent review requires distinct durable provider identities');
    return { simulation: implementer.simulation || reviewer.simulation, ...(implementer.simulation || reviewer.simulation ? {} : { backend: 'routed-agent' }),
      cancellation: implementer.cancellation === true && reviewer.cancellation === true, recovery: implementer.recovery === true && reviewer.recovery === true,
      independent_review: implementer !== reviewer && reviewer.independent_review === true, provider_id: `route:${implementer.provider_id}|${reviewer.provider_id}` };
  }
  deliberate(request) { this.#routes.set(request.run_id, this.#implementer); return this.#implementer.deliberate(request); }
  implement(request) { this.#routes.set(request.run_id, this.#implementer); return this.#implementer.implement(request); }
  review(request) {
    const provider = request.review_level === 'R3' ? this.#reviewer : this.#implementer;
    this.#routes.set(request.run_id, provider); return provider.review(request);
  }
  dispatch(kind, request, options) {
    const provider = kind === 'review' && request.review_level === 'R3' ? this.#reviewer : this.#implementer;
    this.#routes.set(request.run_id, provider);
    if (typeof provider.dispatch === 'function') return provider.dispatch(kind, request, options);
    return { binding: { backend: 'deferred-provider', run_id: request.run_id }, result: provider[kind](request) };
  }
  cancel(runId) { return this.#routes.get(runId)?.cancel(runId) ?? false; }
  inspect(runId) { return this.#routes.get(runId)?.inspect(runId) ?? null; }
  async reconcile(run) {
    const provider = run.kind === 'review' && run.review_level === 'R3' ? this.#reviewer : this.#implementer;
    requireRuntime(typeof provider.reconcile === 'function', 'RECONCILIATION_REQUIRED', 'Real Agent provider must reconcile unfinished runs');
    return jsonCopy(await provider.reconcile(run));
  }
}
