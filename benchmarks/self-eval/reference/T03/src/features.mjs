import { loadRecords } from './loader.mjs';
import { summarizeRecords } from './report.mjs';

export async function loadSummary(readText) {
  const records = await loadRecords(readText);
  return summarizeRecords(records);
}
