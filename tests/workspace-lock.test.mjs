import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createObservationStore } from '../src/store.mjs';
import { withWorkspaceLock } from '../src/workspace-lock.mjs';

const nativePlatform = ['win32', 'linux'].includes(process.platform);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'codex-sol-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await createObservationStore(root);
  return { store, owner: join(store.solRoot, 'managed-modification.owner.json') };
}
async function deadOwner() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  await once(child, 'close');
  return { schema_version: 1, token: randomUUID(), pid: child.pid, acquired_at: new Date().toISOString(), runner: { state: 'idle', pid: null } };
}

test('dead idle owner is replaced only under the native lock and then removed', { skip: !nativePlatform }, async (t) => {
  const { store, owner } = await fixture(t);
  await writeFile(owner, JSON.stringify(await deadOwner()));
  assert.equal(await withWorkspaceLock(store, async () => {
    assert.equal(JSON.parse(await readFile(owner)).pid, process.pid);
    return 'completed';
  }), 'completed');
  await assert.rejects(readFile(owner), { code: 'ENOENT' });
});

test('unknown validator startup remains evidence and is never automatically recovered', { skip: !nativePlatform }, async (t) => {
  const { store, owner } = await fixture(t);
  const record = { ...await deadOwner(), runner: { state: 'starting', pid: null } };
  const bytes = JSON.stringify(record);
  await writeFile(owner, bytes);
  let called = false;
  await assert.rejects(withWorkspaceLock(store, async () => { called = true; }), { code: 'RECOVERY_REQUIRED' });
  assert.equal(called, false);
  assert.equal(await readFile(owner, 'utf8'), bytes);
});

test('corrupt lock metadata refuses mutation and releases the native resource', { skip: !nativePlatform }, async (t) => {
  const { store, owner } = await fixture(t);
  await writeFile(owner, '{broken');
  let called = false;
  await assert.rejects(withWorkspaceLock(store, async () => { called = true; }), { code: 'RECOVERY_REQUIRED' });
  assert.equal(called, false);
  assert.equal(await readFile(owner, 'utf8'), '{broken');
  await rm(owner);
  assert.equal(await withWorkspaceLock(store, async () => 'next'), 'next');
});

test('legacy directory lock is never removed while migrating to native locking', { skip: !nativePlatform }, async (t) => {
  const { store } = await fixture(t);
  const legacy = join(store.solRoot, 'managed-modification.lock');
  await mkdir(legacy);
  await writeFile(join(legacy, 'owner.json'), 'legacy evidence');
  await assert.rejects(withWorkspaceLock(store, async () => assert.fail('must not modify')), { code: 'RECOVERY_REQUIRED' });
  assert.equal(await readFile(join(legacy, 'owner.json'), 'utf8'), 'legacy evidence');
});

test('operation failure releases the lock without removing observations or receipts', async (t) => {
  const { store } = await fixture(t);
  const evidence = join(store.solRoot, 'retained-evidence');
  await writeFile(evidence, 'retain');
  await assert.rejects(withWorkspaceLock(store, async () => { throw new Error('failed operation'); }), /failed operation/);
  assert.equal(await readFile(evidence, 'utf8'), 'retain');
  assert.equal(await withWorkspaceLock(store, async () => 'recovered'), 'recovered');
});
