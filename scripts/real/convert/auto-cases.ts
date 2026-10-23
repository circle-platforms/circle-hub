import { readFileSync } from 'node:fs';
import { kityminderParser } from '../../../hub/refs/parsers/kityminder.ts';
import { extractCases, type CaseRule } from '../../../packs/workflow/case-compile/functions/cases.ts';
import { argumentsOf, jsonBytes, main, output, requireFact, summary } from './io.ts';
export function autoCases(bytes: Uint8Array, rule: CaseRule = 'marked'): string[] {
  const parsed = kityminderParser.parse(bytes); const extracted = extractCases(parsed.model, rule);
  const selected = extracted.cases.filter((v) => v.auto === 'YES');
  requireFact(selected.length === 5, `找到 ${selected.length} 个 auto 正好为 YES 的用例，需要 5 个；集成者核对原脑图和 case_rule 后重跑，不补选`);
  requireFact(selected.every((v) => v.autoid !== null && v.autoid.trim() !== '' && !extracted.impreciseAutoids.some((problem) => problem.node === v.id)), '所选用例缺少精确 autoid；集成者从源文档补取文字编号后重跑');
  const ids = selected.map((v) => v.autoid!);
  requireFact(new Set(ids).size === ids.length, '所选用例 autoid 重复；核对源文档身份后重跑'); return ids;
}
export function run(args: string[]): void {
  const { files, options } = argumentsOf(args, 1, ['--out', '--case-rule']); const rule = options['--case-rule'] ?? 'marked';
  requireFact(rule === 'marked' || rule === 'tagged', 'case_rule 必须与计划运行相同，使用 marked 或 tagged');
  const bytes = readFileSync(files[0]!); const ids = autoCases(bytes, rule);
  output(options['--out'] ?? '', 'auto-cases.json', jsonBytes({ case_rule: rule, autoids: ids })); summary(ids.length, bytes);
}
main(import.meta.url, run);
