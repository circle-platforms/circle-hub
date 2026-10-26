import { readFileSync } from 'node:fs';
import { normalizeMindmap } from '../../../packs/workflow/case-compile/tools/normalize-mindmap.ts';
import { kityminderParser, ParseError, ParseLimitError } from '../../../hub/refs/api.ts';
import { extractCases, type CaseRule } from '../../../packs/workflow/case-compile/functions/cases.ts';
import { argumentsOf, jsonBytes, main, output, record, readJson, requireFact, sha256 } from './io.ts';
const CONTENT_EXPORT = '请改喂 agile:mindmap 的 content 制品（内层 KityMinder JSON），不要喂 original。先执行 circle-hub resource read <资源> mindmap <文档键>，再执行 circle-hub original export <产物 content 的摘要> --out <仓库外文件>';
function agileEnvelope(bytes: Uint8Array): boolean {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return false; }
  let value: unknown;
  try { value = JSON.parse(text); } catch { return false; }
  return record(value) && Object.hasOwn(value, 'code') && Object.hasOwn(value, 'msg') && Object.hasOwn(value, 'data') && !Object.hasOwn(value, 'root');
}
function normalized(bytes: Uint8Array) {
  requireFact(!agileEnvelope(bytes), `这是敏捷平台的原始应答信封，解包 data 不在两种允许的规整里。${CONTENT_EXPORT}`);
  try { return normalizeMindmap(bytes); } catch { requireFact(false, '原件无法按公开规整规则读取；请集成者用 normalize-mindmap.ts 核对两项已知变换并补取有效原件后重跑，不猜修内容'); }
}
export function autoCases(bytes: Uint8Array, rule: CaseRule = 'marked', profile?: unknown, requested?: readonly string[]): string[] {
  let parsed: ReturnType<typeof kityminderParser.parse>;
  try { parsed = kityminderParser.parse(normalized(bytes).bytes); }
  catch (error) {
    if (!(error instanceof ParseError)) throw error;
    requireFact(false, `${error.message}；下一步：${error instanceof ParseLimitError ? '集成者按报告的上限拆分脑图，保留各原件及范围后重跑' : '集成者从平台重新导出完整脑图后重跑，不猜修节点内容'}`);
  }
  const extracted = extractCases(parsed.model, rule);
  requireFact(extracted.impreciseAutoids.length === 0, '文档含有精度不确定的数值 autoid；集成者从原脑图以文本重导出全部编号，再按相同 case_rule 重跑，不能使用已舍入值');
  const selected = extracted.cases.filter((v) => v.auto === 'YES');
  let chosen = selected;
  if (requested !== undefined) {
    requireFact(requested.length === 5, `显式列出 ${requested.length} 个编号，需要 5 个；集成者按 --autoids 给恰好五个后重跑，不补选`);
    requireFact(new Set(requested).size === requested.length, '显式列出的编号有重复；集成者去掉重复后重跑，编号必须与原件精确相等');
    const yes = new Set(selected.flatMap((v) => v.autoid === null ? [] : [v.autoid]));
    requireFact(requested.every((id) => yes.has(id)), '显式列出的编号有的不在 auto 正好为 YES 的集合里，或与原件文字不精确相等；集成者按原文字核对 --autoids 后重跑');
    const want = new Set(requested);
    chosen = selected.filter((v) => v.autoid !== null && want.has(v.autoid));
  } else requireFact(selected.length === 5, `找到 ${selected.length} 个 auto 正好为 YES 的用例，需要 5 个；集成者核对原脑图和 case_rule 后重跑，或用 --autoids 从这些用例里显式列出五个，不补选`);
  requireFact(chosen.every((v) => v.autoid !== null && v.autoid.trim() !== '' && !extracted.impreciseAutoids.some((problem) => problem.node === v.id)), '所选用例缺少精确 autoid；集成者从源文档补取文字编号后重跑');
  const ids = chosen.map((v) => v.autoid!);
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
  const { files, options } = argumentsOf(args, 1, ['--out', '--case-rule', '--profile', '--autoids']); const rule = options['--case-rule'] ?? 'marked';
  requireFact(rule === 'marked' || rule === 'tagged', 'case_rule 必须与计划运行相同，使用 marked 或 tagged');
  const requested = options['--autoids'] === undefined ? undefined : options['--autoids'].split(',');
  const bytes = readFileSync(files[0]!); const prepared = normalized(bytes); const ids = autoCases(prepared.bytes, rule, options['--profile'] ? readJson(options['--profile']) : undefined, requested);
  output(options['--out'] ?? '', 'auto-cases.json', jsonBytes({ case_rule: rule, autoids: ids, original_sha256: prepared.before_sha256, normalized_sha256: prepared.after_sha256, ...(requested === undefined ? {} : { selection_source: '选择来源：集成者显式列出' }) }));
  output(options['--out'] ?? '', 'case-source.normalized.json', prepared.bytes);
  output(options['--out'] ?? '', 'case-source.normalization.json', jsonBytes({ original_sha256: prepared.before_sha256, normalized_sha256: prepared.after_sha256, transformations: prepared.transformations }));
  process.stdout.write(JSON.stringify({ count: ids.length, sha256: sha256(bytes), normalized_sha256: prepared.after_sha256, transformations: prepared.transformations.length }) + '\n');
}
main(import.meta.url, run);
