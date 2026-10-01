import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readObservation } from '../src/read.mjs';
import { createObservationStore } from '../src/store.mjs';
import { pack } from '../src/pack.mjs';
import { recall } from '../src/recall.mjs';

async function makeStore(t) {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-sol-capture-failure-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  return { workspaceRoot, store: await createObservationStore(workspaceRoot) };
}

function captureMeta(store, overrides = {}) {
  return {
    schema_version: 1,
    workspace_id: store.workspaceId,
    call_id: randomUUID(),
    tool: 'node-test',
    captured_at: '2026-09-30T00:00:00Z',
    media_type: 'text/plain; charset=utf-8',
    encoding: 'utf-8',
    source_form: 'stream_bytes',
    channel: 'stdout',
    ...overrides,
  };
}

function packOf(result) {
  const value = result?.value;
  return value?.observation ?? value;
}

async function assertClosed(handle) {
  await assert.rejects(handle.stat(), (error) => error?.code === 'EBADF');
}

function storeWithCapturedWriter(store, onWriter) {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'beginCapture') {
        return async (meta) => {
          const writer = await target.beginCapture(meta);
          onWriter(writer);
          return writer;
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

test('does not start the source when beginCapture fails with a real filesystem error', async (t) => {
  const { store } = await makeStore(t);
  await rm(store.observationsRoot, { recursive: true });
  await writeFile(store.observationsRoot, 'regular file blocks capture directory creation');
  let sourceStarted = false;

  const result = await readObservation(store, captureMeta(store), () => {
    sourceStarted = true;
    return (async function* source() { yield Buffer.from('must not run'); }());
  });

  assert.equal(sourceStarted, false);
  assert.equal(result.isError, true);
  const pack = packOf(result);
  assert.equal(pack.mode, 'storage_error');
  assert.deepEqual(pack.raw, []);
  assert.match(pack.summary, /tool_may_have_executed=false/);
  assert.equal(Object.hasOwn(pack, 'handle'), false);
});

test('cancellation after the first chunk archives exactly that prefix as incomplete', async (t) => {
  const { store } = await makeStore(t);
  const controller = new AbortController();
  const prefix = Buffer.from('captured prefix\n', 'utf8');

  const result = await readObservation(store, captureMeta(store), ({ signal }) => (async function* source() {
    yield prefix;
    // The iterator resumes only after the first yielded chunk has been written.
    controller.abort(new Error('cancelled after first chunk'));
    throw signal.reason;
  }()), { signal: controller.signal });

  assert.equal(controller.signal.aborted, true);
  assert.equal(result.isError, true);
  assert.equal(result.value?.error?.code, 'INTERRUPTED');
  const pack = packOf(result);
  assert.equal(pack.raw.length, 1);
  assert.equal(pack.raw[0].complete, false);
  const archived = await store.readVerified(pack.raw[0].handle);
  assert.deepEqual(archived.buffer, prefix);
  assert.equal(archived.meta.complete, false);
});

test('an upstream read error preserves the exact captured prefix and incomplete marker', async (t) => {
  const { store } = await makeStore(t);
  const prefix = Buffer.from('before upstream error\n', 'utf8');

  const result = await readObservation(store, captureMeta(store), () => (async function* source() {
    yield prefix;
    throw new Error('upstream read failed');
  }()));

  assert.equal(result.isError, true);
  assert.ok(result.value?.error);
  const pack = packOf(result);
  assert.equal(pack.raw.length, 1);
  assert.equal(pack.raw[0].complete, false);
  const archived = await store.readVerified(pack.raw[0].handle);
  assert.deepEqual(archived.buffer, prefix);
  assert.equal(archived.meta.complete, false);
});

test('an upstream error after more than 8 KiB keeps the full partial raw and bounds the error envelope', async (t) => {
  const { store } = await makeStore(t);
  const prefix = Buffer.from('large partial output\n'.repeat(2048), 'utf8');

  const result = await readObservation(store, captureMeta(store), () => (async function* source() {
    yield prefix;
    throw new Error('upstream read failed after large prefix');
  }()));

  assert.equal(result.isError, true);
  assert.ok(result.value?.error);
  assert.ok(Buffer.byteLength(JSON.stringify(result.value), 'utf8') <= 4096);
  const observation = result.value.observation;
  assert.equal(observation.raw.length, 1);
  assert.equal(observation.raw[0].bytes, prefix.length);
  assert.equal(observation.raw[0].complete, false);
  const archived = await store.readVerified(observation.raw[0].handle);
  assert.deepEqual(archived.buffer, prefix);
  assert.equal(archived.meta.complete, false);
});

test('pack reports a mismatched opened ref as storage_error and closes its real raw and index handles', async (t) => {
  const { store } = await makeStore(t);
  const writer = await store.beginCapture(captureMeta(store));
  await writer.write(Buffer.from('real stored bytes', 'utf8'));
  const ref = await writer.commit({ complete: true });
  const opened = [];
  const instrumentedStore = new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'openVerified') {
        return async (handle) => {
          const value = await target.openVerified(handle);
          opened.push(value);
          return value;
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const meta = { schema_version: 1, call_id: randomUUID(), tool: 'node-test', tool_status: 'ok', upstream_complete: true };

  const result = await pack(instrumentedStore, meta, [{ ...ref, bytes: ref.bytes + 1 }]);

  assert.equal(result.mode, 'storage_error');
  assert.equal(opened.length, 1);
  await assertClosed(opened[0].raw);
  await assertClosed(opened[0].index);
});

test('a real closed-file-handle write failure closes capture handles and retains only the temp archive', async (t) => {
  const { store } = await makeStore(t);
  let writer;
  const instrumentedStore = storeWithCapturedWriter(store, (value) => { writer = value; });
  const prefix = Buffer.from('durable prefix\n', 'utf8');
  const suffix = Buffer.from('write must fail', 'utf8');

  const result = await readObservation(instrumentedStore, captureMeta(store), () => (async function* source() {
    yield prefix;
    // Closing the actual CaptureWriter file handle makes its next write fail with EBADF.
    await writer.raw.close();
    yield suffix;
  }()));

  assert.equal(result.isError, true);
  const pack = packOf(result);
  assert.equal(pack.mode, 'storage_error');
  assert.deepEqual(pack.raw, []);
  assert.match(pack.summary, /tool_may_have_executed=true/);
  assert.equal(Object.hasOwn(pack, 'handle'), false);
  assert.ok(writer);
  await assertClosed(writer.raw);
  await assertClosed(writer.index);
  const tempEntries = await readdir(writer.tempDirectory);
  assert.ok(tempEntries.includes('raw'));
  assert.ok(tempEntries.includes('lines.idx'));
  assert.deepEqual(await readFile(path.join(writer.tempDirectory, 'raw')), prefix);
  await assert.rejects(store.readVerified(writer.handle), (error) => error?.code === 'NOT_FOUND');
});

test('a real meta.json create conflict at commit returns storage_error without publishing a handle', async (t) => {
  const { store } = await makeStore(t);
  let writer;
  const instrumentedStore = storeWithCapturedWriter(store, (value) => { writer = value; });
  const bytes = Buffer.from('captured before commit conflict', 'utf8');

  const result = await readObservation(instrumentedStore, captureMeta(store), () => (async function* source() {
    yield bytes;
    await writeFile(path.join(writer.tempDirectory, 'meta.json'), 'block wx commit');
  }()));

  assert.equal(result.isError, true);
  const pack = packOf(result);
  assert.equal(pack.mode, 'storage_error');
  assert.deepEqual(pack.raw, []);
  assert.match(pack.summary, /tool_may_have_executed=true/);
  assert.equal(Object.hasOwn(pack, 'handle'), false);
  assert.ok(writer);
  assert.ok((await readdir(store.observationsRoot)).includes(path.basename(writer.tempDirectory)));
  assert.deepEqual(await readFile(path.join(writer.tempDirectory, 'raw')), bytes);
  assert.equal(await readFile(path.join(writer.tempDirectory, 'meta.json'), 'utf8'), 'block wx commit');
  await assert.rejects(store.readVerified(writer.handle), (error) => error?.code === 'NOT_FOUND');
});

test('large stream output stays bounded and remains recallable from the same store', async (t) => {
  const { workspaceRoot, store } = await makeStore(t);
  const sourcePath = path.join(workspaceRoot, 'large-output.txt');
  const expected = Buffer.from('large-output-line\n'.repeat(16 * 1024), 'utf8');
  await writeFile(sourcePath, expected);
  let sourceStarts = 0;

  const result = await readObservation(store, captureMeta(store), () => {
    sourceStarts += 1;
    return createReadStream(sourcePath);
  });

  assert.equal(sourceStarts, 1);
  assert.equal(result.isError, false);
  const pack = packOf(result);
  assert.equal(pack.mode, 'packed');
  assert.equal(pack.raw.length, 1);
  assert.equal(pack.raw[0].bytes, expected.length);
  assert.equal(pack.raw[0].complete, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result.value), 'utf8') <= 4096);

  const recalled = await recall(store, {
    schema_version: 1,
    handle: pack.raw[0].handle,
    selector: { kind: 'bytes', start: 0, end: 64 },
  });
  assert.equal(Buffer.from(recalled.chunks[0].base64, 'base64').toString('utf8'), expected.subarray(0, 64).toString('utf8'));
  assert.equal(recalled.truncated, false);
});
