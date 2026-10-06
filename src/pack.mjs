import { TextDecoder } from 'node:util';
import { assertContract } from './schema.mjs';

const INLINE_BYTES = 8 * 1024;
const PACK_BYTES = 4 * 1024;
const PREVIEW_BYTES = 8 * 1024;
const UTF8_WINDOW = 8 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function safeErrorReason(error) {
  const message = error instanceof Error ? error.message : String(error);
  const oneLine = message.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim();
  return oneLine ? oneLine.slice(0, 256) : 'unknown storage failure';
}

function declaredBytes(refs) {
  return refs.reduce((sum, ref) => {
    if (!Number.isSafeInteger(ref.bytes)) throw new TypeError('RawRef bytes must be a safe integer.');
    const next = sum + ref.bytes;
    if (!Number.isSafeInteger(next)) throw new RangeError('RawRef byte total exceeds the supported integer range.');
    return next;
  }, 0);
}

function decodePrefix(buffer, absoluteStart, limit) {
  let end = Math.min(limit, buffer.length);
  for (let trim = 0; trim <= 3 && end - trim >= 0; trim += 1) {
    const candidate = buffer.subarray(0, end - trim);
    try {
      const text = decoder.decode(candidate);
      if (candidate.length === 0) return null;
      return { start_byte: absoluteStart, end_byte: absoluteStart + candidate.length, text };
    } catch {
      // A UTF-8 code point may be split at the requested byte boundary.
    }
  }
  return null;
}

function decodeSuffix(buffer, absoluteStart, limit) {
  let start = Math.max(0, buffer.length - limit);
  for (let trim = 0; trim <= 3 && start + trim <= buffer.length; trim += 1) {
    const candidate = buffer.subarray(start + trim);
    try {
      const text = decoder.decode(candidate);
      if (candidate.length === 0) return null;
      return { start_byte: absoluteStart + start + trim, end_byte: absoluteStart + buffer.length, text };
    } catch {
      // A UTF-8 code point may be split at the beginning of the suffix window.
    }
  }
  return null;
}

function fullText(buffer) {
  if (buffer.length === 0) return '';
  try {
    return decoder.decode(buffer);
  } catch {
    return null;
  }
}

function excerptBytes(excerpt) {
  return excerpt.end_byte - excerpt.start_byte;
}

function makeItem(ref, opened, head, tail, full) {
  return {
    ref,
    bytes: opened.meta.bytes,
    head,
    tail,
    full,
  };
}

function previewForItem(item, budget) {
  if (budget <= 0 || item.bytes === 0) return [];

  if (item.bytes <= budget && item.full !== null) {
    return [{ handle: item.ref.handle, start_byte: 0, end_byte: item.bytes, text: item.full }];
  }

  if (item.bytes <= budget) return [];

  const headBudget = Math.floor(budget / 2);
  const tailBudget = budget - headBudget;
  const excerpts = [];
  const head = item.head && decodePrefix(item.head.buffer, item.head.start, headBudget);
  const tail = item.tail && decodeSuffix(item.tail.buffer, item.tail.start, tailBudget);
  if (head) excerpts.push({ handle: item.ref.handle, ...head });
  if (tail && (!head || tail.start_byte >= head.end_byte)) {
    excerpts.push({ handle: item.ref.handle, ...tail });
  }
  return excerpts;
}

function buildExcerpts(items, budget) {
  if (budget <= 0 || items.length === 0) return [];
  const total = items.reduce((sum, item) => sum + item.bytes, 0);
  if (total === 0) return [];

  const excerpts = [];
  let allocated = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const remainingBudget = budget - allocated;
    const quota = index === items.length - 1
      ? remainingBudget
      : Math.min(item.bytes, Math.floor((budget * item.bytes) / total));
    const itemExcerpts = previewForItem(item, Math.max(0, quota));
    excerpts.push(...itemExcerpts);
    allocated += itemExcerpts.reduce((sum, excerpt) => sum + excerptBytes(excerpt), 0);
  }
  return excerpts;
}

function normalizeExcerpt(excerpt) {
  return {
    handle: excerpt.handle,
    start_byte: excerpt.start_byte,
    end_byte: excerpt.end_byte,
    text: excerpt.text,
  };
}

function packShape(meta, refs, mode, summary, excerpts, omittedBytes, reason) {
  return {
    schema_version: 1,
    call_id: meta.call_id,
    tool: meta.tool,
    tool_status: meta.tool_status,
    mode,
    raw: refs,
    summary,
    excerpts: excerpts.map(normalizeExcerpt),
    omitted_bytes: omittedBytes,
    reason,
  };
}

function summaryFor(meta, mode, bytes, complete, omittedBytes) {
  const completeValue = complete === null ? 'unknown' : String(complete);
  return [
    `tool_status=${meta.tool_status}`,
    `upstream_complete=${meta.upstream_complete}`,
    `mode=${mode}`,
    `raw_bytes=${bytes}`,
    `raw_complete=${completeValue}`,
    `omitted_bytes=${omittedBytes}`,
  ].join('; ');
}

function reasonFor(meta, mode) {
  if (mode === 'storage_error') return 'storage_error';
  if (meta.tool_status !== 'ok') return `upstream_${meta.tool_status}`;
  if (!meta.upstream_complete) return 'upstream_incomplete';
  return mode === 'inline' ? 'inline_preview' : 'packed_preview';
}

