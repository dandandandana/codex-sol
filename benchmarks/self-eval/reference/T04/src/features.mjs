import { withRetry } from './retry.mjs';
import { loadRecords } from './loader.mjs';
import { summarizeRecords } from './report.mjs';

export async function fetchSummary(fetchText, options = {}) {
  const text = await withRetry(() => fetchText(), options);
  const records = await loadRecords(() => text);
  return summarizeRecords(records);
}
