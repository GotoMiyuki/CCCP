// Internal coordination shared by adapters attached to the same controller.
const sessions = new WeakMap();
export function executionSession(controller) {
  if (!sessions.has(controller)) sessions.set(controller, { busy: false, attempted: new Set(), discoveryOptions: {} });
  return sessions.get(controller);
}
