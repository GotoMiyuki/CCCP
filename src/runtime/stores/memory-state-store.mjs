import { StateStore } from './state-store.mjs';
import { jsonCopy, nonempty, record, version } from '../contracts.mjs';
import { requireRuntime } from '../errors.mjs';

export class MemoryStateStore extends StateStore {
  #tasks = new Map(); #requests = new Map();
  async capabilities() { return { simulation: true }; }
  async create(taskId, data) {
    nonempty(taskId, 'taskId'); record(data); const copy = jsonCopy(data);
    requireRuntime(!this.#tasks.has(taskId), 'TASK_EXISTS', 'Task already stored');
    const stored = jsonCopy({ store_revision: 0, data: copy }); this.#tasks.set(taskId, stored); return stored;
  }
  async read(taskId) { return this.#tasks.has(taskId) ? jsonCopy(this.#tasks.get(taskId)) : null; }
  async compareAndSwap(taskId, expectedRevision, data, { settlements = [] } = {}) {
    version(expectedRevision, 'store_revision'); record(data); const copy = jsonCopy(data);
    const prior = this.#tasks.get(taskId);
    requireRuntime(prior && prior.store_revision === expectedRevision, 'STORE_CONFLICT', 'Store revision changed');
    requireRuntime(expectedRevision < Number.MAX_SAFE_INTEGER, 'STORE_CONFLICT', 'Store revision exhausted');
    const completions = settlements.map(({ key, result }) => {
      const prior = this.#requests.get(key);
      requireRuntime(prior?.status === 'PENDING', 'INVALID_IDEMPOTENCY_STATE', 'Only pending claims can settle');
      return [key, jsonCopy({ hash: prior.hash, status: 'SETTLED', result })];
    });
    const stored = jsonCopy({ store_revision: expectedRevision + 1, data: copy }); this.#tasks.set(taskId, stored);
    for (const [key, result] of completions) this.#requests.set(key, result);
    return stored;
  }
  async claim(key, hash) {
    nonempty(key, 'key'); nonempty(hash, 'hash');
    const prior = this.#requests.get(key);
    if (prior) {
      requireRuntime(prior.hash === hash, 'IDEMPOTENCY_CONFLICT', 'Key already identifies different content');
      return jsonCopy({ claimed: false, ...prior });
    }
    const stored = jsonCopy({ hash, status: 'PENDING', result: null }); this.#requests.set(key, stored);
    return jsonCopy({ claimed: true, ...stored });
  }
  async settle(key, result) {
    const copy = jsonCopy(result); const prior = this.#requests.get(key);
    requireRuntime(prior?.status === 'PENDING', 'INVALID_IDEMPOTENCY_STATE', 'Only pending claims can settle');
    this.#requests.set(key, jsonCopy({ hash: prior.hash, status: 'SETTLED', result: copy }));
  }
}
