import { normalizeRecord } from './records.mjs';
import { escapeHtml } from './html.mjs';

export function renderRows(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError('rows must be an array');
  }

  return '<ul>' + rows.map((row) => {
    const record = normalizeRecord(row);
    return '<li data-category="' + escapeHtml(record.category) + '">' +
      escapeHtml(record.name) +
      '</li>';
  }).join('') + '</ul>';
}
