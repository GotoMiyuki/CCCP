import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { validateFileChanges } from './contracts.mjs';
import { requireRuntime } from './errors.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const inside = (root, target) => {
  const rel = relative(root, target);
  return (rel === '' || !rel.startsWith('..') && !isAbsolute(rel));
};

export async function captureAgentFiles(repository, input, { requireExpected = false } = {}) {
  const changes = validateFileChanges(input), root = await realpath(repository), files = []; let bytes = 0;
  for (const change of changes) {
    const target = resolve(root, ...change.path.split('/'));
    requireRuntime(inside(root, target) && inside(root, await realpath(dirname(target))), 'AUTHORITY_BOUNDARY_EXCEEDED', 'Agent file escapes repository');
    try {
      const stat = await lstat(target);
      requireRuntime(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'UNSAFE_MOUNT', 'Agent file must be a regular unlinked file');
      const content = await readFile(target); bytes += content.length;
      requireRuntime(bytes <= 2 * 1024 * 1024, 'INVALID_RUNTIME_CONTRACT', 'Agent diff input exceeds 2 MiB');
      if (requireExpected) requireRuntime(content.equals(Buffer.from(change.content, 'utf8')), 'AGENT_CHANGE_MISMATCH', 'Applied file content differs from Agent candidate');
      files.push({ path: change.path, exists: true, content_hash: sha256(content), content_base64: content.toString('base64') });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      requireRuntime(!requireExpected, 'AGENT_CHANGE_MISMATCH', 'Agent output file was not created');
      files.push({ path: change.path, exists: false, content_hash: null, content_base64: null });
    }
  }
  return files;
}

export function agentFileDelta({ sourceRunId, before, after }) {
  requireRuntime(typeof sourceRunId === 'string' && sourceRunId.length > 0 && before.length === after.length, 'INVALID_RUNTIME_CONTRACT', 'Invalid Agent delta binding');
  return { format: 'cccp-file-delta-v1', source_run_id: sourceRunId, changes: after.map((file, index) => ({ path: file.path,
    before_exists: before[index].exists, before_hash: before[index].content_hash, before_content_base64: before[index].content_base64,
    after_exists: file.exists, after_hash: file.content_hash, after_content_base64: file.content_base64,
    changed: before[index].content_hash !== file.content_hash })) };
}
