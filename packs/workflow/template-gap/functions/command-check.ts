// Advisory facts from the frozen case index and per-case template membership. Display rows cannot set the universe.
import TABLE from '../tables/template-v3.json' with { type: 'json' };
import type { CheckOutcome } from '../../../../contracts/src/tables.ts';
import type { CaseCategory, CommandCoverage, Skip } from './types.ts';
import { isBlank } from './text.ts';
import { isRecord } from './common.ts';
import { readCaseIndex } from './index.ts';
import { readTemplate } from './template.ts';
import { commandCoverage } from './commands.ts';
const TIER = 'advisory' as const;
export function commandOutcomes(subject: unknown): CheckOutcome[] {
  const s = isRecord(subject) ? subject : {};
  const item = typeof s.item === 'string' ? s.item : undefined;
  const document = typeof s.document === 'string' ? s.document : '';
  const lock = isRecord(s.lock) ? s.lock : {};
  const base = { tier: TIER, ...(item ? { item } : {}), grounds: typeof s.location === 'string' && s.location.startsWith('src:') ? [s.location] : [] };
  const unknown = (statement: string, missing: string[], data: Record<string, unknown> = {}): CheckOutcome => ({ ...base, verdict: 'unknown', reason: 'missing_input', statement, data: { missing, ...data } });
  const retry = `知识同步后，重新读取锁定构建 ${String(lock.build ?? '未提供')} 的 case_index 并重跑文档 ${document}；若同键或字节上限仍导致取不全，明确报告索引补读能力缺口并交集成者处理`;
  if (!document || typeof s.uploaded !== 'boolean' || !Array.isArray(s.cases) || s.cases.length !== s.case_count || !s.cases.every(c => isRecord(c) && typeof c.id === 'string' && Array.isArray(c.categories) && c.categories.every(v => typeof v === 'string'))) {
    return [unknown('缺少冻结的文档用例事实；下一步：联系包维护人恢复投影快照后重新开始运行', ['frozen_case_facts'], { next_action: '联系包维护人恢复投影快照后重新开始运行' })];
  }
  const cases = s.cases as CaseCategory[];
  const index = s.index === null ? null : readCaseIndex({ inputs: [{ slot: 'case_index', parser: 'json@1', external: 'knowledge:index:bound', model: s.index }], context: lock }, Array.isArray(s.scope) ? s.scope.filter((v): v is string => typeof v === 'string') : []);
  if (index !== null && 'error' in index) return [unknown(`冻结的用例索引不可读：${index.error.message}；下一步：${index.error.fix}`, ['case_index'], { next_action: index.error.fix })];
  const template = readTemplate(TABLE);
  if (typeof template === 'string') throw new Error('invalid package template');
  const skips = Array.isArray(s.skipped) ? s.skipped.filter((v): v is Skip => isRecord(v) && typeof v.category === 'string' && typeof v.reason === 'string' && !isBlank(v.reason) && (v.command === undefined || typeof v.command === 'string')) : [];
  const coverage = commandCoverage(template, document, cases, index, skips, s.uploaded, lock);
  const viewGrounds = typeof s.index_reference === 'string' && s.index_reference.startsWith('src:') ? [s.index_reference] : [];
  const data = { document, root: coverage.root, build: coverage.build };
  const refute = (code: string, statement: string, detail: Record<string, unknown>): CheckOutcome => ({ ...base, verdict: 'refute', code: `template-gap.${code}`, statement, grounds: [...base.grounds, ...viewGrounds], data: { ...data, ...detail } });
  if (coverage.uploaded) return [refute('not_indexed', `上传文件 ${document} 不在用例索引里；根 ${String(coverage.root)}，构建 ${String(coverage.build)}。下一步：用敏捷平台的文档编号重跑`, { scope: 'document', next_action: '用敏捷平台的文档编号重跑' })];
  if (!coverage.bound) {
    const action = `带 case_index（同一构建，only 精确列出本次敏捷平台文档，fields=document,node,commands）重跑文档 ${document}`;
    return [unknown(`文档 ${document} 缺少用例索引 case_index；下一步：${action}`, ['case_index'], { ...data, scope: 'document', next_action: action })];
  }
  const indexIncomplete = coverage.truncated || coverage.skippedSources > 0 || coverage.cutKeys.includes(document) || coverage.unplacedRoot === null;
  if (!coverage.documentIndexed && !indexIncomplete) {
    const action = '用收了这份文档的构建（文档所在版本线不晚于构建）重跑，或等知识同步收进它后重跑';
    return [refute('not_indexed', `文档 ${document} 不在完整用例索引里；根 ${String(coverage.root)}，构建 ${String(coverage.build)}。下一步：${action}`, { scope: 'document', next_action: action })];
  }
  const partial = indexIncomplete || coverage.unmatched.length > 0;
  const gapData = { ...data, unmatched_cases_count: coverage.unmatched.length, unmatched_cases: coverage.unmatched, skipped_sources: coverage.skippedSources, unplaced_root: coverage.unplacedRoot, unplaced_scope: 'root', truncated: coverage.truncated, cut_keys: coverage.cutKeys, notes: coverage.notes, next_action: retry };
  const missing = [...(!coverage.documentIndexed ? ['case_index.document'] : []), ...(coverage.skippedSources > 0 ? ['case_index.sources'] : []), ...(coverage.truncated || coverage.cutKeys.includes(document) ? ['case_index.entries'] : []), ...(coverage.unplacedRoot === null ? ['case_index.unplaced_count'] : []), ...coverage.unmatched];
  const gap = `文档 ${document} 有 ${coverage.unmatched.length} 个用例没对上索引；根有 ${coverage.skippedSources} 份来源没读入，视图报告未归位条目 ${coverage.unplacedRoot ?? '计数不可读'} 个（全根计数，条目仍在索引内）${coverage.truncated ? '；视图截断' : ''}，所以可能还有命令没读到。下一步：${retry}`;
  const outcomes: CheckOutcome[] = coverage.commands.map(row => {
    const details = { ...data, command: row.command, case_count: row.caseCount, categories: row.categories, skipped: row.skipped, missing: row.missing };
    const grounds = [...new Set([...base.grounds, ...viewGrounds, ...row.references])];
    if (!row.missing.length) return { ...base, verdict: 'support', statement: `文档 ${document} 的命令 ${row.command}：${row.categories.length} 个必选类别均有用例或已声明跳过（用例 ${row.caseCount} 个，跳过 ${row.skipped.length} 类）`, grounds, data: details };
    if (partial) return { ...unknown(`命令 ${row.command} 的已读用例尚未显示 ${row.missing.join('、')}；${gap}`, missing, { ...gapData, command: row.command, missing_categories: row.missing, scope: 'command' }), grounds };
    return { ...refute('command_shortfall', `文档 ${document} 的命令 ${row.command} 缺少类别 ${row.missing.join('、')}；下一步：补齐该命令的这些类别用例，知识同步后重跑`, { ...details, next_action: '补齐该命令的缺失类别用例，知识同步后重跑' }), grounds };
  });
  if (partial) outcomes.push({ ...unknown(gap, missing, { ...gapData, scope: 'document' }), grounds: [...base.grounds, ...viewGrounds] });
  else if (!coverage.commands.length) outcomes.push(refute('no_commands', `文档 ${document} 的 ${coverage.caseCount} 个用例都没解析出命令；下一步：把命令写进用例标题或上级节点，知识同步后重跑`, { scope: 'document', case_count: coverage.caseCount, next_action: '把命令写进用例标题或上级节点，知识同步后重跑' }));
  return outcomes;
}
export default function (input: unknown): unknown {
  try { return commandOutcomes(isRecord(input) ? input.subject : undefined); }
  catch { return [{ verdict: 'unknown', reason: 'check_error', statement: '按命令覆盖检查出错；下一步：联系包维护人修复后重跑', tier: TIER, grounds: [], data: { missing: ['command_coverage_check'], next_action: '联系包维护人修复后重跑' } }]; }
}
