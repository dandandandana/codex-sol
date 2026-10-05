import { normalizeRecord } from './records.mjs';
import { summarizeRecords } from './report.mjs';

export function summarizeByCategory(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError('rows must be an array');
  }

  const groups = new Map();
  for (const row of rows) {
    const record = normalizeRecord(row);
    const group = groups.get(record.category);
    if (group) {
      group.push(record);
    } else {
      groups.set(record.category, [record]);
    }
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, records]) => ({
      category,
      ...summarizeRecords(records)
    }));
}
