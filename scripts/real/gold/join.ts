// Gold script: the traceability join of one build — the defect ids of its release-note page against the defect
// ids of its indexed cases, computed with a plain double loop (no index structures; the independence of this
// script from the Hub is its whole value, so it imports nothing from hub/ or packs/). Ids compare as normalised:
// a pure ASCII digit run loses its leading zeros (the pack's ids.ts convention, re-implemented).
// Inputs: --defects <json>  [{ bug, status: fixed|known, module }]
//         --cases <json>   { documents: [{ document, cases: [{ id, title, defects: [...] }] }] }
//         (the shape of gold/cases.ts output, or a hand-trimmed variant of it)
//   node scripts/real/gold/join.ts --defects <defects.json> --cases <cases.json> --out <join.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function normalizeId(id: string): string {
  return /^[0-9]+$/.test(id) ? id.replace(/^0+/, '') || '0' : id;
}

interface DefectInput {
  bug: string;
  status: string;
  module: string;
}

interface CaseInput {
  document: string;
  id: string;
  title: string;
  defects: string[];
}

export interface JoinRow {
  /** The bug id as written in the release-note page. */
  bug: string;
  status: string;
  module: string;
  /** Every case naming this defect, in (document, id) order; empty when untraced. */
  cases: Array<{ document: string; id: string; title: string }>;
}

export interface JoinGold {
  rows: JoinRow[];
  traced: number;
  untraced: number;
}

export function joinGold(defects: ReadonlyArray<DefectInput>, cases: ReadonlyArray<CaseInput>): JoinGold {
  const rows: JoinRow[] = [];
  let traced = 0;
  let untraced = 0;
  for (const defect of defects) {
    const joined: Array<{ document: string; id: string; title: string }> = [];
    const key = normalizeId(defect.bug);
    for (const kase of cases) {
      let names = false;
      for (const id of kase.defects) {
        if (normalizeId(id) === key) {
          names = true;
          break;
        }
      }
      if (names) joined.push({ document: kase.document, id: kase.id, title: kase.title });
    }
    if (joined.length === 0) untraced += 1;
    else traced += 1;
    rows.push({ bug: defect.bug, status: defect.status, module: defect.module, cases: joined });
  }
  return { rows, traced, untraced };
}

export async function main(argv: string[]): Promise<number> {
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const defectsPath = value('defects');
  const casesPath = value('cases');
  const outPath = value('out');
  if (!defectsPath || !casesPath || !outPath) {
    process.stderr.write('用法：node scripts/real/gold/join.ts --defects <defects.json> --cases <cases.json> --out <join.json>\n');
    return 2;
  }
  let defects: DefectInput[];
  let cases: CaseInput[];
  try {
    const rawDefects: unknown = JSON.parse(readFileSync(resolve(defectsPath), 'utf8'));
    if (!Array.isArray(rawDefects)) throw new Error('缺陷不是列表');
    defects = rawDefects.map((row) => {
      if (row === null || typeof row !== 'object') throw new Error('缺陷行不是对象');
      const record = row as Record<string, unknown>;
      if (typeof record.bug !== 'string' || record.bug === '') throw new Error('缺陷行没有 bug 编号');
      return { bug: record.bug, status: typeof record.status === 'string' ? record.status : '', module: typeof record.module === 'string' ? record.module : '' };
    });
    const rawCases: unknown = JSON.parse(readFileSync(resolve(casesPath), 'utf8'));
    if (rawCases === null || typeof rawCases !== 'object' || !Array.isArray((rawCases as { documents?: unknown }).documents)) throw new Error('用例输入没有 documents');
    cases = [];
    for (const doc of (rawCases as { documents: unknown[] }).documents) {
      if (doc === null || typeof doc !== 'object') throw new Error('文档不是对象');
      const record = doc as Record<string, unknown>;
      const document = typeof record.document === 'string' ? record.document : '';
      for (const item of Array.isArray(record.cases) ? record.cases : []) {
        if (item === null || typeof item !== 'object') throw new Error('用例不是对象');
        const c = item as Record<string, unknown>;
        cases.push({
          document,
          id: typeof c.id === 'string' ? c.id : '',
          title: typeof c.title === 'string' ? c.title : '',
          defects: Array.isArray(c.defects) ? c.defects.filter((d): d is string => typeof d === 'string') : [],
        });
      }
    }
  } catch (error) {
    process.stderr.write(`读不了输入：${(error as Error).message.split('\n')[0]}\n`);
    return 1;
  }
  writeFileSync(outPath, `${JSON.stringify(joinGold(defects, cases), null, 2)}\n`);
  return 0;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('gold/join.ts')) {
  void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
