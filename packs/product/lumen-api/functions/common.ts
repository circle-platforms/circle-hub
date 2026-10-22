// Helpers of the Lumen API product functions (pure, no imports at run time).

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** Cells of a Markdown table block: one array per data row (the header and the separator row left out). */
export function tableRows(text: string): string[][] {
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('|'));
  const rows = lines.map((line) => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()));
  return rows.filter((row, i) => i > 0 && !row.every((cell) => /^:?-{3,}:?$/.test(cell)));
}

/** A version line of a release version: its first two numbers (2.1.0 -> 2.1). */
export function lineOf(version: string): string | null {
  const m = /^([0-9]{1,3})\.([0-9]{1,3})(?:\.[0-9]{1,3})?$/.exec(version);
  return m === null ? null : `${Number(m[1])}.${Number(m[2])}`;
}

/** ISO 8601 UTC of a listed time (`YYYY-MM-DD HH:MM:SS` or `YYYY-MM-DD`), or null. */
export function isoTime(text: string): string | null {
  const t = text.trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t)) return `${t.replace(' ', 'T')}Z`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return `${t}T00:00:00Z`;
  return null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const pb = b.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}
