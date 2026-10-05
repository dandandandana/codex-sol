import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import net from 'node:net';
import { EventEmitter, once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { renameSync, writeFileSync } from 'node:fs';
import fsPromises, { link, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createObservationStore } from '../src/store.mjs';
import { withWorkspaceLock } from '../src/workspace-lock.mjs';

const linux = { skip: process.platform !== 'linux', timeout: 20000 };
const worker = fileURLToPath(new URL('./helpers/workspace-lock-worker.mjs', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sol-linux-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await createObservationStore(root);
  return { root, store, lock: join(store.solRoot, 'managed-modification.flock'), owner: join(store.solRoot, 'managed-modification.owner.json') };
}
function start(t, root, mode, argument = '') {
  const child = childProcess.spawn(process.execPath, [worker, root, mode, String(argument)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  const lines = new EventEmitter();
  child.stdout.on('data', (bytes) => { stdout += bytes; lines.emit('output'); });
  child.stderr.on('data', (bytes) => { stderr += bytes; });
  const closed = new Promise((resolve) => child.once('close', (code, signal) => { resolve({ code, signal }); lines.emit('output'); }));
  t.after(async () => { child.kill('SIGKILL'); await closed; });
  return { child, closed, get stderr() { return stderr; }, async wait(text) {
    while (!stdout.includes(text)) {
      if (child.exitCode !== null || child.signalCode !== null) assert.fail(`worker exited before ${text}: ${stderr}`);
      await once(lines, 'output');
    }
  } };
}
function replaceBuiltin(t, object, name, replacement) {
  const mocked = t.mock.method(object, name, replacement);
  syncBuiltinESMExports();
  const restore = () => { mocked.mock.restore(); syncBuiltinESMExports(); };
  t.after(restore);
  return restore;
}

test('Linux lock does not open a socket and retains one regular lock inode across releases', linux, async (t) => {
  const { store, lock } = await fixture(t);
  replaceBuiltin(t, net, 'createServer', () => { throw new Error('sockets forbidden'); });
  assert.equal(await withWorkspaceLock(store, async () => 'first'), 'first');
  const first = await lstat(lock);
  assert.equal(first.isFile(), true);
  assert.equal(first.mode & 0o777, 0o600);
  assert.equal(await withWorkspaceLock(store, async () => 'second'), 'second');
  const second = await lstat(lock);
  assert.equal(second.dev, first.dev);
  assert.equal(second.ino, first.ino);
});

test('independent Linux processes never overlap read-modify-write critical sections', linux, async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'counter'), '0');
  const workers = Array.from({ length: 8 }, () => start(t, root, 'counter', 8));
  await Promise.all(workers.map((entry) => entry.wait('ready')));
  await writeFile(join(root, 'go'), 'go');
  const results = await Promise.all(workers.map((entry) => entry.closed));
  results.forEach((result, index) => assert.deepEqual(result, { code: 0, signal: null }, workers[index].stderr));
  assert.equal(await readFile(join(root, 'counter'), 'utf8'), '64');
});

test('SIGKILL releases the Linux kernel lock without deleting its file or stale owner evidence first', linux, async (t) => {
  const { root, store, lock, owner } = await fixture(t);
  const holder = start(t, root, 'hold');
  await holder.wait('locked');
  const before = await lstat(lock);
  await assert.rejects(withWorkspaceLock(store, async () => assert.fail('overlap'), { timeoutMs: 20 }), { code: 'WORKSPACE_BUSY' });
  holder.child.kill('SIGKILL');
  await holder.closed;
  assert.equal(JSON.parse(await readFile(owner, 'utf8')).pid, holder.child.pid);
  assert.equal(await withWorkspaceLock(store, async () => 'recovered'), 'recovered');
  assert.equal((await lstat(lock)).ino, before.ino);
});

test('a killed Linux owner never permits overlap with its recorded live validator', linux, async (t) => {
  const { root, store, owner } = await fixture(t);
  const runner = childProcess.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const runnerClosed = once(runner, 'close');
  t.after(async () => { runner.kill('SIGKILL'); await runnerClosed; });
  const holder = start(t, root, 'running', runner.pid);
  await holder.wait('locked');
  const evidence = await readFile(owner, 'utf8');
  holder.child.kill('SIGKILL');
  await holder.closed;
  await assert.rejects(withWorkspaceLock(store, async () => assert.fail('live validator'), { timeoutMs: 30 }), { code: 'WORKSPACE_BUSY' });
  assert.equal(await readFile(owner, 'utf8'), evidence);
  runner.kill('SIGKILL');
  await runnerClosed;
  assert.equal(await withWorkspaceLock(store, async () => 'recovered'), 'recovered');
});

test('a Linux crash during unknown validator startup remains manual recovery evidence', linux, async (t) => {
  const { root, store, owner } = await fixture(t);
  const holder = start(t, root, 'starting');
  await holder.wait('locked');
  const evidence = await readFile(owner, 'utf8');
  holder.child.kill('SIGKILL');
  await holder.closed;
  await assert.rejects(withWorkspaceLock(store, async () => assert.fail('unknown validator')), { code: 'RECOVERY_REQUIRED' });
  assert.equal(await readFile(owner, 'utf8'), evidence);
});

test('Linux lock rejects symlinks and directories without touching their targets', linux, async (t) => {
  const { root, store, lock } = await fixture(t);
  const target = join(root, 'evidence');
  await writeFile(target, 'retain');
  await symlink(target, lock);
  await assert.rejects(withWorkspaceLock(store, async () => assert.fail('symlink accepted')), { code: 'LOCK_ERROR' });
  assert.equal(await readFile(target, 'utf8'), 'retain');
  await rm(lock);
  await mkdir(lock);
  await assert.rejects(withWorkspaceLock(store, async () => assert.fail('directory accepted')), { code: 'LOCK_ERROR' });
  assert.equal((await lstat(lock)).isDirectory(), true);
});

test('missing Linux flock fails closed and later acquisition remains possible', linux, async (t) => {
  const { store, owner } = await fixture(t);
  const restore = replaceBuiltin(t, childProcess, 'spawn', () => {
    const child = new EventEmitter();
    queueMicrotask(() => { child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })); child.emit('close', -2, null); });
    return child;
  });
  await assert.rejects(withWorkspaceLock(store, async () => assert.fail('missing flock accepted')), (error) => error.code === 'LOCK_ERROR' && /flock/u.test(error.message));
  await assert.rejects(readFile(owner), { code: 'ENOENT' });
  restore();
  assert.equal(await withWorkspaceLock(store, async () => 'next'), 'next');
});

