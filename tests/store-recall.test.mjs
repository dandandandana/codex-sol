import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createObservationStore } from '../src/store.mjs';
import { recall } from '../src/recall.mjs';

const PAGE_BUDGET_BYTES = 8192;

async function makeStore(t) {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-sol-store-recall-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  return { workspaceRoot, store: await createObservationStore(workspaceRoot) };
}

function captureMeta(store, overrides = {}) {
  return {
    schema_version: 1,
    workspace_id: store.workspaceId,
    call_id: randomUUID(),
    tool: 'node-test',
    captured_at: '2026-09-29T00:00:00Z',
    media_type: 'application/octet-stream',
    encoding: null,
    source_form: 'stream_bytes',
    channel: 'stdout',
    ...overrides,
  };
}

async function capture(store, bytes, overrides = {}) {
  const writer = await store.beginCapture(captureMeta(store, overrides));
  const chunkSize = 64 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    await writer.write(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return writer.commit({ complete: true });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function assertTextChunk(chunk, expectedText, expectedStart, expectedEnd) {
  assert.equal(typeof chunk.text, 'string');
  assert.equal(chunk.start_byte, expectedStart);
  assert.equal(chunk.end_byte, expectedEnd);
  assert.equal(Buffer.byteLength(chunk.text, 'utf8'), expectedEnd - expectedStart);
  assert.equal(chunk.text, expectedText);
  assert.equal(Object.hasOwn(chunk, 'base64'), false);
}

function assertBase64Chunk(chunk, expectedBytes, expectedStart, expectedEnd) {
  assert.equal(chunk.start_byte, expectedStart);
  assert.equal(chunk.end_byte, expectedEnd);
  assert.equal(Object.hasOwn(chunk, 'text'), false);
  assert.equal(typeof chunk.base64, 'string');
  assert.deepEqual(Buffer.from(chunk.base64, 'base64'), expectedBytes);
}

async function assertErrorCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code);
    return true;
  });
}

async function collectPages(store, ref, selector, { maxPages = 256 } = {}) {
  const pages = [];
  let cursor;
  let expectedStart;

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const request = {
      schema_version: 1,
      handle: ref.handle,
      selector,
      ...(cursor ? { cursor } : {}),
    };
    const result = await recall(store, request);
    assert.equal(result.schema_version, 1);
    assert.equal(result.handle, ref.handle);
    assert.equal(result.sha256, ref.sha256);
    assert.ok(Array.isArray(result.chunks));
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= PAGE_BUDGET_BYTES);

    if (result.chunks.length > 0 && expectedStart !== undefined) {
      assert.equal(result.chunks[0].start_byte, expectedStart);
    }
    for (const chunk of result.chunks) {
      assert.ok(chunk.end_byte >= chunk.start_byte);
      expectedStart = chunk.end_byte;
    }
    pages.push(result);

    if (!result.truncated) {
      assert.equal(result.next_cursor, null);
      return pages;
    }

    assert.equal(typeof result.next_cursor, 'string');
    assert.ok(result.next_cursor.length > 0);
    cursor = result.next_cursor;
  }

  assert.fail(`recall exceeded ${maxPages} pages`);
}

test('captures and reads back 1 MiB exactly with a SHA-256 derived from stored bytes', async (t) => {
  const { store } = await makeStore(t);
  const original = randomBytes(1024 * 1024);
  const ref = await capture(store, original);

  const verified = await store.readVerified(ref.handle);
  assert.deepEqual(verified.buffer, original);
  assert.equal(verified.meta.sha256, sha256(original));
  assert.equal(verified.meta.sha256, ref.sha256);
  assert.equal(verified.meta.bytes, original.length);
  assert.equal(verified.meta.complete, true);
  assert.equal(ref.bytes, original.length);
  assert.equal(ref.complete, true);
});

test('archives the exact 8 KiB capture boundary', async (t) => {
  const { store } = await makeStore(t);
  const original = randomBytes(8 * 1024);
  const ref = await capture(store, original);

  assert.equal(ref.bytes, 8 * 1024);
  assert.equal(ref.sha256, sha256(original));
  const verified = await store.readVerified(ref.handle);
  assert.deepEqual(verified.buffer, original);
  assert.equal(verified.meta.bytes, 8 * 1024);
});

