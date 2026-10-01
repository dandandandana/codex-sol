import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createObservationStore } from '../src/store.mjs';
import { pack } from '../src/pack.mjs';
import { recall } from '../src/recall.mjs';

async function capture(size, complete = true) {
  const root = await mkdtemp(join(tmpdir(), 'codex-sol-pack-'));
  const store = await createObservationStore(root);
  const writer = await store.beginCapture({ schema_version: 1, workspace_id: store.workspaceId, call_id: 'pack-test', tool: 'sample', captured_at: new Date().toISOString(), media_type: 'text/plain', encoding: 'utf-8', source_form: 'stream_bytes', channel: 'response' });
  await writer.write(Buffer.from('中'.repeat(Math.floor(size / 3)) + 'a'.repeat(size % 3)));
  const ref = await writer.commit({ complete });
  return { store, ref };
}

const meta = { schema_version: 1, call_id: 'pack-test', tool: 'sample', tool_status: 'ok', upstream_complete: true };

test('pack honors all three sides of the 8 KiB boundary and fits 4 KiB', async () => {
  for (const size of [8191, 8192, 8193, 1024 * 1024]) {
    const { store, ref } = await capture(size);
    const result = await pack(store, meta, [ref]);
    assert.equal(result.mode, size <= 8192 ? 'inline' : 'packed');
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4096);
    assert.equal(result.raw[0].bytes, size);
    assert.equal(result.omitted_bytes + result.excerpts.reduce((total, part) => total + part.end_byte - part.start_byte, 0), size);
    for (const excerpt of result.excerpts) {
      const raw = (await store.readVerified(ref.handle)).buffer;
      assert.equal(raw.subarray(excerpt.start_byte, excerpt.end_byte).toString('utf8'), excerpt.text);
    }
  }
});

test('pack preserves upstream errors and explicitly reports lost storage', async () => {
  const { store, ref } = await capture(9000);
  const failed = await pack(store, { ...meta, tool_status: 'error', upstream_complete: false }, [ref]);
  assert.equal(failed.tool_status, 'error');
  assert.match(failed.reason, /upstream_error/);
  await unlink(join(store.observationsRoot, ref.handle, 'raw'));
  const lost = await pack(store, meta, [ref]);
  assert.equal(lost.mode, 'storage_error');
  assert.notEqual(lost.tool_status, 'unknown');
});

test('a 1 MiB packed observation can be reconstructed through bounded recall pages', async () => {
  const { store, ref } = await capture(1024 * 1024);
  const packed = await pack(store, meta, [ref]);
  assert.equal(packed.mode, 'packed');
  const bytes = [];
  let cursor;
  do {
    const page = await recall(store, { schema_version: 1, handle: ref.handle, selector: { kind: 'bytes', start: 0, end: ref.bytes }, ...(cursor ? { cursor } : {}) });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 8192);
    bytes.push(...page.chunks.map((chunk) => Buffer.from(chunk.base64, 'base64')));
    cursor = page.next_cursor;
  } while (cursor);
  assert.equal(Buffer.concat(bytes).length, ref.bytes);
  assert.equal(createHash('sha256').update(Buffer.concat(bytes)).digest('hex'), ref.sha256);
});

test('incomplete upstream capture stays incomplete with its timeout status', async () => {
  const { store, ref } = await capture(9000, false);
  const result = await pack(store, { ...meta, tool_status: 'timeout', upstream_complete: false }, [ref]);
  assert.equal(ref.complete, false);
  assert.equal(result.tool_status, 'timeout');
  assert.match(result.summary, /raw_complete=false/);
  assert.equal(result.mode, 'packed');
});
