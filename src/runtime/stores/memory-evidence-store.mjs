import { createHash, randomUUID } from 'node:crypto';
import { EvidenceStore } from './evidence-store.mjs';
import { jsonCopy, validateArtifact, nonempty } from '../contracts.mjs';
import { requireRuntime } from '../errors.mjs';

const contentHash = content => createHash('sha256').update(content, 'utf8').digest('hex');
export class MemoryEvidenceStore extends EvidenceStore {
  #artifacts = new Map();
  async capabilities() { return { simulation: true }; }
  async put(input) {
    const value = validateArtifact(input); const evidence_id = randomUUID(); const content_hash = contentHash(value.content);
    const artifact_ref = `evidence:${evidence_id}:${content_hash}`;
    const artifact = jsonCopy({ ...value, evidence_id, content_hash, artifact_ref, created_at: new Date().toISOString() });
    this.#artifacts.set(evidence_id, artifact);
    return jsonCopy({ evidence_id, content_hash, artifact_ref });
  }
  async read(id) { return this.#artifacts.has(id) ? jsonCopy(this.#artifacts.get(id)) : null; }
  async verify(ref, scope) {
    nonempty(ref?.evidence_id, 'evidence_id'); nonempty(ref.content_hash, 'content_hash'); nonempty(scope?.task_id, 'task_id');
    const artifact = await this.read(ref.evidence_id);
    requireRuntime(artifact && artifact.content_hash === ref.content_hash && contentHash(artifact.content) === ref.content_hash && ref.artifact_ref === artifact.artifact_ref, 'INVALID_EVIDENCE', 'Missing artifact or mismatched content hash/reference');
    requireRuntime(artifact.task_id === scope.task_id && (!scope.operation_id || artifact.operation_id === scope.operation_id), 'EVIDENCE_SCOPE_EXCEEDED', 'Evidence does not belong to this task/operation');
    return artifact;
  }
}
