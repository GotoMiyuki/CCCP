import { createHash, randomUUID } from 'node:crypto';
import { canonical } from '../../audit.mjs';
import { EvidenceStore } from './evidence-store.mjs';
import { jsonCopy, validateArtifact } from '../contracts.mjs';
import { requireRuntime } from '../errors.mjs';

const hash = content => createHash('sha256').update(content, 'utf8').digest('hex');
export class SqliteEvidenceStore extends EvidenceStore {
  constructor({ database }) { super(); this.database = database; }
  async capabilities() { return { simulation: false, backend: 'sqlite', durable: this.database.durable }; }
  async put(input) {
    const value = validateArtifact(input, { allowReal: true });
    const evidence_id = randomUUID(), content_hash = hash(value.content), artifact_ref = `evidence:${evidence_id}:${content_hash}`;
    const artifact = jsonCopy({ ...value, evidence_id, content_hash, artifact_ref, created_at: new Date().toISOString() });
    this.database.db.prepare('INSERT INTO artifacts VALUES(?,?)').run(evidence_id, canonical(artifact));
    return jsonCopy({ evidence_id, content_hash, artifact_ref });
  }
  async read(id) {
    const row = this.database.db.prepare('SELECT data FROM artifacts WHERE id=?').get(id);
    return row ? jsonCopy(JSON.parse(row.data)) : null;
  }
  async verify(ref, scope) {
    const artifact = await this.read(ref.evidence_id);
    requireRuntime(artifact && ref.content_hash === artifact.content_hash && hash(artifact.content) === ref.content_hash && ref.artifact_ref === artifact.artifact_ref, 'INVALID_EVIDENCE', 'Artifact hash/reference differs');
    requireRuntime(artifact.task_id === scope.task_id && (!scope.operation_id || scope.operation_id === artifact.operation_id), 'EVIDENCE_SCOPE_EXCEEDED', 'Artifact belongs to another task/operation');
    return artifact;
  }
}
