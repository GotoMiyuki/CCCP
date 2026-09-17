import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, lstat, readlink, realpath } from 'node:fs/promises';
import { resolve, relative, sep, isAbsolute } from 'node:path';
import { assert, check, immutable } from './contracts.mjs';
import { relativePath } from './authority.mjs';
import { digest } from './audit.mjs';
import { safeGit } from './safe-git.mjs';

const ignored = new Set(['.git', 'node_modules', '.cccp', 'coverage']);
export async function confinedPath(repository, path) {
  const root = await realpath(repository);
  const target = resolve(root, relativePath(path));
  // Check every existing ancestor, including symlinks. New files remain allowed.
  let current = target;
  for (;;) {
    try {
      const actual = await realpath(current); const rel = relative(root, actual);
      assert(rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'INVALID_PATH', `Symlink escapes repository: ${path}`);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = resolve(current, '..');
      assert(parent !== current, 'INVALID_PATH', 'No existing ancestor'); current = parent;
    }
  }
  return target;
}

export async function discover(repository, { relatedPaths = ['.'], context = [], architectureObservations = [], reusableImplementations = [], testStatus = 'unknown', testEvidence = [] } = {}) {
  const root = await realpath(repository);
  assert((await lstat(root)).isDirectory(), 'REPOSITORY_FAILURE', 'Repository path must be a directory');
  const git = async args => (await safeGit(root, args)).stdout;
  let branch = null; let commit = null; let status = null;
  try { await git(['rev-parse', '--git-dir']); }
  catch (error) {
    // A missing Git binary or broken Git repository must not masquerade as a plain directory.
    if (!String(error.stderr).includes('not a git repository')) throw error;
    status = 'not_git';
  }
  let changedFiles = []; let index = null; let rawStatus = null;
  if (status !== 'not_git') {
    try { branch = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim(); }
    catch (error) { if (error.code !== 1) throw error; }
    try { commit = (await git(['rev-parse', '--verify', 'HEAD'])).trim(); }
    catch (error) { if (!String(error.stderr).includes('Needed a single revision')) throw error; }
    const [raw, staged] = await Promise.all([git(['status', '--porcelain=v1', '-z', '--untracked-files=all']), git(['ls-files', '--stage', '-z'])]);
    rawStatus = raw; index = staged;
    const records = raw.split('\0');
    for (let i = 0; i < records.length; i++) {
      const record = records[i]; if (!record) continue;
      changedFiles.push(record.slice(3));
      if (/[RC]/.test(record.slice(0, 2))) changedFiles.push(records[++i]);
    }
    changedFiles = [...new Set(changedFiles)]; status = raw ? 'dirty' : 'clean';
  }
  const files = new Map();
  async function walk(absolute) {
    const info = await lstat(absolute);
    const path = relative(root, absolute).split(sep).join('/');
    if (info.isSymbolicLink()) { files.set(path, { symlink: await readlink(absolute) }); return; }
    if (info.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) if (!ignored.has(name)) await walk(resolve(absolute, name));
    } else if (info.isFile()) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(absolute)) hash.update(chunk);
      const after = await lstat(absolute);
      assert(after.isFile() && info.ino === after.ino && info.size === after.size && info.mtimeMs === after.mtimeMs && info.ctimeMs === after.ctimeMs,
        'REPOSITORY_FAILURE', `File changed during Discovery: ${path}`);
      files.set(path, { hash: hash.digest('hex'), mode: info.mode });
    }
  }
  for (const path of relatedPaths) await walk(await confinedPath(root, path));
  const relatedFiles = [...files.keys()].sort();
  const fingerprint = digest({ repository: root, branch, commit, status, rawStatus, index, changedFiles, files: Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b))) });
  context.forEach(entry => check('ContextEntry', entry));
  const conflicts = context.filter(entry => entry.status !== 'historical' && (entry.status === 'stale' || entry.source_commit === null || commit === null || entry.source_commit !== commit)).map(entry => `Context ${entry.id} requires rediscovery: source_commit=${entry.source_commit}, HEAD=${commit}`);
  const discovery = { repository: { path: root, branch, commit }, base_commit: commit, working_tree_status: status,
    changed_files: changedFiles, related_files: relatedFiles, architecture_observations: architectureObservations,
    reusable_implementations: reusableImplementations, test_status: testStatus, test_evidence: testEvidence,
    context_conflicts: conflicts, observed_at: new Date().toISOString(), fingerprint };
  check('Discovery', discovery); return immutable(discovery);
}
