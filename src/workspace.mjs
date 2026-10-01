import { lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';
import { SolFault } from './store.mjs';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const forbidden = ['.git', '.codex/sol'];
function fail(code, message) { throw new SolFault(code, message); }

export async function workspaceFile(root, path, { allowMissing = false } = {}) {
  const normalized = path.replaceAll('\\', '/');
  if (normalized !== path || !path || path.startsWith('/') || /^[A-Za-z]:/u.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) fail('PATH_ERROR', 'Path must be a workspace-relative file path.');
  const comparison = process.platform === 'win32' ? path.toLowerCase() : path;
  if (forbidden.some((item) => comparison === item || comparison.startsWith(`${item}/`))) fail('PATH_ERROR', 'Path is reserved for project metadata.');
  if (process.platform === 'win32' && path.split('/').some((part) => /[:<>"|?*]/u.test(part) || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) fail('PATH_ERROR', 'Path is not a regular Windows file path.');
  const full = resolve(root, path);
  if (!full.startsWith(`${root}${sep}`)) fail('PATH_ERROR', 'Path escapes workspace.');
  let parent = dirname(full);
  while (parent !== root) {
    try {
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink()) fail('PATH_ERROR', 'Parent path is not a regular directory.');
    } catch (error) {
      if (error.code !== 'ENOENT' || !allowMissing) throw error;
    }
    parent = dirname(parent);
  }
  try {
    const info = await lstat(full);
    if (!info.isFile() || info.isSymbolicLink()) fail('PATH_ERROR', 'Target is not a regular file.');
  } catch (error) {
    if (error.code !== 'ENOENT' || !allowMissing) throw error;
  }
  return full;
}

export async function fileState(root, paths) {
  const result = new Map();
  for (const path of paths) {
    const full = await workspaceFile(root, path, { allowMissing: true });
    try { result.set(path, sha(await readFile(full))); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      result.set(path, null);
    }
  }
  return result;
}
