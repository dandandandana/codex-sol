import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
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
  if (process.platform === 'linux') return `\0codex-sol-${workspaceId}`;
  return null;
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
  const legacy = join(store.solRoot, 'managed-modification.lock');
  const ownerPath = native ? join(store.solRoot, 'managed-modification.owner.json') : join(legacy, 'owner.json');
  const deadline = Date.now() + timeoutMs;
  while (true) {
    interrupted(signal);
    if (native) {
      try {
        await lstat(legacy);
        throw new SolFault('RECOVERY_REQUIRED', 'A lock from the previous implementation remains. Stop its processes and inspect it before removing that legacy lock directory.');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const release = native ? await tryNativeLock(native) : await tryDirectoryLock(legacy);
    if (release) {
      let owned = false;
      let record;
      let runnerIdleConfirmed = false;
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
          runnerIdleConfirmed = true;
          interrupted(signal);
          return await operation({ setRunner: async (runner) => {
            const next = { ...record, runner };
            assertContract('LockOwner', next);
            // idle is only reported after the child closes. Keep that fact even
            // if persisting the metadata fails, while retaining the native lease.
            if (runner.state === 'idle') runnerIdleConfirmed = true;
            await writeOwner(ownerPath, next);
            record = next;
            if (runner.state !== 'idle') runnerIdleConfirmed = false;
          } });
        }
      } finally {
        try {
          if (owned && runnerIdleConfirmed) await unlink(ownerPath);
        } finally { await release(); }
      }
    }
    if (Date.now() >= deadline) throw new SolFault('WORKSPACE_BUSY', 'Another managed modification or validation process is still active.', true);
    try { await delay(Math.min(100, Math.max(1, deadline - Date.now())), undefined, { signal }); }
    catch (error) { interrupted(signal); throw error; }
  }
}
