import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { assertContract } from './schema.mjs';
import { SolFault } from './store.mjs';

const MAX_RESULT_BYTES = 8192;
const PAGE_RAW_BYTES = 5600;
const cursorSecret = randomBytes(32);
const utf8 = new TextDecoder('utf-8', { fatal: true });

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
  for (const key of ['workspace', 'handle', 'sha256', 'selector']) {
    if (JSON.stringify(decoded[key]) !== JSON.stringify(binding[key])) fail('INVALID_CURSOR', 'Cursor belongs to a different observation or selector.');
  }
  if (!Number.isSafeInteger(decoded.state) || decoded.state < 0) fail('INVALID_CURSOR', 'Cursor offset is invalid.');
  return decoded.state;
}

function decodeText(buffer) {
  try { return utf8.decode(buffer); }
  catch { fail('UNSUPPORTED_ENCODING', 'Observation is not valid UTF-8 text.'); }
}

function lineSpans(buffer) {
  const spans = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 10) { spans.push([start, i + 1]); start = i + 1; }
  }
  if (start < buffer.length) spans.push([start, buffer.length]);
  return spans;
}

function resultBase(meta) {
  return { schema_version: 1, handle: meta.handle, sha256: meta.sha256, chunks: [], truncated: false, next_cursor: null };
}

function pageBytes(buffer, meta, start, end, binding) {
  if (start > end || end > buffer.length) fail('INVALID_RANGE', 'Byte range is outside the observation.');
  const result = resultBase(meta);
  if (start === end) return result;
  let pageEnd = Math.min(end, start + PAGE_RAW_BYTES);
  while (pageEnd > start) {
    result.chunks = [{ start_byte: start, end_byte: pageEnd, base64: buffer.subarray(start, pageEnd).toString('base64') }];
    result.truncated = pageEnd < end;
    result.next_cursor = result.truncated ? makeCursor(binding, pageEnd) : null;
    if (encodedBytes(result) <= MAX_RESULT_BYTES) return assertContract('RecallResult', result);
    pageEnd -= 128;
  }
  fail('IO_ERROR', 'Could not fit a byte page into the response budget.');
}

function pageText(buffer, meta, start, end, binding, spans) {
  const result = resultBase(meta);
  if (start === end) return result;
  let pageEnd = Math.min(end, start + PAGE_RAW_BYTES);
  while (pageEnd > start) {
    // Back up to a UTF-8 codepoint boundary. CRLF and all other bytes are retained.
    while (pageEnd < end && pageEnd > start && (buffer[pageEnd] & 0xc0) === 0x80) pageEnd -= 1;
    if (pageEnd <= start) fail('UNSUPPORTED_ENCODING', 'Could not find a UTF-8 page boundary.');
    const text = decodeText(buffer.subarray(start, pageEnd));
    const chunk = { start_byte: start, end_byte: pageEnd, text };
    if (spans) {
      const first = spans.findIndex((span) => span[1] > start);
      const last = spans.findLastIndex((span) => span[0] < pageEnd);
      if (first >= 0) chunk.start_line = first + 1;
      if (last >= 0) chunk.end_line = last + 1;
    }
    result.chunks = [chunk];
    result.truncated = pageEnd < end;
    result.next_cursor = result.truncated ? makeCursor(binding, pageEnd) : null;
    if (encodedBytes(result) <= MAX_RESULT_BYTES) return assertContract('RecallResult', result);
    pageEnd = Math.max(start + 1, pageEnd - 128);
  }
  fail('IO_ERROR', 'Could not fit a text page into the response budget.');
}

function keywordWindows(buffer, literal, contextLines) {
  const text = decodeText(buffer);
  const spans = lineSpans(buffer);
  const charStarts = [];
  let charOffset = 0;
  for (const [start, end] of spans) {
    charStarts.push(charOffset);
    charOffset += decodeText(buffer.subarray(start, end)).length;
  }
  const windows = [];
  let found = text.indexOf(literal);
  while (found !== -1) {
    let line = 0;
    while (line + 1 < charStarts.length && charStarts[line + 1] <= found) line += 1;
    const matchEnd = found + literal.length - 1;
    let endLine = line;
    while (endLine + 1 < charStarts.length && charStarts[endLine + 1] <= matchEnd) endLine += 1;
    const from = Math.max(0, line - contextLines);
    const to = Math.min(spans.length - 1, endLine + contextLines);
    const window = [spans[from][0], spans[to][1]];
    const previous = windows.at(-1);
    if (previous && window[0] <= previous[1]) previous[1] = Math.max(previous[1], window[1]);
    else windows.push(window);
    found = text.indexOf(literal, found + Math.max(1, literal.length));
  }
  return { windows, spans };
}

/** Exact, bounded recall. Cursor state is a byte offset within the selected windows. */
export async function recall(store, request) {
  try { assertContract('RecallRequest', request); }
  catch { fail('INVALID_RANGE', 'Recall request is invalid.'); }
  const { meta, buffer } = await store.readVerified(request.handle);
  const selector = request.selector;
  const binding = { workspace: store.workspaceId, handle: meta.handle, sha256: meta.sha256, selector };
  const cursorPosition = request.cursor ? parseCursor(request.cursor, binding) : null;
  if (selector.kind === 'bytes') {
    if (selector.start > selector.end || selector.end > buffer.length) fail('INVALID_RANGE', 'Byte range is outside the observation.');
    const start = cursorPosition ?? selector.start;
    if (start < selector.start || start >= selector.end && selector.start !== selector.end) fail('INVALID_CURSOR', 'Cursor is outside the requested range.');
    return pageBytes(buffer, meta, start, selector.end, binding);
  }
  const spans = lineSpans(buffer);
  // Decode the whole observation so an invalid sequence outside the current page cannot hide.
  decodeText(buffer);
  let windows;
  if (selector.kind === 'lines') {
    if (selector.start > selector.end || selector.end > spans.length) fail('INVALID_RANGE', 'Line range is outside the observation.');
    windows = [[spans[selector.start - 1][0], spans[selector.end - 1][1]]];
  } else {
    windows = keywordWindows(buffer, selector.literal, selector.context_lines ?? 2).windows;
  }
  if (windows.length === 0) {
    if (cursorPosition !== null) fail('INVALID_CURSOR', 'Cursor has no matching window.');
    return assertContract('RecallResult', resultBase(meta));
  }
  let selected = windows[0];
  let start = cursorPosition ?? selected[0];
  if (cursorPosition !== null) {
    selected = windows.find(([from, to]) => start >= from && start < to);
    if (!selected) fail('INVALID_CURSOR', 'Cursor is outside the requested range.');
  }
  const page = pageText(buffer, meta, start, selected[1], binding, spans);
  if (!page.truncated) {
    const next = windows.find(([from]) => from >= selected[1]);
    if (next) {
      page.truncated = true;
      page.next_cursor = makeCursor(binding, next[0]);
    }
  }
  if (encodedBytes(page) > MAX_RESULT_BYTES) fail('IO_ERROR', 'Recall page exceeds the response budget.');
  return assertContract('RecallResult', page);
}
