import { normalizeRecord } from './records.mjs';

export function listRecords(rows, options = {}) {
  if (!Array.isArray(rows)) {
    throw new TypeError('rows must be an array');
  }

  const hasCategory = Object.hasOwn(options, 'category');
  if (hasCategory && typeof options.category !== 'string') {
    throw new TypeError('category must be a string');
  }

  const category = hasCategory
    ? options.category.trim() || 'unknown'
    : undefined;

  return rows
    .map(normalizeRecord)
    .filter((record) => !hasCategory || record.category === category)
    .map((record) => record.name);
}
