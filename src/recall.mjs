import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { assertContract } from './schema.mjs';
import { SolFault } from './store.mjs';

const MAX_RESULT_BYTES = 8192;
const PAGE_RAW_BYTES = 5600;
const cursorSecret = randomBytes(32);
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function fail(code, message) { throw new SolFault(code, message); }
function encodedBytes(value) { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
function signature(payload) { return createHmac('sha256', cursorSecret).update(payload).digest('base64url'); }
function makeCursor(binding, state) {
  const payload = Buffer.from(JSON.stringify({ ...binding, state })).toString('base64url');
  return `${payload}.${signature(payload)}`;
}
function parseCursor(cursor, binding) {
  const parts = cursor.split('.');
  if (parts.length !== 2 || parts[0].length > 8192) fail('INVALID_CURSOR', 'Cursor is invalid.');
  const expected = Buffer.from(signature(parts[0]));
  const actual = Buffer.from(parts[1]);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) fail('INVALID_CURSOR', 'Cursor is invalid.');
  let decoded;
  try { decoded = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); }
  catch { fail('INVALID_CURSOR', 'Cursor is invalid.'); }
  for (const key of ['workspace', 'handle', 'sha256', 'identity', 'selector']) {
    if (JSON.stringify(decoded[key]) !== JSON.stringify(binding[key])) fail('INVALID_CURSOR', 'Cursor belongs to a different observation or selector.');
  }
  if (!Number.isSafeInteger(decoded.state) || decoded.state < 0) fail('INVALID_CURSOR', 'Cursor offset is invalid.');
  return decoded.state;
}

function decodeText(buffer) {
  try { return utf8.decode(buffer); }
  catch { fail('UNSUPPORTED_ENCODING', 'Observation is not valid UTF-8 text.'); }
}

function resultBase(meta) {
  return { schema_version: 1, handle: meta.handle, sha256: meta.sha256, chunks: [], truncated: false, next_cursor: null };
}

function bindingFor(store, meta, selector) {
  return { workspace: store.workspaceId, handle: meta.handle, sha256: meta.sha256,
    identity: createHash('sha256').update(JSON.stringify(meta)).digest('hex'),
    selector: createHash('sha256').update(JSON.stringify(selector)).digest('base64url') };
}

function textValidator() {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  return (chunk, final = false) => {
    try { return decoder.decode(chunk, { stream: !final }); }
    catch { fail('UNSUPPORTED_ENCODING', 'Observation is not valid UTF-8 text.'); }
  };
}

// Retain a single page plus lookahead, never a complete line or observation.
function pageCollector(meta, range, text, cursor = null) {
  const candidate = Buffer.alloc(PAGE_RAW_BYTES + 4);
  const validate = text ? textValidator() : null;
  let length = 0;
  let line = 1;
  let firstLine = 1;
  const newlines = [];
  return {
    onChunk(chunk, position) {
      validate?.(chunk);
      if (range.kind === 'bytes') {
        const from = Math.max(range.start, position);
        const to = Math.min(range.end, range.start + candidate.length, position + chunk.length);
        if (to > from) { chunk.copy(candidate, from - range.start, from - position, to - position); length = Math.max(length, to - range.start); }
        if (!text) return;
      }
      for (let i = 0; i < chunk.length; i += 1) {
        const at = position + i;
        if (range.kind === 'lines') {
          if (range.start === null && line === range.fromLine) range.start = at;
          if (line > range.toLine && range.end === null) range.end = at;
          const start = cursor ?? range.start;
          if (start !== null && at >= start && (range.end === null || at < range.end)
            && at - start < candidate.length) { candidate[at - start] = chunk[i]; length = at - start + 1; }
        }
        const start = cursor ?? range.start;
        if (start !== null && at === start) firstLine = line;
        if (chunk[i] === 10) {
          if (start !== null && at >= start && at - start < candidate.length) newlines.push(at);
          line += 1;
        }
      }
    },
    finish() {
      validate?.(undefined, true);
      if (range.end === null) range.end = meta.bytes;
      if (cursor !== null && (cursor < range.start || cursor >= range.end)) fail('INVALID_CURSOR', 'Cursor is outside the requested range.');
      return { buffer: candidate.subarray(0, length), start: cursor ?? range.start, end: range.end, firstLine, newlines };
    },
  };
}

function renderPage(meta, selected, binding, text, nextStart = null) {
  const { buffer, start, end, firstLine, newlines } = selected;
  const result = resultBase(meta);
  if (start === end) return assertContract('RecallResult', result);
  let length = Math.min(end - start, PAGE_RAW_BYTES);
  while (length > 0) {
    if (text) {
      while (start + length < end && length > 0 && (buffer[length] & 0xc0) === 0x80) length -= 1;
      if (!length) fail('UNSUPPORTED_ENCODING', 'Could not find a UTF-8 page boundary.');
    }
    const chunk = { start_byte: start, end_byte: start + length };
    if (text) {
      chunk.text = decodeText(buffer.subarray(0, length));
      chunk.start_line = firstLine;
      chunk.end_line = firstLine + newlines.filter((at) => at < start + length - 1).length;
    } else chunk.base64 = buffer.subarray(0, length).toString('base64');
    result.chunks = [chunk];
    result.truncated = start + length < end || nextStart !== null;
    result.next_cursor = result.truncated ? makeCursor(binding, start + length < end ? start + length : nextStart) : null;
    if (encodedBytes(result) <= MAX_RESULT_BYTES) return assertContract('RecallResult', result);
    length -= 128;
  }
  fail('IO_ERROR', 'Could not fit a recall page into the response budget.');
}

