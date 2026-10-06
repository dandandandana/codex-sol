import { lstat, open, rename, unlink, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';
import { SolFault } from './store.mjs';
import { constants } from 'node:fs';
import { interruptionFault } from './store.mjs';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const INPUT_FINGERPRINT_KIND = 'content_mode_v1';
const forbidden = ['.git', '.codex/sol'];
function fail(code, message) { throw new SolFault(code, message); }

/** Pure path validation shared by reads, writes and patch preflight. No I/O. */
export function validateWorkspacePath(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.includes('\0') || path.startsWith('/') || /^[A-Za-z]:/u.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) fail('PATH_ERROR', 'Path must be a workspace-relative file path.');
  const comparison = process.platform === 'win32' ? path.toLowerCase() : path;
  if (forbidden.some((item) => comparison === item || comparison.startsWith(`${item}/`))) fail('PATH_ERROR', 'Path is reserved for project metadata.');
  if (process.platform === 'win32' && path.split('/').some((part) => /[:<>"|?*]/u.test(part) || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) fail('PATH_ERROR', 'Path is not a regular Windows file path.');
  return path;
}

export async function workspaceFile(root, path, { allowMissing = false } = {}) {
  validateWorkspacePath(path);
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

function check(signal) { if (signal?.aborted) throw interruptionFault(signal, 'Workspace operation was interrupted.'); }
const sameStat = (a, b) => ['dev', 'ino', 'size', 'mode', 'uid', 'gid', 'nlink', 'mtimeNs', 'ctimeNs'].every((key) => a[key] === b[key]);
function drift() { fail('WORKSPACE_CHANGED', 'Workspace file changed during observation; inspect current inputs again.'); }

/** Content SHA stays separate from ordinary POSIX mode. Windows mode is unknown.
 * One fd supplies the hash; before/after metadata and the path detect observed
 * drift. This is not an atomic snapshot across files or an ownership/ACL promise.
 */
async function inspectFile(root, path, { signal } = {}) {
  check(signal);
  const full = await workspaceFile(root, path, { allowMissing: true });
  let file;
  try { file = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Recheck ancestors: an absent child of a substituted link is not missing.
    await workspaceFile(root, path, { allowMissing: true });
    try { await lstat(full); }
    catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
      return { fact: { path, type: 'missing' }, stats: null };
    }
    drift();
  }
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) fail('PATH_ERROR', 'Target is not a regular file.');
    const digest = createHash('sha256');
    const chunk = Buffer.alloc(64 * 1024);
    for (;;) {
      check(signal);
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      digest.update(chunk.subarray(0, bytesRead));
    }
    check(signal);
    const after = await file.stat({ bigint: true });
    await workspaceFile(root, path);
    const current = await lstat(full, { bigint: true });
    if (!sameStat(before, after) || !sameStat(after, current)) drift();
    return { fact: { path, type: 'file', sha256: digest.digest('hex'),
      mode: process.platform === 'win32' ? null : Number(after.mode & 0o777n) }, stats: after };
  } finally { await file.close(); }
}

export async function fileFacts(root, paths, { signal } = {}) {
  const facts = new Map();
  for (const path of paths) facts.set(path, (await inspectFile(root, path, { signal })).fact);
  check(signal);
  return facts;
}

export function fingerprintFileFacts(items) {
  return sha(JSON.stringify({ fingerprint_kind: INPUT_FINGERPRINT_KIND, items }));
}
export function fileFactFingerprint(fact) { return fingerprintFileFacts([fact]); }

/** Compatibility export: values are content hashes, never combined fingerprints. */
export async function fileState(root, paths, options = {}) {
  return new Map([...await fileFacts(root, paths, options)].map(([path, fact]) => [path, fact.type === 'file' ? fact.sha256 : null]));
}

async function assertUnchanged(root, path, observed, signal) {
  const current = await inspectFile(root, path, { signal });
  if (fileFactFingerprint(current.fact) !== fileFactFingerprint(observed.fact)
    || (observed.stats && (!current.stats || !sameStat(observed.stats, current.stats)))) drift();
  return await workspaceFile(root, path, { allowMissing: true });
}

/** Atomic formal-file replacement preserving ordinary POSIX permissions only.
 * Same bytes never replace the inode. Special POSIX bits cannot be preserved by
 * this policy and fail before publication. New files explicitly use 0600.
 * Caller owns the workspace lease and the effects of a multi-file operation.
 */
export async function writeWorkspaceFile(root, path, content, { signal, expected } = {}) {
  check(signal);
  const observed = await inspectFile(root, path, { signal });
  if (expected && fileFactFingerprint(expected) !== fileFactFingerprint(observed.fact)) drift();
  const bytes = Buffer.from(content, 'utf8');
  if (observed.fact.type === 'file' && observed.fact.sha256 === sha(bytes)) return false;
  if (observed.stats && process.platform !== 'win32' && (observed.stats.mode & 0o7000n))
    fail('METADATA_UNSUPPORTED', 'Special POSIX file permissions require an explicit preservation policy.');
  const full = await workspaceFile(root, path, { allowMissing: true });
  await mkdir(dirname(full), { recursive: true });
  await workspaceFile(root, path, { allowMissing: true });
  const temporary = `${dirname(full)}${sep}.codex-sol-${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(bytes);
    if (process.platform !== 'win32') await file.chmod(observed.fact.mode ?? 0o600);
    await file.sync();
    await file.close(); file = undefined;
    check(signal);
    await assertUnchanged(root, path, observed, signal);
    check(signal);
    await rename(temporary, full);
    return true;
  } finally {
    await file?.close();
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function deleteWorkspaceFile(root, path, { signal, expected } = {}) {
  check(signal);
  const observed = await inspectFile(root, path, { signal });
  if (expected && fileFactFingerprint(expected) !== fileFactFingerprint(observed.fact)) drift();
  const full = await assertUnchanged(root, path, observed, signal);
  check(signal);
  await unlink(full);
}

/** Bounded regular-file read at the workspace boundary. Caller owns cancellation. */
export async function readWorkspaceBytes(root, path, maxBytes, { signal } = {}) {
  const check = () => { if (signal?.aborted) throw interruptionFault(signal, 'Workspace read was interrupted.'); };
  check();
  const full = await workspaceFile(root, path);
  const file = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat({ bigint: true });
    if (!info.isFile() || info.size > BigInt(maxBytes)) fail('SOURCE_LIMIT', 'Source must be a regular file within the size limit.');
    const bytes = Buffer.alloc(maxBytes + 1); let length = 0;
    while (length < bytes.length) {
      check(); const read = await file.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > maxBytes) fail('SOURCE_LIMIT', 'Source exceeds the size limit.');
    check();
    const after = await file.stat({ bigint: true });
    await workspaceFile(root, path);
    if (!sameStat(info, after) || !sameStat(after, await lstat(full, { bigint: true }))) drift();
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
