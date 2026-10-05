import { normalizeRecord } from './records.mjs';

export async function loadRecords(readText) {
  if (typeof readText !== 'function') {
    throw new TypeError('readText must be a function');
  }

  const text = await readText();
  const value = JSON.parse(text);
  if (!Array.isArray(value)) {
    throw new TypeError('JSON value must be an array');
  }

  return value.map(normalizeRecord);
}
