import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createObservationStore } from '../src/store.mjs';
import { recall } from '../src/recall.mjs';
import { ValidationEngine, digestChangedPaths } from '../src/validation.mjs';

async function makeWorkspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-sol-validation-failure-'));
  t.after(async () => {
    const link = path.join(root, 'snapshot-link');
    try {
      if ((await lstat(link)).isSymbolicLink()) await unlink(link);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, 'target.py'), 'print(1)\n');
  const store = await createObservationStore(root);
  return { root, store };
}

function command(id, script) {
  return { id, argv: [process.execPath, '-e', script], cwd: '.', timeout_ms: 10000 };
}

function makeEngine(store, commands) {
  return new ValidationEngine(store, {
    schema_version: 1,
    rules: [{ schema_version: 1, id: 'python', globs: ['**/*.py'], watch_paths: ['**/*'], commands }],
  });
}

async function makeEvent(root, store) {
  return {
    schema_version: 1,
    event_id: randomUUID(),
    workspace_id: store.workspaceId,
    call_id: randomUUID(),
    origin: 'agent',
    changed_paths: ['target.py'],
    change_digest: await digestChangedPaths(root, ['target.py']),
  };
}

async function assertClosed(handle) {
  await assert.rejects(handle.stat(), (error) => error?.code === 'EBADF');
}

function storeWithBeginCaptureHook(store, hook) {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'beginCapture') return (meta) => hook(meta, target);
      return Reflect.get(target, property, receiver);
    },
  });
}

test('stderr capture startup failure retains and closes stdout temp files without launching the command', async (t) => {
  const { root, store } = await makeWorkspace(t);
  const blockedRoot = path.join(root, 'observations-blocker');
  const marker = path.join(root, 'command-started');
  await writeFile(blockedRoot, 'a regular file makes child capture paths invalid');
  const originalRoot = store.observationsRoot;
  const originalBeginCapture = store.beginCapture.bind(store);
  let beginCalls = 0;
  let stdoutWriter;

  const hookedStore = storeWithBeginCaptureHook(store, async (meta, target) => {
    beginCalls += 1;
    if (beginCalls === 1) {
      stdoutWriter = await originalBeginCapture(meta);
      return stdoutWriter;
    }
    if (beginCalls === 2) {
      target.observationsRoot = blockedRoot;
      try {
        return await originalBeginCapture(meta);
      } finally {
        target.observationsRoot = originalRoot;
      }
    }
    return originalBeginCapture(meta);
  });
  const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`;
  const engine = makeEngine(hookedStore, [command('marker', script)]);

  const receipt = await engine.onChange(await makeEvent(root, store));

  assert.equal(store.observationsRoot, originalRoot);
  assert.equal(beginCalls, 3, 'stdout, failed stderr, then receipt evidence capture');
  assert.equal(receipt.status, 'error');
  assert.equal(receipt.checks.length, 1);
  assert.equal(receipt.checks[0].status, 'error');
  assert.match(receipt.checks[0].reason, /runner_error:STORAGE_ERROR/u);
  assert.deepEqual(receipt.checks[0].output, []);
  await assert.rejects(readFile(marker), (error) => error?.code === 'ENOENT');

  assert.ok(stdoutWriter);
  await assertClosed(stdoutWriter.raw);
  await assertClosed(stdoutWriter.index);
  const tempEntries = await readdir(stdoutWriter.tempDirectory);
  assert.ok(tempEntries.includes('raw'));
  assert.ok(tempEntries.includes('lines.idx'));
  assert.deepEqual(await readFile(path.join(stdoutWriter.tempDirectory, 'raw')), Buffer.alloc(0));
  await assert.rejects(store.readVerified(stdoutWriter.handle), (error) => error?.code === 'NOT_FOUND');
  assert.ok(receipt.evidence_handle, 'restored store path allows receipt evidence to be archived');
});

test('receipt commit conflict returns storage error while preserving passed checks and no evidence handle', async (t) => {
  const { root, store } = await makeWorkspace(t);
  let receiptWriter;
  const hookedStore = storeWithBeginCaptureHook(store, async (meta, target) => {
    const writer = await target.beginCapture(meta);
    if (meta.tool === 'validation_receipt') {
      receiptWriter = writer;
      await writeFile(path.join(writer.tempDirectory, 'meta.json'), 'block the wx commit with a real file');
    }
    return writer;
  });
  const engine = makeEngine(hookedStore, [command('ok', "process.stdout.write('passed')")]);

  const receipt = await engine.onChange(await makeEvent(root, store));

  assert.equal(receipt.status, 'error');
  assert.equal(receipt.reason, 'storage');
  assert.equal(receipt.evidence_handle, null);
  assert.equal(receipt.checks.length, 1);
  assert.equal(receipt.checks[0].status, 'passed');
  assert.equal(receipt.checks[0].reason, 'success');
  assert.equal(receipt.checks[0].output.length, 2);
  for (const output of receipt.checks[0].output) {
    assert.equal((await store.readVerified(output.handle)).meta.complete, true);
  }

  assert.ok(receiptWriter);
  await assertClosed(receiptWriter.raw);
  await assertClosed(receiptWriter.index);
  const tempEntries = await readdir(receiptWriter.tempDirectory);
  assert.ok(tempEntries.includes('raw'));
  assert.ok(tempEntries.includes('lines.idx'));
  assert.ok(tempEntries.includes('meta.json'));
  assert.equal(await readFile(path.join(receiptWriter.tempDirectory, 'meta.json'), 'utf8'), 'block the wx commit with a real file');
  await assert.rejects(store.readVerified(receiptWriter.handle), (error) => error?.code === 'NOT_FOUND');
});

test('a command-created directory link makes the after snapshot fail while retaining its passed check', async (t) => {
  const { root, store } = await makeWorkspace(t);
  const probeTarget = path.join(root, 'link-probe-target');
  const probeLink = path.join(root, 'link-probe');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await mkdir(probeTarget);
  try {
    await symlink(probeTarget, probeLink, linkType);
  } catch (error) {
    await rm(probeLink, { force: true }).catch(() => {});
    await rm(probeTarget, { recursive: true, force: true });
    if (['EACCES', 'EPERM', 'ENOTSUP', 'ENOSYS'].includes(error?.code)) {
      t.skip(`directory symlinks/junctions are unavailable here (${error.code})`);
      return;
    }
    throw error;
  }
  await rm(probeLink, { force: true });
  await rm(probeTarget, { recursive: true, force: true });

  const script = [
    "const fs=require('node:fs')",
    "const path=require('node:path')",
    "fs.mkdirSync('snapshot-target')",
    "fs.symlinkSync(path.resolve('snapshot-target'),'snapshot-link',process.platform==='win32'?'junction':'dir')",
  ].join(';');
  const engine = makeEngine(store, [command('create-link', script)]);

  const receipt = await engine.onChange(await makeEvent(root, store));

  assert.equal(receipt.status, 'error');
  assert.equal(receipt.reason, 'runner:SNAPSHOT_ERROR');
  assert.equal(receipt.checks.length, 1);
  assert.equal(receipt.checks[0].status, 'passed');
  assert.equal(receipt.checks[0].reason, 'success');
  assert.equal(receipt.checks[0].exit_code, 0);
  assert.ok(receipt.evidence_handle);
  assert.equal((await lstat(path.join(root, 'snapshot-link'))).isSymbolicLink(), true);
});

test('a valid running marker recovers to a recallable interrupted receipt and deduplicates redelivery', async (t) => {
  const { root, store } = await makeWorkspace(t);
  const marker = path.join(root, 'command-started');
  const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`;
  const commands = [command('must-not-run', script)];
  const event = await makeEvent(root, store);
  const receiptsRoot = path.join(store.solRoot, 'receipts');
  await mkdir(receiptsRoot, { recursive: true });
  const eventHash = createHash('sha256').update(event.event_id).digest('hex');
  const runningPath = path.join(receiptsRoot, `${eventHash}.running`);
  const runningFile = await open(runningPath, 'wx', 0o600);
  try {
    await runningFile.writeFile(JSON.stringify({ event_id: event.event_id, started_at: new Date().toISOString() }));
    await runningFile.sync();
  } finally {
    await runningFile.close();
  }

  const first = await makeEngine(store, commands).onChange(event);

  assert.equal(first.status, 'error');
  assert.equal(first.reason, 'interrupted');
  assert.deepEqual(first.checks, []);
  assert.ok(first.evidence_handle);
  await assert.rejects(readFile(marker), (error) => error?.code === 'ENOENT');
  await assert.rejects(readFile(runningPath), (error) => error?.code === 'ENOENT');

  const serialized = Buffer.from(JSON.stringify(first), 'utf8');
  const recalled = await recall(store, {
    schema_version: 1,
    handle: first.evidence_handle,
    selector: { kind: 'bytes', start: 0, end: serialized.length },
  });
  assert.equal(recalled.truncated, false);
  assert.deepEqual(Buffer.from(recalled.chunks[0].base64, 'base64'), serialized);

  const receiptPath = path.join(receiptsRoot, `${eventHash}.json`);
  const persisted = JSON.parse(await readFile(receiptPath, 'utf8'));
  assert.equal(persisted.event_id, event.event_id);
  assert.deepEqual(persisted.receipt, first);

  const second = await makeEngine(store, commands).onChange(event);
  assert.deepEqual(second, first);
  await assert.rejects(readFile(marker), (error) => error?.code === 'ENOENT');
  await assert.rejects(readFile(runningPath), (error) => error?.code === 'ENOENT');
  assert.deepEqual(JSON.parse(await readFile(receiptPath, 'utf8')).receipt, first);
});

