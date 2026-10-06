import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { applyFileChanges, runManagedFileChanges } from '../src/managed-write.mjs';
import { fileFacts, fileFactFingerprint, fileState, writeAtomicJSON } from '../src/workspace.mjs';
import { createObservationStore } from '../src/store.mjs';
import { ValidationEngine } from '../src/validation.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sol-managed-write-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const posix = process.platform === 'win32' ? 'Ordinary POSIX permissions require a POSIX filesystem.' : false;

test('same bytes retain the file identity; content SHA and combined fingerprints remain distinct', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'same.txt'), 'same');
  const before = await lstat(join(root, 'same.txt'), { bigint: true });
  const result = await applyFileChanges(root, [{ path: 'same.txt', action: 'write', content: 'same' }]);
  assert.equal(result.error, null); assert.equal(result.changed_paths_known, true); assert.deepEqual(result.changed, []);
  const after = await lstat(join(root, 'same.txt'), { bigint: true });
  assert.equal(after.ino, before.ino); assert.equal(after.mtimeNs, before.mtimeNs); assert.equal(after.ctimeNs, before.ctimeNs);
  const fact = result.after.get('same.txt');
  const contentSha = createHash('sha256').update('same').digest('hex');
  assert.equal(fact.sha256, contentSha); assert.equal((await fileState(root, ['same.txt'])).get('same.txt'), contentSha);
  assert.notEqual(fileFactFingerprint(fact), contentSha);
  assert.equal(fact.mode === null, process.platform === 'win32');
});

test('formal overwrites preserve 755 and 644; new and private JSON files retain 600', { skip: posix }, async (t) => {
  const root = await fixture(t);
  for (const mode of [0o755, 0o644]) {
    const name = `file-${mode.toString(8)}`;
    await writeFile(join(root, name), 'before'); await chmod(join(root, name), mode);
    for (const content of ['before', 'after']) {
      const result = await applyFileChanges(root, [{ path: name, action: 'write', content }]);
      assert.equal(result.error, null); assert.equal((await lstat(join(root, name))).mode & 0o777, mode);
      assert.deepEqual(result.changed, content === 'before' ? [] : [name]);
    }
  }
  assert.equal((await applyFileChanges(root, [{ path: 'new.txt', action: 'write', content: 'new' }])).error, null);
  assert.equal((await lstat(join(root, 'new.txt'))).mode & 0o777, 0o600);
  await writeAtomicJSON(join(root, 'private.json'), { private: true });
  await chmod(join(root, 'private.json'), 0o755);
  await writeAtomicJSON(join(root, 'private.json'), { private: true });
  assert.equal((await lstat(join(root, 'private.json'))).mode & 0o777, 0o600);
});

test('special permissions refuse replacement while identical content remains untouched', { skip: posix }, async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'special'), 'same'); await chmod(join(root, 'special'), 0o4755);
  const identical = await applyFileChanges(root, [{ action: 'write', path: 'special', content: 'same' }]);
  assert.equal(identical.error, null);
  const result = await applyFileChanges(root, [{ action: 'write', path: 'special', content: 'changed' }]);
  assert.equal(result.error.code, 'METADATA_UNSUPPORTED'); assert.deepEqual(result.changed, []);
  assert.equal(await readFile(join(root, 'special'), 'utf8'), 'same');
  assert.equal((await lstat(join(root, 'special'))).mode & 0o7777, 0o4755);
});

test('partial failure reports published effects and missing facts without retry or temp leaks', async (t) => {
  const root = await fixture(t);
  const result = await applyFileChanges(root, [
    { action: 'write', path: 'nested/kept.txt', content: 'kept' }, { action: 'delete', path: 'absent.txt' },
    { action: 'write', path: 'never.txt', content: 'never' },
  ]);
  assert.equal(result.error.code, 'ENOENT'); assert.deepEqual(result.changed, ['nested/kept.txt']);
  assert.equal(result.changed_paths_known, true); assert.equal(await readFile(join(root, 'nested', 'kept.txt'), 'utf8'), 'kept');
  assert.deepEqual(result.after.get('absent.txt'), { path: 'absent.txt', type: 'missing' });
  assert.deepEqual(await readdir(join(root, 'nested')), ['kept.txt']);
  await assert.rejects(readFile(join(root, 'never.txt')), { code: 'ENOENT' });
});

