import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertContract } from './schema.mjs';
import { interruptionFault, SolFault } from './store.mjs';

function interrupted(signal) {
  if (signal?.aborted) throw interruptionFault(signal, 'Managed modification was interrupted before acquiring the workspace lock.');
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw new SolFault('RECOVERY_REQUIRED', 'Could not establish whether the previous lock owner is still running.');
  }
}

async function readOwner(path) {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('invalid owner file');
    return assertContract('LockOwner', JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new SolFault('RECOVERY_REQUIRED', 'Workspace lock metadata is invalid; inspect it before recovering the workspace.');
  }
}

async function writeOwner(path, value) {
  assertContract('LockOwner', value);
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(JSON.stringify(value));
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, path);
  } catch (error) {
    await file?.close();
    await unlink(temporary).catch(() => {});
    throw new SolFault('STORAGE_ERROR', `Could not persist workspace lock state (${error.code ?? 'IO_ERROR'}).`);
  }
}

function endpoint(workspaceId) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\codex-sol-${workspaceId}`;
  return null;
}

// util-linux's descriptor form locks the open file description shared with
// this process, so its exit does not release our fd's lock. Do not use a shell,
// a command wrapper, or PATH (project execution_path may intentionally differ).
// 200 is distinct from flock's sysexits error codes.
async function flockDescriptor(file, signal, deadline) {
  for (const executable of ['/usr/bin/flock', '/bin/flock']) {
    interrupted(signal);
    const result = await new Promise((resolve) => {
      let error, timedOut = false;
      const child = spawn(executable, ['--exclusive', '--nonblock', '--conflict-exit-code', '200', '3'], {
        shell: false, stdio: ['ignore', 'ignore', 'ignore', file.fd], windowsHide: true,
      });
      const stop = () => child.kill('SIGKILL');
      const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, Math.min(5000, deadline - Date.now())));
      child.once('error', (cause) => { error = cause; });
      child.once('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        resolve({ code, error, timedOut });
      });
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
    });
    // Wait for close, even after cancellation, before closing the shared fd.
    interrupted(signal);
    if (result.timedOut && Date.now() >= deadline)
      throw new SolFault('WORKSPACE_BUSY', 'Workspace lock acquisition exceeded its deadline.', true);
    if (result.error?.code === 'ENOENT') continue;
    if (result.timedOut || result.error || ![0, 200].includes(result.code))
      throw new SolFault('LOCK_ERROR', `Linux flock failed (${result.timedOut ? 'TIMEOUT' : result.error?.code ?? result.code ?? 'SIGNAL'}); no workspace mutation was started.`);
    return result.code === 0;
  }
  throw new SolFault('LOCK_ERROR', 'Linux locking requires util-linux flock at /usr/bin/flock or /bin/flock; no workspace mutation was started.');
}

async function tryLinuxLock(path, signal, deadline) {
  let file, held = false;
  try {
    // O_NONBLOCK avoids hanging on an unexpected FIFO. O_NOFOLLOW prevents
    // opening another file through a symlink; fstat also rejects special files.
    file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    const opened = await file.stat();
    if (!opened.isFile() || opened.nlink !== 1) throw new SolFault('LOCK_ERROR', 'The Linux workspace lock must be a regular file without hard links.');
    if (!await flockDescriptor(file, signal, deadline)) return null;
    const current = await lstat(path);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino)
      throw new SolFault('LOCK_ERROR', 'The Linux workspace lock changed during acquisition; inspect the workspace before retrying.');
    held = true;
    // Never unlink this file, including after crashes. Waiters may have opened
    // the same inode already; unlink/recreate would create two independent locks.
    return () => file.close();
  } catch (error) {
    if (error instanceof SolFault) throw error;
    throw new SolFault('LOCK_ERROR', `Could not acquire the Linux workspace file lock (${error.code ?? 'IO_ERROR'}).`);
  } finally {
    if (file && !held) await file.close();
  }
}

async function tryNativeLock(path) {
  const server = createServer((socket) => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ path, exclusive: true });
    });
    return () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } catch (error) {
    if (error.code === 'EADDRINUSE') return null;
    throw new SolFault('LOCK_ERROR', `Could not acquire the native workspace lock (${error.code ?? 'IO_ERROR'}).`);
  }
}

// Other Unix platforms retain the conservative directory lock. They must be
// recovered manually after a crash; never delete a possibly live owner's lock.
async function tryDirectoryLock(path) {
  try { await mkdir(path, { mode: 0o700 }); return () => rmdir(path); }
  catch (error) { if (error.code === 'EEXIST') return null; throw error; }
}

/**
 * Holds one workspace across mutation and synchronous validation. The lease's
 * setRunner() must persist 'starting' before spawn, then the child PID, and only
 * return to 'idle' once that child has closed. Cancellation never steals a lock.
 */
export async function withWorkspaceLock(store, operation, { signal, timeoutMs = 30000 } = {}) {
  const native = endpoint(store.workspaceId);
  const linux = process.platform === 'linux';
  const recoverable = native || linux;
  const legacy = join(store.solRoot, 'managed-modification.lock');
  const ownerPath = recoverable ? join(store.solRoot, 'managed-modification.owner.json') : join(legacy, 'owner.json');
  const deadline = Date.now() + timeoutMs;
  while (true) {
    interrupted(signal);
    if (recoverable) {
      try {
        await lstat(legacy);
        throw new SolFault('RECOVERY_REQUIRED', 'A lock from the previous implementation remains. Stop its processes and inspect it before removing that legacy lock directory.');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const release = linux ? await tryLinuxLock(join(store.solRoot, 'managed-modification.flock'), signal, deadline)
      : native ? await tryNativeLock(native) : await tryDirectoryLock(legacy);
    if (release) {
      let owned = false;
      let record;
      try {
        interrupted(signal);
        const previous = await readOwner(ownerPath);
        if (previous && (alive(previous.pid) || (previous.runner.state === 'running' && alive(previous.runner.pid)))) {
          // A crashed server may have left its validation child alive. Keep
          // waiting without terminating, replaying, or overwriting that child.
        } else {
          if (previous?.runner.state === 'starting') throw new SolFault('RECOVERY_REQUIRED', 'The previous process exited during validator startup; stop any remaining validator before recovering the lock metadata.');
          record = { schema_version: 1, token: randomUUID(), pid: process.pid, acquired_at: new Date().toISOString(), runner: { state: 'idle', pid: null } };
          await writeOwner(ownerPath, record);
          owned = true;
          interrupted(signal);
          return await operation({ setRunner: async (runner) => {
            const next = { ...record, runner };
            await writeOwner(ownerPath, next);
            record = next;
          } });
        }
      } finally {
        try {
          if (owned && record.runner.state === 'idle') await unlink(ownerPath);
        } finally { await release(); }
      }
    }
    if (Date.now() >= deadline) throw new SolFault('WORKSPACE_BUSY', 'Another managed modification or validation process is still active.', true);
    try { await delay(Math.min(100, Math.max(1, deadline - Date.now())), undefined, { signal }); }
    catch (error) { interrupted(signal); throw error; }
  }
}
