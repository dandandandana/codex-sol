import { listRecords } from './gateway.mjs';

export function readLabels(rows) {
  return listRecords(rows);
}