test('cancellation while launching flock waits for the helper to close and releases the fd', linux, async (t) => {
  const { store } = await fixture(t);
  const spawn = childProcess.spawn;
  let helper, closed;
  const controller = new AbortController();
  const restore = replaceBuiltin(t, childProcess, 'spawn', (executable, args, options) => {
    helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
    closed = once(helper, 'close');
    helper.once('spawn', () => controller.abort('cancel helper'));
    return helper;
  });
  await assert.rejects(withWorkspaceLock(store, async () => assert.fail('cancelled acquisition'), { signal: controller.signal }), { code: 'INTERRUPTED' });
  await closed;
  assert.equal(helper.signalCode, 'SIGKILL');
  restore();
  assert.equal(await withWorkspaceLock(store, async () => 'next'), 'next');
});

test('Linux lock refuses a FIFO promptly and preserves hard-linked files', linux, async (t) => {
  const { root, store, lock } = await fixture(t);
  const fifo = childProcess.spawnSync('mkfifo', [lock]);
  assert.equal(fifo.status, 0);
  await assert.rejects(withWorkspaceLock(store, async () => assert.fail('FIFO accepted')), { code: 'LOCK_ERROR' });
  assert.equal((await lstat(lock)).isFIFO(), true);
  await rm(lock);
  const target = join(root, 'evidence');
  await writeFile(target, 'retain');
  await link(target, lock);
  await assert.rejects(withWorkspaceLock(store, async () => assert.fail('hard link accepted')), { code: 'LOCK_ERROR' });
  assert.equal(await readFile(target, 'utf8'), 'retain');
});

