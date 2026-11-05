// CSV export (semicolon-separated + BOM so Excel FR opens it correctly).

/** Neutralizes spreadsheet formula injection and escapes quotes. */
function cell(value) {
  if (value === null || value === undefined) return '';
  let s = Array.isArray(value) ? value.join(' | ') : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[";\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * @param {Array<object>} rows
 * @param {Array<{label: string, get: (row: object) => any}>} columns
 */
export function toCsv(rows, columns) {
  const lines = [columns.map((c) => cell(c.label)).join(';')];
  for (const row of rows) lines.push(columns.map((c) => cell(c.get(row))).join(';'));
  return '﻿' + lines.join('\r\n');
}

export function downloadText(filename, text, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