test('commit retains an incomplete capture marker in both the reference and verified metadata', async (t) => {
  const { store } = await makeStore(t);
  const original = Buffer.from('upstream output ended early', 'utf8');
  const writer = await store.beginCapture(captureMeta(store, {
    media_type: 'text/plain; charset=utf-8',
    encoding: 'utf-8',
  }));
  await writer.write(original);
  const ref = await writer.commit({ complete: false });

  const verified = await store.readVerified(ref.handle);
  assert.equal(ref.complete, false);
  assert.equal(verified.meta.complete, false);
  assert.deepEqual(verified.buffer, original);
});

test('lines preserve CRLF bytes, Chinese UTF-8, and a final line without newline', async (t) => {
  const { store } = await makeStore(t);
  const source = '第一行\r\n中文第二行\r\n最后一行';
  const bytes = Buffer.from(source, 'utf8');
  const ref = await capture(store, bytes, {
    media_type: 'text/plain; charset=utf-8',
    encoding: 'utf-8',
  });

  const result = await recall(store, {
    schema_version: 1,
    handle: ref.handle,
    selector: { kind: 'lines', start: 1, end: 3 },
  });

  assert.equal(result.truncated, false);
  assert.equal(result.next_cursor, null);
  assert.equal(result.chunks.length, 1);
  assertTextChunk(result.chunks[0], source, 0, bytes.length);
});

test('keyword recall is literal, case-sensitive, and merges overlapping context windows', async (t) => {
  const { store } = await makeStore(t);
  const source = [
    'before',
    'a.b first match',
    'middle',
    'a.b second match',
    'after',
    'axb regex decoy',
    'A.B case decoy',
  ].join('\n');
  const bytes = Buffer.from(source, 'utf8');
  const ref = await capture(store, bytes, {
    media_type: 'text/plain; charset=utf-8',
    encoding: 'utf-8',
  });

  const result = await recall(store, {
    schema_version: 1,
    handle: ref.handle,
    selector: { kind: 'keyword', literal: 'a.b', context_lines: 1 },
  });

  const expected = `${['before', 'a.b first match', 'middle', 'a.b second match', 'after'].join('\n')}\n`;
  assert.equal(result.truncated, false);
  assert.equal(result.chunks.length, 1);
  assertTextChunk(result.chunks[0], expected, 0, Buffer.byteLength(expected, 'utf8'));
  assert.equal(result.chunks[0].text.includes('axb regex decoy'), false);
  assert.equal(result.chunks[0].text.includes('A.B case decoy'), false);
});

test('binary captures return precise base64 byte slices and reject text selectors for invalid UTF-8', async (t) => {
  const { store } = await makeStore(t);
  const source = Buffer.from([0x00, 0xff, 0xc3, 0x28, 0x80, 0x0a, 0x41]);
  const ref = await capture(store, source);
  const start = 1;
  const end = 6;

  const result = await recall(store, {
    schema_version: 1,
    handle: ref.handle,
    selector: { kind: 'bytes', start, end },
  });

  assert.equal(result.chunks.length, 1);
  assertBase64Chunk(result.chunks[0], source.subarray(start, end), start, end);
  await assertErrorCode(recall(store, {
    schema_version: 1,
    handle: ref.handle,
    selector: { kind: 'lines', start: 1, end: 1 },
  }), 'UNSUPPORTED_ENCODING');
  await assertErrorCode(recall(store, {
    schema_version: 1,
    handle: ref.handle,
    selector: { kind: 'keyword', literal: 'A' },
  }), 'UNSUPPORTED_ENCODING');
});

test('128 randomized byte ranges return the exact base64 slice and half-open offsets', async (t) => {
  const { store } = await makeStore(t);
  const source = randomBytes(256 * 1024);
  const ref = await capture(store, source);
  const nextRandom = seededRandom(0x5eedc0de);

  for (let index = 0; index < 128; index += 1) {
    const start = nextRandom() % source.length;
    const maxLength = Math.min(2048, source.length - start);
    const end = start + 1 + (nextRandom() % maxLength);
    const result = await recall(store, {
      schema_version: 1,
      handle: ref.handle,
      selector: { kind: 'bytes', start, end },
    });

    assert.equal(result.truncated, false);
    assert.equal(result.next_cursor, null);
    assert.equal(result.chunks.length, 1);
    assertBase64Chunk(result.chunks[0], source.subarray(start, end), start, end);
  }
});