test('Linux inode replacement during acquisition fails closed instead of locking the detached inode', linux, async (t) => {
  const { store, lock } = await fixture(t);
  const spawn = childProcess.spawn;
  const restore = replaceBuiltin(t, childProcess, 'spawn', (...args) => {
    const child = spawn(...args);
    child.once('spawn', () => {
      renameSync(lock, `${lock}.moved`);
      writeFileSync(lock, 'replacement');
    });
    return child;
  });
  await assert.rejects(withWorkspaceLock(store, async () => assert.fail('detached inode accepted')), { code: 'LOCK_ERROR' });
  assert.equal(await readFile(lock, 'utf8'), 'replacement');
  restore();
  assert.equal(await withWorkspaceLock(store, async () => 'next'), 'next');
});

test('Linux helper errors are not treated as lock contention or permission to mutate', linux, async (t) => {
  const { store, owner } = await fixture(t);
  await writeFile(owner, 'retain prior evidence');
  const restore = replaceBuiltin(t, childProcess, 'spawn', () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', 71, null));
    return child;
  });
  await assert.rejects(withWorkspaceLock(store, async () => assert.fail('helper error accepted')), { code: 'LOCK_ERROR' });
  assert.equal(await readFile(owner, 'utf8'), 'retain prior evidence');
  restore();
});

test('Linux owner publication failure closes the kernel lock before a later attempt', linux, async (t) => {
  const { store, owner } = await fixture(t);
  const restore = replaceBuiltin(t, fsPromises, 'rename', async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); });
  await assert.rejects(withWorkspaceLock(store, async () => assert.fail('unpersisted ownership')), { code: 'STORAGE_ERROR' });
  await assert.rejects(readFile(owner), { code: 'ENOENT' });
  restore();
  assert.equal(await withWorkspaceLock(store, async () => 'next'), 'next');
});

test('ordinary spawned children do not retain the Linux workspace descriptor after release', linux, async (t) => {
  const { store } = await fixture(t);
  let child, closed;
  t.after(async () => { child?.kill('SIGKILL'); await closed; });
  await withWorkspaceLock(store, async () => {
    child = childProcess.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    closed = once(child, 'close');
    await once(child, 'spawn');
  });
  assert.equal(child.exitCode, null);
  assert.equal(await withWorkspaceLock(store, async () => 'next', { timeoutMs: 100 }), 'next');
});

test('Linux lock acquisition bounds a stalled helper by the caller timeout', linux, async (t) => {
  const { store } = await fixture(t);
  const spawn = childProcess.spawn;
  let helper, closed;
  const restore = replaceBuiltin(t, childProcess, 'spawn', (executable, args, options) => {
    helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
    closed = once(helper, 'close');
    return helper;
  });
  const started = Date.now();
  await assert.rejects(withWorkspaceLock(store, async () => assert.fail('stalled helper accepted'), { timeoutMs: 30 }), { code: 'WORKSPACE_BUSY' });
  assert.ok(Date.now() - started < 1000, 'acquisition exceeded its short deadline');
  await closed;
  assert.equal(helper.signalCode, 'SIGKILL');
  restore();
  assert.equal(await withWorkspaceLock(store, async () => 'next'), 'next');
});

test('Linux flock checks the second trusted system location only when the first is absent', linux, async (t) => {
  const { store } = await fixture(t);
  const spawn = childProcess.spawn;
  const paths = [];
  replaceBuiltin(t, childProcess, 'spawn', (executable, args, options) => {
    paths.push(executable);
    if (executable === '/bin/flock') return spawn(executable, args, options);
    const child = new EventEmitter();
    queueMicrotask(() => { child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })); child.emit('close', -2, null); });
    return child;
  });
  assert.equal(await withWorkspaceLock(store, async () => 'fallback'), 'fallback');
  assert.deepEqual(paths, ['/usr/bin/flock', '/bin/flock']);
});

test('cancellation after real Linux flock success still prevents the operation and releases ownership', linux, async (t) => {
  const { store, owner } = await fixture(t);
  const spawn = childProcess.spawn;
  const controller = new AbortController();
  const restore = replaceBuiltin(t, childProcess, 'spawn', (...args) => {
    const child = spawn(...args);
    child.once('close', (code) => { assert.equal(code, 0); controller.abort('acquired then cancelled'); });
    return child;
  });
  await assert.rejects(withWorkspaceLock(store, async () => assert.fail('cancelled operation'), { signal: controller.signal }), { code: 'INTERRUPTED' });
  await assert.rejects(readFile(owner), { code: 'ENOENT' });
  restore();
  assert.equal(await withWorkspaceLock(store, async () => 'next'), 'next');
});
