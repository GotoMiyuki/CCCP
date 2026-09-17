import { unsupported } from '../errors.mjs';

// SPI contract: see docs/HOST_RUNTIME_SPEC.md for request and result shapes.
export class StateStore {
  async capabilities() { return unsupported('StateStore.capabilities'); }
  async create() { return unsupported('StateStore.create'); }
  async read() { return unsupported('StateStore.read'); }
  async compareAndSwap() { return unsupported('StateStore.compareAndSwap'); }
  async claim() { return unsupported('StateStore.claim'); }
  async settle() { return unsupported('StateStore.settle'); }
}
