import { unsupported } from '../errors.mjs';

// SPI contract: see docs/HOST_RUNTIME_SPEC.md for request and result shapes.
export class EvidenceStore {
  async capabilities() { return unsupported('EvidenceStore.capabilities'); }
  async put() { return unsupported('EvidenceStore.put'); }
  async read() { return unsupported('EvidenceStore.read'); }
  async verify() { return unsupported('EvidenceStore.verify'); }
}
