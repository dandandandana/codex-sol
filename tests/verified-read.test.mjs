import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { createObservationStore, SolFault } from '../src/store.mjs';
import { recall } from '../src/recall.mjs';
import { pack } from '../src/pack.mjs';
import { readObservation } from '../src/read.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const request = (ref, selector, cursor) => ({ schema_version: 1, handle: ref.handle, selector, ...(cursor ? { cursor } : {}) });
async function fixture(t, bytes) {
  const root = await mkdtemp(join(tmpdir(), 'sol-verified-read-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await createObservationStore(root);
  const captureMeta = { schema_version: 1, workspace_id: store.workspaceId, call_id: 'verified-read', tool: 'test',
    captured_at: '2026-10-06T00:00:00Z', media_type: 'text/plain', encoding: 'utf-8', source_form: 'stream_bytes', channel: 'response' };
  const writer = await store.beginCapture(captureMeta);
  for (let start = 0; start < bytes.length; start += 65536) await writer.write(bytes.subarray(start, start + 65536));
  const ref = await writer.commit({ complete: true });
  return { store, ref, captureMeta, dir: join(store.observationsRoot, ref.handle) };
}

function watchFiles(t, callback) {
  const actualOpen = fs.open;
  const handles = [];
  fs.open = async (...args) => {
    const file = await actualOpen(...args);
    handles.push({ file, name: basename(args[0]) });
    callback?.(file, basename(args[0]));
    return file;
  };
  syncBuiltinESMExports();
  t.after(() => { fs.open = actualOpen; syncBuiltinESMExports(); });
  return handles;
}
async function closed(handles) {
  assert.ok(handles.length);
  for (const { file } of handles) await assert.rejects(file.stat(), { code: 'EBADF' });
}

async function replaceArchive(dir, bytes) {
  const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
  const offsets = [0];
  for (let i = 0; i < bytes.length; i += 1) if (bytes[i] === 10) offsets.push(i + 1);
  const index = Buffer.alloc(offsets.length * 8);
  offsets.forEach((at, i) => index.writeBigUInt64LE(BigInt(at), i * 8));
  await writeFile(join(dir, 'raw'), bytes);
  await writeFile(join(dir, 'lines.idx'), index);
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ ...meta, sha256: digest(bytes), bytes: bytes.length,
    index_sha256: digest(index), line_count: bytes.length ? offsets.length - (bytes.at(-1) === 10 ? 1 : 0) : 0 }));
}

async function pages(store, ref, selector) {
  const result = [];
  let cursor;
  do {
    const page = await recall(store, request(ref, selector, cursor));
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 8192);
    result.push(page);
    cursor = page.next_cursor;
    assert.ok(result.length < 100);
  } while (cursor);
  return result;
}

test('verified reads close real descriptors on success, collector failure and cancellation', async (t) => {
  const { store, ref } = await fixture(t, Buffer.alloc(180000, 120));
  const handles = watchFiles(t);
  const ok = await store.readVerified(ref.handle);
  assert.equal(digest(ok.buffer), ref.sha256);
  await closed(handles.splice(0));
  let published = false;
  await assert.rejects(store.withVerifiedRead(ref.handle, () => ({ onChunk() { throw new SolFault('TEST_FAILURE', 'collector failed'); }, finish() { published = true; } })), { code: 'TEST_FAILURE' });
  assert.equal(published, false);
  await closed(handles.splice(0));
  const controller = new AbortController();
  await assert.rejects(store.withVerifiedRead(ref.handle, () => ({ onChunk() { controller.abort(); }, finish() { published = true; } }), { signal: controller.signal }), { code: 'INTERRUPTED' });
  assert.equal(published, false);
  await closed(handles.splice(0));
  const host = new AbortController();
  host.abort(new SolFault('HOST_STATE_ERROR', 'host probe failed'));
  await assert.rejects(store.verify(ref.handle, { signal: host.signal }), { code: 'HOST_STATE_ERROR' });
});

