import { unsupported } from '../errors.mjs';

// SPI contract: see docs/HOST_RUNTIME_SPEC.md for request and result shapes.
export class ToolRunner {
  async capabilities() { return unsupported('ToolRunner.capabilities'); }
  async run() { return unsupported('ToolRunner.run'); }
  async cancel() { return unsupported('ToolRunner.cancel'); }
  async inspect() { return unsupported('ToolRunner.inspect'); }
}
