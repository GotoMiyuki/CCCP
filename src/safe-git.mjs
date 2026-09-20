import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { devNull } from 'node:os';

const exec = promisify(execFile);
// Host Git operations must not execute commands supplied by repository config.
// Core Discovery and worktree management share this infrastructure helper.
export async function safeGit(cwd, args) {
  const options = { cwd, windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 };
  const prefix = ['-c', `safe.directory=${cwd}`, '-c', `core.hooksPath=${devNull}`, '-c', 'core.fsmonitor=false'];
  let keys = '';
  try { keys = (await exec('git', [...prefix, 'config', '--null', '--name-only', '--get-regexp', '^filter\.'], options)).stdout; }
  catch (error) { if (error.code !== 1) throw error; }
  const names = new Set(keys.split('\0').map(key => /^filter\.(.+)\.(clean|smudge|process|required)$/i.exec(key)?.[1]).filter(Boolean));
  for (const name of names) for (const [property, value] of [['clean', ''], ['smudge', ''], ['process', ''], ['required', 'false']]) prefix.push('-c', `filter.${name}.${property}=${value}`);
  return exec('git', [...prefix, ...args], options);
}
