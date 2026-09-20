import { randomUUID } from 'node:crypto';
import { OpenAIReviewProvider } from './openai-review-provider.mjs';

// DeepSeek's Responses API is wire-compatible for the structured review call,
// while preserving its own provider identity in capabilities, bindings and runs.
export class DeepSeekReviewProvider extends OpenAIReviewProvider {
  constructor({ baseUrl = 'https://api.deepseek.com', providerId = `deepseek-reviewer:${randomUUID()}`, ...options } = {}) {
    super({ ...options, baseUrl, providerId, backend: 'deepseek-responses', providerName: 'deepseek-responses',
      providerKind: 'deepseek-reviewer', apiLabel: 'DeepSeek', background: false, storeResponses: false, metadata: false,
      remoteReconciliation: false, reasoningEffort: options.reasoningEffort ?? 'none' });
  }
}