test('a missing in-workspace cwd is an ENOENT check failure and skips later commands', async (t) => {
  const { root, store } = await makeWorkspace(t);
  const firstMarker = path.join(root, 'missing-cwd-command-started');
  const secondMarker = path.join(root, 'later-command-started');
  const first = { ...command('missing-cwd', `require('node:fs').writeFileSync(${JSON.stringify(firstMarker)}, 'started')`), cwd: 'missing-command-directory' };
  const second = command('later', `require('node:fs').writeFileSync(${JSON.stringify(secondMarker)}, 'started')`);
  const receipt = await makeEngine(store, [first, second]).onChange(await makeEvent(root, store));

  assert.equal(receipt.status, 'error');
  assert.equal(receipt.checks.length, 2);
  assert.equal(receipt.checks[0].status, 'error');
  assert.equal(receipt.checks[0].reason, 'runner_error:ENOENT');
  assert.equal(receipt.checks[1].status, 'skipped');
  assert.equal(receipt.checks[1].reason, 'prior_failure');
  await assert.rejects(readFile(firstMarker), (error) => error?.code === 'ENOENT');
  await assert.rejects(readFile(secondMarker), (error) => error?.code === 'ENOENT');
  assert.ok(receipt.evidence_handle);

  const serialized = Buffer.from(JSON.stringify(receipt), 'utf8');
  const recalled = await recall(store, {
    schema_version: 1,
    handle: receipt.evidence_handle,
    selector: { kind: 'bytes', start: 0, end: serialized.length },
  });
  assert.equal(recalled.truncated, false);
  assert.deepEqual(Buffer.from(recalled.chunks[0].base64, 'base64'), serialized);
});
