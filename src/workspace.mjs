import { lstat, readFile, open, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';
import { SolFault } from './store.mjs';
import { constants } from 'node:fs';
import { interruptionFault } from './store.mjs';
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

/** Bounded regular-file read at the workspace boundary. Caller owns cancellation. */
export async function readWorkspaceBytes(root, path, maxBytes, { signal } = {}) {
  const check = () => { if (signal?.aborted) throw interruptionFault(signal, 'Workspace read was interrupted.'); };
  check();
  const full = await workspaceFile(root, path);
  const file = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) fail('SOURCE_LIMIT', 'Source must be a regular file within the size limit.');
    const bytes = Buffer.alloc(maxBytes + 1); let length = 0;
    while (length < bytes.length) {
      check(); const read = await file.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > maxBytes) fail('SOURCE_LIMIT', 'Source exceeds the size limit.');
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

/** Publish JSON at an already validated private workspace path. Caller owns
 * directory validation and locking. An optional guard runs after the temporary
 * file is synced, immediately before rename. Failure removes only this temp file.
 */
export async function writeAtomicJSON(path, value, { beforePublish } = {}) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(JSON.stringify(value));
    await file.sync();
    await file.close();
    file = undefined;
    await beforePublish?.();
    await rename(temporary, path);
  } finally {
    await file?.close();
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}
