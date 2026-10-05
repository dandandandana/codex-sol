import { normalizeRecord } from './records.mjs';

export async function processBatch(rows, { start = 0, signal, onRecord } = {}) {
  if (!Array.isArray(rows)) {
    throw new TypeError('rows must be an array');
  }
  if (!Number.isInteger(start)) {
    throw new TypeError('start must be an integer');
  }
  if (start < 0 || start > rows.length) {
    throw new RangeError('start must be between 0 and rows.length');
  }
  if (typeof onRecord !== 'function') {
    throw new TypeError('onRecord must be a function');
  }

  const processed = [];
  let index = start;
  while (index < rows.length) {
    if (signal?.aborted) {
      return { status: 'interrupted', nextIndex: index, processed };
    }

    const record = normalizeRecord(rows[index]);
    await onRecord(record, index);
    processed.push(record);
    index += 1;
  }

  return { status: 'completed', nextIndex: index, processed };
}
