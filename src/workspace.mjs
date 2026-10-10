import { lstat, open, rename, unlink, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, sep } from 'node:path';
import { constants } from 'node:fs';
import { interruptionFault, SolFault } from './store.mjs';
import { fileFactFingerprint, inspectWorkspaceFile, sameWorkspaceFileStat, workspaceFile } from './workspace-read.mjs';

export {
  INPUT_FINGERPRINT_KIND,
  fileFacts,
  fileFactFingerprint,
  fileState,
  fingerprintFileFacts,
  readWorkspaceBytes,
  validateWorkspacePath,
  workspaceFile,
} from './workspace-read.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function fail(code, message) { throw new SolFault(code, message); }
function check(signal) { if (signal?.aborted) throw interruptionFault(signal, 'Workspace operation was interrupted.'); }
function drift() { fail('WORKSPACE_CHANGED', 'Workspace file changed during observation; inspect current inputs again.'); }

async function assertUnchanged(root, path, observed, signal) {
  const current = await inspectWorkspaceFile(root, path, { signal });
  if (fileFactFingerprint(current.fact) !== fileFactFingerprint(observed.fact)
    || (observed.stats && (!current.stats || !sameWorkspaceFileStat(observed.stats, current.stats)))) drift();
  return await workspaceFile(root, path, { allowMissing: true });
}

/** Atomic formal-file replacement preserving ordinary POSIX permissions only.
 * Same bytes never replace the inode. Special POSIX bits cannot be preserved by
 * this policy and fail before publication. New files explicitly use 0600.
 * Caller owns the workspace lease and the effects of a multi-file operation.
 */
export async function writeWorkspaceFile(root, path, content, { signal, expected } = {}) {
  check(signal);
  const observed = await inspectWorkspaceFile(root, path, { signal });
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
  const observed = await inspectWorkspaceFile(root, path, { signal });
  if (expected && fileFactFingerprint(expected) !== fileFactFingerprint(observed.fact)) drift();
  const full = await assertUnchanged(root, path, observed, signal);
  check(signal);
  await unlink(full);
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
