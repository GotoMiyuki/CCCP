import { unsupported } from '../errors.mjs';

// SPI contract: see docs/HOST_RUNTIME_SPEC.md for request and result shapes.
export class IdentityProvider {
  async capabilities() { return unsupported('IdentityProvider.capabilities'); }
  async authenticate() { return unsupported('IdentityProvider.authenticate'); }
  async revoke() { return unsupported('IdentityProvider.revoke'); }
}
