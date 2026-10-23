import { readFileSync } from 'node:fs';
import { kityminderParser } from '../../../hub/refs/parsers/kityminder.ts';
import { extractCases, type CaseRule } from '../../../packs/workflow/case-compile/functions/cases.ts';
import { argumentsOf, jsonBytes, main, output, record, readJson, requireFact, summary } from './io.ts';
export function autoCases(bytes: Uint8Array, rule: CaseRule = 'marked', profile?: unknown): string[] {
  const parsed = kityminderParser.parse(bytes); const extracted = extractCases(parsed.model, rule);
  requireFact(extracted.impreciseAutoids.length === 0, '文档含有精度不确定的数值 autoid；集成者从原脑图以文本重导出全部编号，再按相同 case_rule 重跑，不能使用已舍入值');
  const selected = extracted.cases.filter((v) => v.auto === 'YES');
  requireFact(selected.length === 5, `找到 ${selected.length} 个 auto 正好为 YES 的用例，需要 5 个；集成者核对原脑图和 case_rule 后重跑，不补选`);
  requireFact(selected.every((v) => v.autoid !== null && v.autoid.trim() !== '' && !extracted.impreciseAutoids.some((problem) => problem.node === v.id)), '所选用例缺少精确 autoid；集成者从源文档补取文字编号后重跑');
  const ids = selected.map((v) => v.autoid!);
  requireFact(ids.every(id => extracted.cases.filter(value => value.autoid === id).length === 1), '所选 autoid 与文档中其他用例重复；集成者修正原件重复身份，按相同 case_rule 重跑');
  if (profile !== undefined) {
    requireFact(record(profile) && profile.schema === 'runtime-profile@1' && record(profile.workbook) && typeof profile.workbook.autoid_pattern === 'string', '缺少 workbook/autoid_pattern；--profile 必须指向计划运行绑定的完整运行环境配置');
    const pattern = profile.workbook.autoid_pattern; let regex: RegExp;
    try { requireFact(pattern.startsWith('^') && pattern.endsWith('$') && pattern.length <= 200 && !/[\r\n]/.test(pattern), 'autoid_pattern 不合式；集成者修正 --profile 的有首尾锚点表达式后重跑'); regex = new RegExp(pattern, 'u'); } catch { requireFact(false, 'autoid_pattern 不合式；集成者修正 --profile 的有首尾锚点表达式后重跑'); }
    requireFact(ids.every(id => regex.test(id)), '所选编号不符合 autoid_pattern；集成者核对原始文字编号与 --profile，使用计划运行的同一份配置重跑，不猜或修改编号');
  }
  return ids;
}
export function run(args: string[]): void {
  const { files, options } = argumentsOf(args, 1, ['--out', '--case-rule', '--profile']); const rule = options['--case-rule'] ?? 'marked';
  requireFact(rule === 'marked' || rule === 'tagged', 'case_rule 必须与计划运行相同，使用 marked 或 tagged');
  const bytes = readFileSync(files[0]!); const ids = autoCases(bytes, rule, options['--profile'] ? readJson(options['--profile']) : undefined);
  output(options['--out'] ?? '', 'auto-cases.json', jsonBytes({ case_rule: rule, autoids: ids })); summary(ids.length, bytes);
}
main(import.meta.url, run);