test('post-hash mutation cannot return changed bytes with the old SHA', async (t) => {
  const original = Buffer.from('original');
  const { store, ref, dir } = await fixture(t, original);
  let mutated = false;
  const handles = watchFiles(t, (file, name) => {
    if (name !== 'raw') return;
    const actualRead = file.read.bind(file);
    file.read = async (...args) => {
      const result = await actualRead(...args);
      if (!result.bytesRead && !mutated) { mutated = true; await writeFile(join(dir, 'raw'), Buffer.from('modified')); }
      return result;
    };
  });
  await assert.rejects(store.readVerified(ref.handle), { code: 'CORRUPT' });
  assert.equal(mutated, true);
  await closed(handles);
});

test('metadata changes during verification prevent candidate publication', async (t) => {
  const { store, ref, dir } = await fixture(t, Buffer.from('one\ntwo'));
  const metaPath = join(dir, 'meta.json');
  const meta = JSON.parse(await readFile(metaPath, 'utf8'));
  let published = false;
  await assert.rejects(store.withVerifiedRead(ref.handle, () => ({
    async onChunk() { await writeFile(metaPath, JSON.stringify({ ...meta, call_id: 'replacement' })); },
    finish() { published = true; },
  })), { code: 'CORRUPT' });
  assert.equal(published, false);
});

test('a rehashed but semantically false line index is rejected', async (t) => {
  const { store, ref, dir } = await fixture(t, Buffer.from('first\nsecond\nthird'));
  const index = await readFile(join(dir, 'lines.idx'));
  index.writeBigUInt64LE(3n, 8);
  await writeFile(join(dir, 'lines.idx'), index);
  const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ ...meta, index_sha256: digest(index) }));
  await assert.rejects(recall(store, request(ref, { kind: 'lines', start: 2, end: 2 })), { code: 'CORRUPT' });
});

test('existing empty, LF-final and non-LF index layouts remain readable', async (t) => {
  for (const source of ['', '\n', 'a\n', 'a', 'a\nb']) {
    const bytes = Buffer.from(source);
    const { store, ref } = await fixture(t, bytes);
    assert.deepEqual((await store.readVerified(ref.handle)).buffer, bytes);
    const count = source ? source.split('\n').length - (source.endsWith('\n') ? 1 : 0) : 0;
    assert.equal((await store.verify(ref.handle)).meta.line_count, count);
    if (count) assert.equal((await recall(store, request(ref, { kind: 'lines', start: 1, end: count }))).chunks[0].text, source);
  }
});

test('fatal UTF-8 checks cover bytes outside a text page and across blocks', async (t) => {
  const bytes = Buffer.concat([Buffer.from('good\n'), Buffer.alloc(70000, 120), Buffer.from([255])]);
  const { store, ref } = await fixture(t, bytes);
  await assert.rejects(recall(store, request(ref, { kind: 'lines', start: 1, end: 1 })), { code: 'UNSUPPORTED_ENCODING' });
  const split = Buffer.from(`${'x'.repeat(65535)}🙂\r\n中文\r\ntail`);
  const f = await fixture(t, split);
  const results = await pages(f.store, f.ref, { kind: 'lines', start: 1, end: 3 });
  assert.deepEqual(Buffer.concat(results.flatMap((page) => page.chunks.map((chunk) => Buffer.from(chunk.text)))), split);
});

test('keyword literals cross scan blocks and lines, context windows merge and cursors skip gaps', async (t) => {
  const source = `${'a'.repeat(65533)}needle\r\nnext\nfar\nfar\nneedle\nend`;
  const { store, ref } = await fixture(t, Buffer.from(source));
  const results = await pages(store, ref, { kind: 'keyword', literal: 'needle', context_lines: 0 });
  const text = results.flatMap((page) => page.chunks.map((chunk) => chunk.text)).join('');
  assert.equal(text, `${'a'.repeat(65533)}needle\r\nneedle\n`);
  const f = await fixture(t, Buffer.from('before\none\ntwo\nafter\nfar\nfar\none\ntwo\ntail'));
  for (const literal of ['one\ntwo', 'one\n', '\n', '\none\n']) {
    const context = literal === '\n' ? 0 : 1;
    const result = await pages(f.store, f.ref, { kind: 'keyword', literal, context_lines: context });
    const expected = literal === '\n' ? 'before\none\ntwo\nafter\nfar\nfar\none\ntwo\n'
      : literal === 'one\n' ? 'before\none\ntwo\nfar\none\ntwo\n'
      : literal === '\none\n' ? 'before\none\ntwo\nfar\nfar\none\ntwo\n'
      : 'before\none\ntwo\nafter\nfar\none\ntwo\ntail';
    assert.equal(result.flatMap((page) => page.chunks.map((chunk) => chunk.text)).join(''), expected, literal);
  }
});

