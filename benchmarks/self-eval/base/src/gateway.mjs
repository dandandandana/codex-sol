import { normalizeRecord } from './records.mjs';

export function listRecords(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError('rows must be an array');
  }

  return rows.map(normalizeRecord).map((record) => record.name);
}
