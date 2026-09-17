import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { digest } from '../../audit.mjs';
import { relativePath } from '../../authority.mjs';
import { requireRuntime } from '../errors.mjs';

// Unlike Discovery, this inventory includes ignored files. Links and hard links
// are refused: a writable mount must not alias an undelegated host file.
export async function effectSnapshot(repository, paths, { maxEntries = 20000, maxBytes = 64 * 1024 * 1024 } = {}) {
  const root = await realpath(repository), entries = []; let bytes = 0;
  async function visit(path, name) {
    requireRuntime(entries.length < maxEntries, 'UNSAFE_MOUNT', 'Mount inventory exceeds configured bound');
    const stat = await lstat(path);
    requireRuntime(!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile() && stat.nlink === 1), 'UNSAFE_MOUNT', 'Links and special files cannot be mounted');
    const resolved = await realpath(path), rel = relative(root, resolved);
    requireRuntime(rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel), 'UNSAFE_MOUNT', 'Mount escapes repository');
    requireRuntime(!name.split('/').some(part => part.toLowerCase() === '.git'), 'UNSAFE_MOUNT', 'Git metadata cannot be exposed to tools');
    if (stat.isDirectory()) {
      entries.push({ path: name, type: 'directory', mode: stat.mode });
      for (const child of (await readdir(path)).sort()) await visit(join(path, child), `${name}/${child}`);
    } else {
      bytes += stat.size; requireRuntime(bytes <= maxBytes, 'UNSAFE_MOUNT', 'Mount content exceeds configured inventory bound');
      const content = await readFile(path), after = await lstat(path);
      requireRuntime(after.ino === stat.ino && after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs, 'UNSAFE_MOUNT', 'File changed during inventory');
      entries.push({ path: name, type: 'file', mode: stat.mode, hash: digest(content.toString('base64')) });
    }
  }
  for (const input of [...new Set(paths.map(relativePath))].sort()) {
    requireRuntime(input !== '.', 'UNSAFE_MOUNT', 'Whole-repository mounts are not supported');
    // Check every parent, including junctions pointing back inside the repository.
    let parent = root;
    for (const component of input.split('/')) {
      requireRuntime(component && !/[\r\n,]/.test(component), 'UNSAFE_MOUNT', 'Invalid mount path');
      parent = join(parent, component);
      requireRuntime(!(await lstat(parent)).isSymbolicLink(), 'UNSAFE_MOUNT', 'Mount ancestors must not be links');
    }
    await visit(join(root, input), input);
  }
  return { fingerprint: digest(entries), entries: entries.length, bytes };
}

export function executionOutcome({ exitCode, interrupted, stopped, before, after }) {
  if (!stopped || !after) return 'EFFECT_UNKNOWN';
  if (interrupted) return 'INTERRUPTED';
  if (exitCode === 0) return 'SUCCEEDED';
  return before.fingerprint === after.fingerprint ? 'FAILED_CLEAN' : 'EFFECT_UNKNOWN';
}

export function requiresReconciliation(operation) {
  return operation.phase === 'RUNNING' || operation.simulation === false && operation.result?.process_tree_stopped !== true && operation.reconciliation?.stopped !== true;
}
