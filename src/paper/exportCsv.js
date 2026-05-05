// Tiny CSV writer + browser download helper. No external deps.
//
// Usage:
//   downloadCsv(`paper-trades-${nickname}.csv`, [
//     { id: 't1', stake: 10, pnl: -5 },
//     ...
//   ]);

function escapeCell(v) {
  if (v == null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function rowsToCsv(rows) {
  if (!rows || rows.length === 0) return '';
  const headers = Array.from(
    rows.reduce((set, r) => {
      Object.keys(r).forEach((k) => set.add(k));
      return set;
    }, new Set())
  );
  const headerLine = headers.map(escapeCell).join(',');
  const body = rows.map((r) => headers.map((h) => escapeCell(r[h])).join(',')).join('\n');
  return `${headerLine}\n${body}`;
}

export function downloadCsv(filename, rows) {
  const csv = rowsToCsv(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}
