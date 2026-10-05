import { normalizeRecord } from './records.mjs';

export function summarizeRecords(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError('rows must be an array');
  }

  let total = 0;
  for (const row of rows) {
    total += normalizeRecord(row).amount;
  }

  return { count: rows.length, total };
}
