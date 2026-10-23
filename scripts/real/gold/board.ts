// Independent board answer from mindmaps and agile tree originals. No Hub/pack runtime imports.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BoardGold, BoardGroupGold } from '../accept/quality-board.ts';
import { caseGold } from './cases.ts';
import { locationsGold, lineKey } from './locations.ts';
import { cleanDocId, loadCaseMaps, parseDocumentList } from './trace.ts';

export function boardGold(options: { product: string; build: string; tree: unknown; maps: Array<{ document: string; map: unknown }>; caseRule?: 'marked' | 'tagged' }): BoardGold & { documents: { count: number; not_in_tree: number; no_cases: number } } {
  const locations = locationsGold(options.tree).all ?? [];
  const groups = new Map<string, BoardGroupGold>();
  let notInTree = 0, noCases = 0;
  for (const map of options.maps) {
    const location = locations.find((l) => cleanDocId(l.document) === cleanDocId(map.document));
    if (!location) notInTree++;
    let doc;
    try { doc = caseGold([map], { caseRule: options.caseRule }).documents[0]; }
    catch (error) { if (error instanceof Error && error.message.includes('的用例节点')) { noCases++; continue; } throw error; }
    const label = `${location?.line ? lineKey(location.line) : 'unplaced'}/${location?.module || 'unplaced'}`;
    const held = groups.get(label) ?? { label, cases: 0, missing: 0, vague: 0, negative: 0 };
    for (const c of doc.items) {
      held.cases++;
      if (!c.hasExpected) held.missing++;
      if (c.vagueExpected) held.vague++;
      if (c.negative) held.negative++;
    }
    groups.set(label, held);
  }
  const sorted = [...groups.values()].sort((a, b) => a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
  return { product: options.product, build: options.build, groups: sorted, totals: sorted.reduce((sum, g) => ({ cases: sum.cases + g.cases, missing: sum.missing + g.missing, vague: sum.vague + g.vague, negative: sum.negative + g.negative }), { cases: 0, missing: 0, vague: 0, negative: 0 }), documents: { count: options.maps.length, not_in_tree: notInTree, no_cases: noCases } };
}
export function main(argv: string[], print = (line: string) => process.stdout.write(`${line}\n`)): number {
  const value = (key: string) => { const i = argv.indexOf(`--${key}`); return i < 0 ? undefined : argv[i + 1]; };
  const tree = value('tree'), cases = value('cases-dir'), docs = value('docs'), product = value('product'), build = value('build'), out = value('out');
  if (!tree || !cases || !docs || !product || !build || !out) return 2;
  try {
    const gold = boardGold({ product, build, tree: JSON.parse(readFileSync(tree, 'utf8')), maps: loadCaseMaps(cases, parseDocumentList(readFileSync(docs, 'utf8'))), caseRule: value('case-rule') === 'tagged' ? 'tagged' : 'marked' });
    writeFileSync(out, `${JSON.stringify(gold, null, 2)}\n`);
    print(`文档 ${gold.documents.count} 份，其中不在树里 ${gold.documents.not_in_tree} 份，没有用例 ${gold.documents.no_cases} 份`);
    print(`分组 ${gold.groups!.length} 组；用例 ${gold.totals!.cases}；无期望 ${gold.totals!.missing}；含糊 ${gold.totals!.vague}；负面 ${gold.totals!.negative}`);
    print(`分组表 SHA-256 ${createHash('sha256').update(JSON.stringify(gold.groups)).digest('hex').slice(0, 12)}`);
    return 0;
  } catch { process.stderr.write('生成看板独立答案失败：检查原始文件与文档清单\n'); return 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