test('keyword second scan binds first metadata instead of explaining old windows with a replacement', async (t) => {
  const { store, ref, dir } = await fixture(t, Buffer.from('before\nneedle\nafter'));
  const actualRead = store.withVerifiedRead.bind(store);
  let scans = 0;
  store.withVerifiedRead = async (...args) => {
    const result = await actualRead(...args);
    if (++scans === 1) await replaceArchive(dir, Buffer.from('changed\nneedle\nafter'));
    return result;
  };
  await assert.rejects(recall(store, request(ref, { kind: 'keyword', literal: 'needle' })), { code: 'CORRUPT' });
});

test('cursor rejects a coherent raw/index replacement and a metadata-only replacement', async (t) => {
  for (const rawChange of [true, false]) {
    const { store, ref, dir } = await fixture(t, Buffer.alloc(20000, 120));
    const selector = { kind: 'lines', start: 1, end: 1 };
    const first = await recall(store, request(ref, selector));
    if (rawChange) await replaceArchive(dir, Buffer.alloc(20000, 121));
    else {
      const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
      await writeFile(join(dir, 'meta.json'), JSON.stringify({ ...meta, call_id: 'other' }));
    }
    await assert.rejects(recall(store, request(ref, selector, first.next_cursor)), { code: 'INVALID_CURSOR' });
  }
});

test('bounded JSON helpers enforce limit, metadata identity, UTF-8 and parsing errors', async (t) => {
  const { store, ref } = await fixture(t, Buffer.from('{"answer":42}'));
  assert.deepEqual((await store.readVerifiedJSON(ref.handle, { maxBytes: 128 })).value, { answer: 42 });
  await assert.rejects(store.readVerifiedJSON(ref.handle, { maxBytes: 4 }), { code: 'INPUT_LIMIT' });
  await assert.rejects(store.readVerifiedJSON(ref.handle, { validateMeta() { throw new SolFault('REFERENCE_INVALID', 'wrong kind'); } }), { code: 'REFERENCE_INVALID' });
  const bad = await fixture(t, Buffer.from('{broken'));
  await assert.rejects(bad.store.readVerifiedJSON(bad.ref.handle), { code: 'CORRUPT' });
  const binary = await fixture(t, Buffer.from([255]));
  await assert.rejects(binary.store.readVerifiedJSON(binary.ref.handle), { code: 'UNSUPPORTED_ENCODING' });
});

test('five 16 MiB pages retain fixed-size buffers and read each raw only once per byte page', async (t) => {
  const { store, ref } = await fixture(t, Buffer.alloc(16 * 1024 * 1024, 120));
  let rawRead = 0;
  const handles = watchFiles(t, (file, name) => {
    if (name !== 'raw') return;
    const read = file.read.bind(file);
    file.read = async (...args) => { const result = await read(...args); rawRead += result.bytesRead; return result; };
  });
  const alloc = Buffer.alloc;
  const unsafe = Buffer.allocUnsafe;
  let maximum = 0;
  let allocated = 0;
  Buffer.alloc = (size, ...args) => { allocated += size; maximum = Math.max(maximum, size); return alloc(size, ...args); };
  Buffer.allocUnsafe = (size, ...args) => { allocated += size; maximum = Math.max(maximum, size); return unsafe(size, ...args); };
  t.after(() => { Buffer.alloc = alloc; Buffer.allocUnsafe = unsafe; });
  const selector = { kind: 'bytes', start: 0, end: ref.bytes };
  let cursor;
  let returned = 0;
  for (let i = 0; i < 5; i += 1) {
    const page = await recall(store, request(ref, selector, cursor));
    returned += page.chunks[0].end_byte - page.chunks[0].start_byte;
    cursor = page.next_cursor;
  }
  assert.ok(returned >= 5 * 4096 && returned <= 28000);
  assert.equal(rawRead, 5 * ref.bytes);
  assert.ok(maximum <= 65536, `largest buffer allocation: ${maximum}`);
  assert.ok(allocated < 5 * 256 * 1024, `total buffer allocation: ${allocated}`);
  t.diagnostic(`five pages: returned=${returned} raw_read=${rawRead} allocated=${allocated} max_buffer=${maximum}`);
  await closed(handles);
});