function keywordCollector(meta, literal, context, cursor) {
  // Match JavaScript UTF-16 literal semantics, including a surrogate half.
  const pattern = new Uint16Array(literal.length);
  for (let i = 0; i < literal.length; i += 1) pattern[i] = literal.charCodeAt(i);
  const prefix = new Uint32Array(pattern.length);
  for (let i = 1, matched = 0; i < pattern.length; i += 1) {
    while (matched && pattern[i] !== pattern[matched]) matched = prefix[matched - 1];
    if (pattern[i] === pattern[matched]) matched += 1;
    prefix[i] = matched;
  }
  const literalLines = pattern.reduce((sum, byte) => sum + (byte === 10 ? 1 : 0), 0);
  // Only starts needed for a literal crossing lines and its preceding context.
  const ringSize = literalLines + context + 2;
  const starts = new Array(ringSize);
  starts[0] = 0;
  const validate = textValidator();
  let line = 1;
  let matched = 0;
  let bytePosition = 0;
  let pending = null;
  let selected = null;
  let nextStart = null;
  function seal() {
    if (!pending) return;
    if (!selected && (cursor === null || cursor >= pending.start && cursor < pending.end)) selected = { ...pending };
    else if (selected && nextStart === null) nextStart = pending.start;
    pending = null;
  }
  return {
    onChunk(chunk) {
      const text = validate(chunk);
      // Continue full UTF-8 validation even once current and next windows exist.
      if (nextStart !== null) return;
      for (let i = 0; i < text.length;) {
        const codepoint = text.codePointAt(i);
        const width = codepoint < 0x80 ? 1 : codepoint < 0x800 ? 2 : codepoint < 0x10000 ? 3 : 4;
        const units = codepoint > 0xffff ? 2 : 1;
        const at = bytePosition + width - 1;
        const byte = codepoint;
        for (let part = 0; part < units; part += 1) {
          const unit = text.charCodeAt(i + part);
          while (matched && unit !== pattern[matched]) matched = prefix[matched - 1];
          if (unit === pattern[matched]) matched += 1;
          if (matched === pattern.length) {
            const first = Math.max(1, line - literalLines + (byte === 10 ? 1 : 0));
            // A final LF belongs to the preceding line, not a phantom next line.
            const from = Math.max(1, first - context);
            const start = starts[(from - 1) % ringSize];
            const to = line + context;
            if (pending && from > pending.toLine + 1) seal();
            if (nextStart !== null) return;
            if (selected) { nextStart = start; return; }
            if (!pending) pending = { start, end: at + 1, toLine: to };
            else { pending.toLine = Math.max(pending.toLine, to); pending.end = at + 1; }
            // Match order agrees with String.indexOf(literal, found + literal.length).
            matched = 0;
          }
        }
        if (byte === 10) {
          if (pending && line <= pending.toLine) pending.end = at + 1;
          line += 1;
          starts[(line - 1) % ringSize] = at + 1;
        }
        bytePosition += width;
        i += units;
      }
    },
    finish() {
      validate(undefined, true);
      if (pending && pending.toLine >= line) pending.end = meta.bytes;
      seal();
      if (!selected && cursor !== null) fail('INVALID_CURSOR', 'Cursor is outside the requested range.');
      return { selected, nextStart };
    },
  };
}

/** Each page still fully hashes raw/index: O(N) I/O, keyword at most two scans. */
export async function recall(store, request, { signal } = {}) {
  try { assertContract('RecallRequest', request); }
  catch { fail('INVALID_RANGE', 'Recall request is invalid.'); }
  const selector = request.selector;
  let binding;
  let cursor;
  let range;
  const first = await store.withVerifiedRead(request.handle, (meta) => {
    binding = bindingFor(store, meta, selector);
    cursor = request.cursor ? parseCursor(request.cursor, binding) : null;
    if (selector.kind === 'keyword') return keywordCollector(meta, selector.literal, selector.context_lines ?? 2, cursor);
    if (selector.kind === 'bytes') {
      if (selector.start > selector.end || selector.end > meta.bytes) fail('INVALID_RANGE', `Byte range is outside the observation. Available byte offsets: 0..${meta.bytes} (end exclusive).`);
      const start = cursor ?? selector.start;
      if (start < selector.start || start >= selector.end && selector.start !== selector.end) fail('INVALID_CURSOR', 'Cursor is outside the requested range.');
      range = { kind: 'bytes', start, end: selector.end };
      return pageCollector(meta, range, false);
    }
    if (selector.start > selector.end || selector.end > meta.line_count) fail('INVALID_RANGE', meta.line_count ? `Line range is outside the observation. Available lines: 1..${meta.line_count} (inclusive); follow next_cursor for additional pages.` : 'Line range is outside the observation. Available lines: 0; use bytes 0..0 for an empty observation.');
    range = { kind: 'lines', start: null, end: null, fromLine: selector.start, toLine: selector.end };
    return pageCollector(meta, range, true, cursor);
  }, { signal });
  if (selector.kind !== 'keyword') return renderPage(first.meta, first.value, binding, selector.kind === 'lines');
  const { selected, nextStart } = first.value;
  if (!selected) return assertContract('RecallResult', resultBase(first.meta));
  const second = await store.withVerifiedRead(request.handle, (meta) => pageCollector(meta,
    { kind: 'bytes', start: cursor ?? selected.start, end: selected.end }, true), { signal, expectedMeta: first.meta });
  return renderPage(second.meta, second.value, binding, true, nextStart);
}
