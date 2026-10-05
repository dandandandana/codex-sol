import { listEntries } from './gateway.mjs';

export function readLabels(rows) {
  return listEntries(rows).map((entry) => entry.label);
}