test('line pages use one full scan and dense keyword windows use two without retaining all matches', async (t) => {
  const { store, ref } = await fixture(t, Buffer.from('hit\nfar\nfar\n'.repeat(80000)));
  let rawRead = 0;
  const handles = watchFiles(t, (file, name) => {
    if (name !== 'raw') return;
    const read = file.read.bind(file);
    file.read = async (...args) => { const result = await read(...args); rawRead += result.bytesRead; return result; };
  });
  const line = await recall(store, request(ref, { kind: 'lines', start: 2, end: 2 }));
  assert.equal(line.chunks[0].text, 'far\n');
  assert.equal(rawRead, ref.bytes);
  rawRead = 0;
  const keyword = await recall(store, request(ref, { kind: 'keyword', literal: 'hit', context_lines: 0 }));
  assert.equal(keyword.chunks[0].text, 'hit\n');
  assert.equal(keyword.truncated, true);
  assert.equal(rawRead, 2 * ref.bytes);
  const next = await recall(store, request(ref, { kind: 'keyword', literal: 'hit', context_lines: 0 }, keyword.next_cursor));
  assert.equal(next.chunks[0].start_byte, 12);
  await closed(handles);
});

test('pack previews use candidate bytes from verification and close every real descriptor', async (t) => {
  const { store, ref, dir } = await fixture(t, Buffer.alloc(20000, 120));
  const handles = watchFiles(t, (file, name) => {
    if (name !== 'raw') return;
    const read = file.read.bind(file);
    file.read = async (...args) => {
      const result = await read(...args);
      if (!result.bytesRead) await writeFile(join(dir, 'raw'), Buffer.alloc(20000, 121));
      return result;
    };
  });
  const result = await pack(store, { schema_version: 1, call_id: 'test', tool: 'test', tool_status: 'ok', upstream_complete: true }, [ref]);
  assert.equal(result.mode, 'storage_error');
  assert.deepEqual(result.excerpts, []);
  await closed(handles);
});

test('inline file text preserves captured bytes when an upstream reuses its buffer', async (t) => {
  const { store, captureMeta } = await fixture(t, Buffer.alloc(0));
  const buffer = Buffer.from('first');
  const result = await readObservation(store, captureMeta, () => (async function* () {
    yield buffer;
    buffer.fill(120);
  }()));
  assert.equal(result.value.text, 'first');
  assert.equal((await store.readVerified(result.value.observation.raw[0].handle)).buffer.toString(), 'first');
});

// Reference uses whole strings only in this small fixture; production scans bytes.
function expectedKeyword(source, literal, context) {
  const lines = source.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const starts = [];
  let offset = 0;
  for (const line of lines) { starts.push(offset); offset += line.length; }
  const windows = [];
  for (let at = source.indexOf(literal); at !== -1; at = source.indexOf(literal, at + literal.length)) {
    const fromLine = starts.findLastIndex((start) => start <= at);
    const toLine = starts.findLastIndex((start) => start <= at + literal.length - 1);
    const from = Math.max(0, fromLine - context);
    const to = Math.min(lines.length - 1, toLine + context);
    const previous = windows.at(-1);
    if (previous && from <= previous[1] + 1) previous[1] = Math.max(previous[1], to);
    else windows.push([from, to]);
  }
  return windows.map(([from, to]) => lines.slice(from, to + 1).join('')).join('');
}

