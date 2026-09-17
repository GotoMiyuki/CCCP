import { createHash } from 'node:crypto';
import { immutable } from './contracts.mjs';

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');

export class AuditLog {
  #entries = [];
  append(type, actor, data) {
    const entry = { sequence: this.#entries.length + 1, timestamp: new Date().toISOString(), type,
      actor: structuredClone(actor), data: structuredClone(data), previous_hash: this.#entries.at(-1)?.hash ?? null };
    entry.hash = digest(entry);
    this.#entries.push(immutable(entry));
    return this.#entries.at(-1);
  }
  get entries() { return immutable(this.#entries); }
  static verify(entries) {
    return entries.every((entry, i) => {
      const { hash, ...rest } = entry;
      return entry.sequence === i + 1 && entry.previous_hash === (entries[i - 1]?.hash ?? null) && hash === digest(rest);
    });
  }
}