test('all paths preflight before mutation; cancellation and linked parents cannot write', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, 'directory'));
  await symlink(join(root, 'directory'), join(root, 'linked'), 'junction');
  for (const path of ['../escape', '.git/config', 'linked/escape']) {
    await assert.rejects(applyFileChanges(root, [{ action: 'write', path: 'first', content: 'first' }, { action: 'write', path, content: 'bad' }]), { code: 'PATH_ERROR' });
    await assert.rejects(readFile(join(root, 'first')), { code: 'ENOENT' });
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(applyFileChanges(root, [{ action: 'write', path: 'first', content: 'first' }], { signal: controller.signal }), { code: 'INTERRUPTED' });
  assert.equal((await fileFacts(root, ['first'])).get('first').type, 'missing');
});

test('cancellation after opening a temporary file prevents publication and cleans the temporary', async (t) => {
  const root = await fixture(t);
  const controller = new AbortController();
  const watcher = watch(root, (_, name) => {
    if (String(name).startsWith('.codex-sol-')) controller.abort();
  });
  try {
    const result = await applyFileChanges(root, [{ action: 'write', path: 'cancelled.txt', content: 'x'.repeat(4 * 1024 * 1024) }], { signal: controller.signal });
    assert.equal(controller.signal.aborted, true);
    assert.equal(result.error.code, 'INTERRUPTED'); assert.deepEqual(result.changed, []);
    assert.equal(result.changed_paths_known, true);
    assert.deepEqual(await readdir(root), []);
  } finally { watcher.close(); }
});

test('post-publication observation failure preserves real effects as unknown without replay or fake validation', async (t) => {
  for (const managed of [false, true]) await t.test(managed ? 'managed entry' : 'direct effects', async (t) => {
    const root = await fixture(t);
    const target = join(root, 'published.txt');
    await writeFile(target, 'before');
    const before = (await fileFacts(root, ['published.txt'])).get('published.txt');
    const store = managed ? await createObservationStore(root) : null;
    const faultTarget = join(store?.workspaceRoot ?? root, 'published.txt');
    const validator = managed ? new ValidationEngine(store, { schema_version: 1, rules: [] }) : null;
    let captures = 0; let validations = 0;
    if (managed) {
      const beginCapture = store.beginCapture.bind(store);
      store.beginCapture = (...args) => { captures += 1; return beginCapture(...args); };
      const onChange = validator.onChange.bind(validator);
      validator.onChange = (...args) => { validations += 1; return onChange(...args); };
    }
    const realRename = filesystem.rename;
    const realLstat = filesystem.lstat;
    const failure = Object.assign(new Error('Injected post-publication lstat failure.'), { code: 'EIO' });
    let publications = 0; let failedObservations = 0;
    // Arm the fault only AFTER the real temporary file was renamed to the exact
    // target. Initial facts, writes, fsync, cleanup and unrelated I/O stay real.
    filesystem.rename = async (...args) => {
      const result = await realRename(...args);
      if (args[1] === faultTarget) {
        assert.equal(await readFile(target, 'utf8'), 'after');
        publications += 1;
      }
      return result;
    };
    filesystem.lstat = async (...args) => {
      if (args[0] === faultTarget && publications) { failedObservations += 1; throw failure; }
      return realLstat(...args);
    };
    syncBuiltinESMExports();
    let result;
    try {
      const changes = [{ action: 'write', path: 'published.txt', content: 'after' }];
      result = managed ? await runManagedFileChanges(store, validator, changes) : await applyFileChanges(root, changes);
    } finally {
      filesystem.rename = realRename; filesystem.lstat = realLstat;
      syncBuiltinESMExports();
    }
    assert.equal(publications, 1, 'A completed write must never be replayed after its observation fails.');
    assert.equal(failedObservations, 1);
    assert.equal(await readFile(target, 'utf8'), 'after');
    assert.equal(result.changed_paths_known, false);
    assert.deepEqual((await readdir(root)).filter((name) => name.startsWith('.codex-sol-')), []);
    if (managed) {
      assert.equal(result.tool_status, 'error'); assert.deepEqual(result.changed_paths, ['published.txt']);
      assert.equal(result.error.code, 'IO_ERROR'); assert.equal(result.upstream_error.code, 'IO_ERROR');
      assert.equal(result.error.message, failure.message); assert.equal(result.upstream_error.message, failure.message);
      assert.equal(result.validation, null); assert.equal(Object.hasOwn(result, 'change_event_raw'), false);
      assert.equal(captures, 0); assert.equal(validations, 0);
      assert.deepEqual(await readdir(store.observationsRoot), []);
    } else {
      assert.deepEqual(result.changed, ['published.txt']); assert.equal(result.error, failure);
      assert.deepEqual(result.before.get('published.txt'), before); assert.equal(result.after, null);
    }
    const subsequent = await applyFileChanges(root, [{ action: 'write', path: 'published.txt', content: 'after' }]);
    assert.equal(subsequent.error, null); assert.equal(subsequent.changed_paths_known, true);
    assert.deepEqual(subsequent.changed, []);
  });
});
