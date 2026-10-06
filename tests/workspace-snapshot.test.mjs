import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestChangedPaths, snapshotInputs } from '../src/validation.mjs';
import { parseWorkspaceSnapshot } from '../src/workspace-snapshot.mjs';
import { fileFacts, fileFactFingerprint, fileState, INPUT_FINGERPRINT_KIND } from '../src/workspace.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sol-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'main.mjs'), 'export const value = 1;');
  return root;
}

test('narrow watch avoids unrelated linked trees but full workspace still rejects them', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
  await symlink(join(root, 'src'), join(root, 'node_modules', '.bin', 'linked'), 'junction');
  const snapshot = await snapshotInputs(root, ['src/**/*.mjs']);
  assert.deepEqual(snapshot.items.map((item) => item.path), ['src/main.mjs']);
  await assert.rejects(snapshotInputs(root, ['**/*']), { code: 'SNAPSHOT_ERROR' });
});

test('globstar searches nested config and relevant linked ancestors remain rejected', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, 'nested', 'deep'), { recursive: true });
  await writeFile(join(root, 'nested', 'deep', 'config.json'), '{}');
  assert.deepEqual((await snapshotInputs(root, ['**/config.json'])).items.map((item) => item.path), ['nested/deep/config.json']);
  await symlink(join(root, 'nested'), join(root, 'linked'), 'junction');
  await assert.rejects(snapshotInputs(root, ['linked/**/*.json']), { code: 'SNAPSHOT_ERROR' });
});

test('generated exclusions, hidden files and deleted seeds use the same matching rules', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'src', '.hidden.mjs'), 'hidden');
  await writeFile(join(root, 'src', 'removed.mjs'), 'deleted');
  await unlink(join(root, 'src', 'removed.mjs'));
  await mkdir(join(root, 'src', 'generated'));
  await symlink(join(root, 'src'), join(root, 'src', 'generated', 'linked'), 'junction');
  const result = await snapshotInputs(root, ['src/**'], ['src/generated'], ['src/removed.mjs', 'src/generated/missing.mjs']);
  assert.deepEqual(result.items.map((item) => [item.path, item.type]), [
    ['src/.hidden.mjs', 'file'], ['src/main.mjs', 'file'], ['src/removed.mjs', 'missing'],
  ]);
});

test('marked snapshots verify strictly; legacy content hashes retain their original bytes and unknown mode', async (t) => {
  const root = await fixture(t);
  const modern = await snapshotInputs(root, ['src/**']);
  assert.equal(modern.fingerprint_kind, INPUT_FINGERPRINT_KIND);
  assert.equal(parseWorkspaceSnapshot(modern), modern);
  const items = modern.items.map(({ mode, ...fact }) => fact);
  const legacy = { items, sha256: createHash('sha256').update(JSON.stringify(items)).digest('hex') };
  const original = JSON.stringify(legacy);
  assert.equal(parseWorkspaceSnapshot(legacy), legacy);
  assert.equal(JSON.stringify(legacy), original); assert.equal(Object.hasOwn(legacy.items[0], 'mode'), false);
  for (const value of [
    { ...modern, fingerprint_kind: 'future_unknown' },
    { ...modern, unexpected: true },
    { ...modern, items: [{ ...modern.items[0], mode: 0o777 }] },
    { ...legacy, fingerprint_kind: INPUT_FINGERPRINT_KIND },
    { ...modern, items: [{ ...modern.items[0], mode: undefined }] },
  ]) assert.throws(() => parseWorkspaceSnapshot(value), { code: 'CORRUPT' });
});

test('permission-only changes affect facts, snapshot and change digest without redefining content SHA', {
  skip: process.platform === 'win32' && 'Ordinary POSIX permissions require a POSIX filesystem.',
}, async (t) => {
  const root = await fixture(t);
  const path = 'src/main.mjs';
  await chmod(join(root, path), 0o755);
  const before = await snapshotInputs(root, ['src/**']);
  const digest = await digestChangedPaths(root, [path]);
  const fact = (await fileFacts(root, [path])).get(path);
  const content = (await fileState(root, [path])).get(path);
  await chmod(join(root, path), 0o644);
  const after = await snapshotInputs(root, ['src/**']);
  assert.equal(after.items[0].sha256, before.items[0].sha256);
  assert.notEqual(after.sha256, before.sha256);
  assert.notEqual(await digestChangedPaths(root, [path]), digest);
  assert.notEqual(fileFactFingerprint((await fileFacts(root, [path])).get(path)), fileFactFingerprint(fact));
  assert.equal((await fileState(root, [path])).get(path), content);
});