test('an oversized single line paginates without losing or repeating bytes', async (t) => {
  const { store } = await makeStore(t);
  const source = Buffer.from(`${'long-line-🙂-'.repeat(6000)}tail`, 'utf8');
  const ref = await capture(store, source, {
    media_type: 'text/plain; charset=utf-8',
    encoding: 'utf-8',
  });

  const pages = await collectPages(store, ref, { kind: 'lines', start: 1, end: 1 });
  assert.ok(pages.length > 1);
  assert.equal(pages.at(-1).truncated, false);
  const chunks = pages.flatMap((page) => page.chunks);
  assert.ok(chunks.length > 1);

  let nextByte = 0;
  const pieces = [];
  for (const chunk of chunks) {
    assert.equal(chunk.start_byte, nextByte);
    const piece = Buffer.from(chunk.text, 'utf8');
    assert.equal(piece.length, chunk.end_byte - chunk.start_byte);
    pieces.push(piece);
    nextByte = chunk.end_byte;
  }
  assert.equal(nextByte, source.length);
  assert.deepEqual(Buffer.concat(pieces), source);
});

test('detects tampering and missing raw object files', async (t) => {
  const { workspaceRoot, store } = await makeStore(t);
  const source = randomBytes(128);
  const ref = await capture(store, source);
  const rawPath = path.join(workspaceRoot, '.codex', 'sol', 'observations', ref.handle, 'raw');

  const tampered = Buffer.from(source);
  tampered[0] ^= 0xff;
  await writeFile(rawPath, tampered);
  await assertErrorCode(store.readVerified(ref.handle), 'CORRUPT');

  await writeFile(rawPath, source);
  await rm(rawPath);
  await assertErrorCode(store.readVerified(ref.handle), 'NOT_FOUND');
});

test('rejects invalid byte and line ranges, malformed cursors, and selector-mismatched cursors', async (t) => {
  const { store } = await makeStore(t);
  const source = Buffer.from('first\nsecond\nthird', 'utf8');
  const ref = await capture(store, source, {
    media_type: 'text/plain; charset=utf-8',
    encoding: 'utf-8',
  });

  await assertErrorCode(recall(store, {
    schema_version: 1,
    handle: ref.handle,
    selector: { kind: 'bytes', start: 5, end: 4 },
  }), 'INVALID_RANGE');
  await assertErrorCode(recall(store, {
    schema_version: 1,
    handle: ref.handle,
    selector: { kind: 'bytes', start: 0, end: source.length + 1 },
  }), 'INVALID_RANGE');
  await assertErrorCode(recall(store, {
    schema_version: 1,
    handle: ref.handle,
    selector: { kind: 'lines', start: 3, end: 2 },
  }), 'INVALID_RANGE');
  await assertErrorCode(recall(store, {
    schema_version: 1,
    handle: ref.handle,
    selector: { kind: 'lines', start: 1, end: 4 },
  }), 'INVALID_RANGE');
  await assertErrorCode(recall(store, {
    schema_version: 1,
    handle: ref.handle,
    selector: { kind: 'lines', start: 1, end: 1 },
    cursor: 'not-a-valid-cursor',
  }), 'INVALID_CURSOR');

  const longSource = Buffer.from('x'.repeat(24 * 1024), 'utf8');
  const longRef = await capture(store, longSource, {
    media_type: 'text/plain; charset=utf-8',
    encoding: 'utf-8',
  });
  const firstPage = await recall(store, {
    schema_version: 1,
    handle: longRef.handle,
    selector: { kind: 'lines', start: 1, end: 1 },
  });
  assert.equal(firstPage.truncated, true);
  assert.equal(typeof firstPage.next_cursor, 'string');
  await assertErrorCode(recall(store, {
    schema_version: 1,
    handle: longRef.handle,
    selector: { kind: 'bytes', start: 0, end: longSource.length },
    cursor: firstPage.next_cursor,
  }), 'INVALID_CURSOR');
});

test('a keyword with no matches returns an empty complete result', async (t) => {
  const { store } = await makeStore(t);
  const source = Buffer.from('alpha\nbeta\ngamma', 'utf8');
  const ref = await capture(store, source, {
    media_type: 'text/plain; charset=utf-8',
    encoding: 'utf-8',
  });

  const result = await recall(store, {
    schema_version: 1,
    handle: ref.handle,
    selector: { kind: 'keyword', literal: 'missing', context_lines: 2 },
  });

  assert.deepEqual(result.chunks, []);
  assert.equal(result.truncated, false);
  assert.equal(result.next_cursor, null);
  assert.equal(result.handle, ref.handle);
  assert.equal(result.sha256, ref.sha256);
});
