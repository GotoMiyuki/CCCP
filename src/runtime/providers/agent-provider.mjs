import { unsupported } from '../errors.mjs';

// SPI contract: see docs/HOST_RUNTIME_SPEC.md for request and result shapes.
export class AgentProvider {
  async capabilities() { return unsupported('AgentProvider.capabilities'); }
  async deliberate() { return unsupported('AgentProvider.deliberate'); }
  async implement() { return unsupported('AgentProvider.implement'); }
  async review() { return unsupported('AgentProvider.review'); }
  async cancel() { return unsupported('AgentProvider.cancel'); }
  async inspect() { return unsupported('AgentProvider.inspect'); }
}
