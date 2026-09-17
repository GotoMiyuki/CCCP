export class RuntimeError extends Error {
  constructor(code, message, options) {
    super(message, options); this.name = 'RuntimeError'; this.code = code;
  }
}
export function requireRuntime(condition, code, message) {
  if (!condition) throw new RuntimeError(code, message);
}
export function unsupported(feature) {
  throw new RuntimeError('UNSUPPORTED_CAPABILITY', `${feature} is not implemented by this provider`);
}
