import { AgentProvider } from './agent-provider.mjs';
import { CodexAgentProvider } from './codex-agent-provider.mjs';
import { unsupported } from '../errors.mjs';
import { randomUUID } from 'node:crypto';

// Uses a separate App Server client/run under the signed-in ChatGPT account.
// Independence is established by routing only R3 here and by a distinct CCCP principal/run.
export class ChatGPTReviewProvider extends AgentProvider {
  #delegate; #providerId;
  constructor(options = {}) {
    super(); this.#providerId = options.providerId ?? `chatgpt-reviewer:${randomUUID()}`;
    this.#delegate = new CodexAgentProvider({ ...options, providerId: this.#providerId, providerKind: 'chatgpt-reviewer' });
  }
  async capabilities() { return { simulation: false, backend: 'codex-app-server', cancellation: true, recovery: true, independent_review: true,
    provider_id: this.#providerId, review_boundary: 'independent-run' }; }
  async deliberate() { return unsupported('ChatGPTReviewProvider.deliberate'); }
  async implement() { return unsupported('ChatGPTReviewProvider.implement'); }
  review(request) { return this.#delegate.review(request); }
  dispatch(kind, request, options) {
    if (kind !== 'review') return { binding: { backend: 'unsupported' }, result: this.#unsupported(kind) };
    return this.#delegate.dispatch(kind, request, options);
  }
  async #unsupported(kind) { return unsupported(`ChatGPTReviewProvider.${kind}`); }
  cancel(runId) { return this.#delegate.cancel(runId); }
  inspect(runId) { return this.#delegate.inspect(runId); }
  reconcile(run) { return this.#delegate.reconcile(run); }
}
