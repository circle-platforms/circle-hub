// An engine cursor is only a candidate. Every emitted text@1 range is read back from supplied original lines.
import { sourceLines } from './input.ts';
import type { AdocInput, MappedLine, VerifiedRange } from './types.ts';

export function ranges(rows: MappedLine[], input: AdocInput, originals?: Map<string, string[]>): VerifiedRange[] {
  const out: VerifiedRange[] = [];
  for (const row of rows) {
    const last = out.at(-1);
    if (last && last.file === row.file && last.to + 1 === row.line) {
      last.to = row.line; last.verbatim += '\n' + row.text;
    } else out.push({ file: row.file, from: row.line, to: row.line, selector: '', reference: '', verbatim: row.text });
  }
  for (const range of out) {
    range.selector = `l/${range.from === range.to ? range.from : `${range.from}-${range.to}`}`;
    const original = (originals?.get(range.file) ?? sourceLines(range.file, input.files[range.file].text).map((row) => row.text)).slice(range.from - 1, range.to);
    if (original.length !== range.to - range.from + 1 || original.join('\n') !== range.verbatim) return [];
    range.reference = `src:${input.files[range.file].sha256}/text@1/${range.selector}`;
  }
  return out;
}

export function verifyOrigin(raw: string, kind: string, reported: number | undefined, mapped: MappedLine[], visible: Set<number>, input: AdocInput, originals?: Map<string, string[]>): { origins: VerifiedRange[]; flat: number | null; reason: string } {
  if (raw === '' || !Number.isInteger(reported) || reported! < 1) return { origins: [], flat: null, reason: '引擎没有可逐字回核的内容或行号' };
  const expected = raw.split('\n');
  const candidates: Array<{ rows: MappedLine[]; flat: number }> = [];
  // Fixed, narrow recovery for the observed delimiter/conditional cursor offsets. No whole-document fuzzy search.
  for (let at = Math.max(0, reported! - 3); at <= Math.min(mapped.length - 1, reported! + 1); at++) {
    if (!visible.has(at)) continue;
    const rows: MappedLine[] = [];
    let cursor = at;
    for (const line of expected) {
      while (cursor < mapped.length && !visible.has(cursor)) cursor++;
      if (cursor >= mapped.length) break;
      const actual = mapped[cursor];
      const matches = kind === 'section' ? /^={1,6} +/.test(actual.text) && actual.text.replace(/^={1,6} +/, '') === line
        : kind === 'table_cell' ? actual.text.split(/(?<!\\)\|/).some((cell) => cell.trim() === line)
        : kind === 'list_item' ? actual.text.replace(/^\s*(?:\*+|[-.]|[0-9]+[.)]) +/, '') === line : actual.text === line;
      if (!matches) break;
      rows.push(actual); cursor++;
    }
    if (rows.length === expected.length) candidates.push({ rows, flat: at + 1 });
  }
  if (candidates.length !== 1) return { origins: [], flat: null, reason: candidates.length ? '候选行不唯一，不能把相同文字硬归到某一行' : 'sourcemap 附近没有逐字相符的原文' };
  const chosen = candidates[0];
  const origins = ranges(chosen.rows, input, originals);
  return { origins, flat: origins.length ? chosen.flat : null, reason: origins.length ? '' : '候选映射与重新读取的原件行不符' };
}