function fitPack(meta, refs, mode, items, totalBytes, complete, maxBytes) {
  const build = (excerpts) => {
    const represented = excerpts.reduce((sum, excerpt) => sum + excerptBytes(excerpt), 0);
    const omitted = totalBytes - represented;
    const summary = summaryFor(meta, mode, totalBytes, complete, omitted);
    const reason = reasonFor(meta, mode);
    return packShape(meta, refs, mode, summary, excerpts, omitted, reason);
  };

  let best = build([]);
  if (jsonBytes(best) > maxBytes) {
    throw new RangeError('ObservationPack metadata exceeds the UTF-8 response budget.');
  }

  if (items.length === 0) {
    return best;
  }

  let low = 0;
  let high = Math.min(PREVIEW_BYTES, totalBytes);
  while (low <= high) {
    const candidateBudget = Math.floor((low + high) / 2);
    const candidate = build(buildExcerpts(items, candidateBudget));
    if (jsonBytes(candidate) <= maxBytes) {
      best = candidate;
      low = candidateBudget + 1;
    } else {
      high = candidateBudget - 1;
    }
  }
  return best;
}

async function openItems(store, refs, signal) {
  const items = [];
  for (const ref of refs) {
    const { value } = await store.withVerifiedRead(ref.handle, (meta) => {
      if (meta.bytes !== ref.bytes || meta.sha256 !== ref.sha256 || meta.media_type !== ref.media_type || meta.complete !== ref.complete) {
        throw new TypeError(`Observation ${ref.handle} does not match its RawRef.`);
      }
      const bytes = meta.bytes;
      const headBuffer = Buffer.alloc(Math.min(bytes, UTF8_WINDOW));
      const tailStart = Math.max(0, bytes - UTF8_WINDOW);
      const tailBuffer = tailStart === 0 ? headBuffer : Buffer.alloc(UTF8_WINDOW);
      const retain = (target, start, chunk, position) => {
        const from = Math.max(start, position);
        const to = Math.min(start + target.length, position + chunk.length);
        if (to > from) chunk.copy(target, from - start, from - position, to - position);
      };
      return {
        onChunk(chunk, position) {
          retain(headBuffer, 0, chunk, position);
          if (tailStart) retain(tailBuffer, tailStart, chunk, position);
        },
        finish() {
          return makeItem(ref, { meta }, { buffer: headBuffer, start: 0 },
            { buffer: tailBuffer, start: tailStart }, bytes <= UTF8_WINDOW ? fullText(headBuffer) : null);
        },
      };
    }, { signal });
    items.push(value);
  }
  return items;
}

/** No handle is published until commit; the byte count here is received input. */
export function storageErrorPack(meta, { refs = [], receivedBytes = 0, mayHaveExecuted = false } = {}) {
  assertContract('PackMeta', meta);
  refs.forEach((ref) => assertContract('RawRef', ref));
  if (!Number.isSafeInteger(receivedBytes) || receivedBytes < 0) throw new TypeError('Received byte count must be a nonnegative safe integer.');
  const result = packShape(meta, refs, 'storage_error',
    `${summaryFor(meta, 'storage_error', declaredBytes(refs), null, receivedBytes)}; received_bytes=${receivedBytes}; tool_may_have_executed=${mayHaveExecuted}`,
    [], receivedBytes, 'storage_error');
  if (jsonBytes(result) > PACK_BYTES) throw new RangeError('ObservationPack exceeds the 4096-byte UTF-8 budget.');
  return assertContract('ObservationPack', result);
}

/**
 * Build a deterministic, model-visible observation envelope from verified refs.
 * This function only reads the store; it never summarizes through a model or writes data.
 */
export async function pack(store, meta, refs, { maxBytes = PACK_BYTES, signal } = {}) {
  assertContract('PackMeta', meta);
  if (!Array.isArray(refs)) throw new TypeError('Observation refs must be an array.');
  refs.forEach((ref) => assertContract('RawRef', ref));
  if (!store || typeof store.withVerifiedRead !== 'function') throw new TypeError('Observation store must provide withVerifiedRead().');
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > PACK_BYTES) throw new RangeError('Observation response budget must be between 1 and 4096 bytes.');

  const declaredTotal = declaredBytes(refs);
  let items;
  try {
    items = await openItems(store, refs, signal);
  } catch (error) {
    const mode = 'storage_error';
    const summary = summaryFor(meta, mode, declaredTotal, null, declaredTotal);
    const result = packShape(meta, refs, mode, summary, [], declaredTotal, 'storage_error');
    if (jsonBytes(result) > maxBytes) {
      throw new RangeError(`ObservationPack metadata exceeds the 4096-byte UTF-8 budget after storage failure: ${safeErrorReason(error)}`);
    }
    return assertContract('ObservationPack', result);
  }

  const totalBytes = items.reduce((sum, item) => sum + item.bytes, 0);
  const complete = items.every((item) => item.ref.complete);
  const mode = totalBytes <= INLINE_BYTES ? 'inline' : 'packed';
  const result = fitPack(meta, refs, mode, items, totalBytes, complete, maxBytes);
  if (jsonBytes(result) > maxBytes) throw new RangeError('ObservationPack exceeds the UTF-8 response budget.');
  return assertContract('ObservationPack', result);
}

export default pack;