test('keyword streaming agrees with independent string windows over varied Unicode and newline literals', async (t) => {
  const source = Array.from({ length: 40 }, (_, i) => i % 4 === 0 ? '中🙂hit\r\n' : i % 7 === 0 ? '\n' : `row ${i}\n`).join('') + '中🙂tail';
  const { store, ref } = await fixture(t, Buffer.from(source));
  for (const literal of ['hit', '🙂', '\ud83d', '\ude42', '中🙂', '\n', '\r\n', 'hit\r\nrow', '\n中🙂', 'missing']) {
    for (const context of [0, 1, 2, 10]) {
      const result = await pages(store, ref, { kind: 'keyword', literal, context_lines: context });
      assert.equal(result.flatMap((page) => page.chunks.map((chunk) => chunk.text)).join(''), expectedKeyword(source, literal, context), JSON.stringify({ literal, context }));
    }
  }
});

test('BOM text remains byte-precise in lines, keywords, pack and inline reads', async (t) => {
  const source = '\ufefffirst\nsecond';
  const { store, ref, captureMeta } = await fixture(t, Buffer.from(source));
  const line = await recall(store, request(ref, { kind: 'lines', start: 1, end: 2 }));
  assert.equal(line.chunks[0].text, source);
  assert.equal(Buffer.byteLength(line.chunks[0].text), line.chunks[0].end_byte);
  const keyword = await recall(store, request(ref, { kind: 'keyword', literal: '\ufeff', context_lines: 0 }));
  assert.equal(keyword.chunks[0].text, '\ufefffirst\n');
  const packed = await pack(store, { schema_version: 1, call_id: 'test', tool: 'test', tool_status: 'ok', upstream_complete: true }, [ref]);
  for (const excerpt of packed.excerpts) assert.equal(Buffer.byteLength(excerpt.text), excerpt.end_byte - excerpt.start_byte);
  const inline = await readObservation(store, captureMeta, () => (async function* () { yield Buffer.from(source); }()));
  assert.equal(inline.value.text, source);
});

test('maximum-length keyword selectors still produce usable bounded cursors', async (t) => {
  const literal = 'x'.repeat(4096);
  const { store, ref } = await fixture(t, Buffer.from(literal.repeat(5)));
  const result = await pages(store, ref, { kind: 'keyword', literal, context_lines: 0 });
  assert.equal(result.flatMap((page) => page.chunks.map((chunk) => chunk.text)).join(''), literal.repeat(5));
});

test('close failure rejects success and preserves a primary collector failure', async (t) => {
  const { store, ref } = await fixture(t, Buffer.from('evidence'));
  const handles = watchFiles(t, (file, name) => {
    if (name !== 'raw') return;
    const close = file.close.bind(file);
    file.close = async () => { await close(); throw new Error('injected close error after actual release'); };
  });
  await assert.rejects(store.readVerified(ref.handle), { code: 'IO_ERROR' });
  await closed(handles.splice(0));
  await assert.rejects(store.withVerifiedRead(ref.handle, () => ({ onChunk() { throw new SolFault('PRIMARY_FAILURE', 'collector failed'); } })), { code: 'PRIMARY_FAILURE' });
  await closed(handles);
});

test('index replacements between line pages fail even when their SHA is replaced too', async (t) => {
  for (const updateMeta of [false, true]) {
    const { store, ref, dir } = await fixture(t, Buffer.from(`${'x'.repeat(10000)}\n${'y'.repeat(10000)}\nlast`));
    const selector = { kind: 'lines', start: 1, end: 3 };
    const page = await recall(store, request(ref, selector));
    const index = await readFile(join(dir, 'lines.idx'));
    index.writeBigUInt64LE(5000n, 8);
    await writeFile(join(dir, 'lines.idx'), index);
    if (updateMeta) {
      const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
      await writeFile(join(dir, 'meta.json'), JSON.stringify({ ...meta, index_sha256: digest(index) }));
    }
    await assert.rejects(recall(store, request(ref, selector, page.next_cursor)), { code: updateMeta ? 'INVALID_CURSOR' : 'CORRUPT' });
  }
});
