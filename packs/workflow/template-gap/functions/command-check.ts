import { checkedClassification, coverageOutcomes } from './coverage-check.ts';
import { readCommandIdentity } from './command-identity.ts';
// Advisory facts from the frozen case index and per-case template membership. Display rows cannot set the universe.
import TABLE from '../tables/template-v3.json' with { type: 'json' };
import type { CheckOutcome } from '../../../../contracts/src/tables.ts';
import type { CaseCategory, CaseRevisionNodes, CommandCoverage, Skip } from './types.ts';
import { isBlank } from './text.ts';
import { isRecord } from './common.ts';
import { readCaseIndex, indexBindingFix } from './index.ts';
import { readTemplate } from './template.ts';
import { commandCoverage } from './commands.ts';
const TIER = 'advisory' as const;
export function commandOutcomes(subject: unknown): CheckOutcome[] {
  const s = isRecord(subject) ? subject : {};
  const item = typeof s.item === 'string' ? s.item : undefined;
  const document = typeof s.document === 'string' ? s.document : '';
  const lock = isRecord(s.lock) ? s.lock : {};
  const base = { tier: TIER, ...(item ? { item } : {}), grounds: typeof s.location === 'string' && s.location.startsWith('src:') ? [s.location] : [] };
  const unknown = (statement: string, missing: string[], data: Record<string, unknown> = {}): CheckOutcome => {
    const action = typeof data.next_action === 'string' ? data.next_action : `补齐缺失事实后重新开始运行文档 ${document}`;
    return { ...base, verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (statement), reason: 'missing_input', statement, data: { missing, ...data, next_action: action, recovery: { action, object: { document: document || item || '当前文档', build: lock.build ?? null }, deadline: '本轮最终回报前；补齐事实后立即重跑，单次补读仍不全则报告能力缺口', attempts: 1 } } };
  };
  const retry = `知识同步后，重新读取锁定构建 ${String(lock.build ?? '未提供')} 的 case_index 并重跑文档 ${document}；若同键、字节上限或标题/标签字段截断仍导致取不全，明确报告索引补读能力缺口并交集成者处理`;
  const nodes = isRecord(s.nodes) ? s.nodes : {};
  const validNodes = Array.isArray(nodes.texts) && nodes.texts.every(v => typeof v === 'string') && Array.isArray(nodes.parents) && nodes.parents.length === nodes.texts.length && nodes.parents.every((v, i) => Number.isSafeInteger(v) && v >= -1 && v < i);
  if (!validNodes || (s.case_rule !== 'marked' && s.case_rule !== 'tagged') || !document || typeof s.uploaded !== 'boolean' || !Array.isArray(s.cases) || s.cases.length !== s.case_count || !s.cases.every(c => isRecord(c) && typeof c.id === 'string' && Number.isSafeInteger(c.visit) && (c.visit as number) >= 0 && (c.visit as number) < (nodes.texts as unknown[]).length && Array.isArray(c.categories) && c.categories.every(v => typeof v === 'string'))) {
    return [unknown('缺少冻结的文档用例事实；下一步：联系包维护人恢复投影快照后重新开始运行', ['frozen_case_facts'], { next_action: '联系包维护人恢复投影快照后重新开始运行' })];
  }
  const cases = s.cases as CaseCategory[];
  const index = s.index === null ? null : readCaseIndex({ inputs: [{ slot: 'case_index', parser: 'json@1', external: 'knowledge:index:bound', model: s.index }], context: lock }, Array.isArray(s.scope) ? s.scope.filter((v): v is string => typeof v === 'string') : []);
  if (index !== null && 'error' in index) return [unknown(`冻结的用例索引不可读：${index.error.message}；下一步：${index.error.fix}`, ['case_index'], { next_action: index.error.fix })];
  const template = readTemplate(TABLE);
  if (typeof template === 'string') throw new Error('invalid package template');
  const skips = Array.isArray(s.skipped) ? s.skipped.filter((v): v is Skip => isRecord(v) && typeof v.category === 'string' && typeof v.reason === 'string' && !isBlank(v.reason) && (v.command === undefined || readCommandIdentity(v.command)!==null)) : [];
  const coverage = commandCoverage(template, document, cases, index, skips, s.uploaded, lock, s.case_rule as 'marked' | 'tagged', nodes as CaseRevisionNodes);
  // The source-view receipt stays in frozen groups; facts cite the locked tree, independent of JSON enumeration order.
  const viewGrounds = coverage.root ? [`tree:${coverage.root}/`] : [];
  const data = { document, root: coverage.root, build: coverage.build };
  const refute = (code: string, statement: string, detail: Record<string, unknown>): CheckOutcome => ({ ...base, verdict: 'refute', code: `template-gap.${code}`, statement, grounds: [...base.grounds, ...viewGrounds], data: { ...data, ...detail } });
  if (coverage.uploaded) return [refute('not_indexed', `上传文件 ${document} 不在用例索引里；根 ${String(coverage.root)}，构建 ${String(coverage.build)}。下一步：用敏捷平台的文档编号重跑`, { scope: 'document', next_action: '用敏捷平台的文档编号重跑' })];
  if (coverage.rule_mismatch) return [refute('case_rule_mismatch', '按命令覆盖与索引的用例规则不一致：索引采用 marked；下一步：用默认 case_rule（不写或设为 marked）重跑，知识同步不能修复规则不一致', { scope: 'document', expected_case_rule: 'marked', actual_case_rule: coverage.case_rule, next_action: '用默认 case_rule（不写或设为 marked）重跑' })];
  if (!coverage.bound) {
    const action = `${indexBindingFix(lock.build, Array.isArray(s.scope) ? s.scope.filter((v): v is string => typeof v === 'string') : [])}；绑定 case_index 后重跑文档 ${document}`;
    return [unknown(`文档 ${document} 缺少用例索引 case_index；下一步：${action}`, ['case_index'], { ...data, scope: 'document', next_action: action })];
  }
  const indexIncomplete = coverage.truncated || coverage.skippedSources > 0 || coverage.cutKeys.includes(document);
  if (!coverage.documentIndexed && !indexIncomplete) {
    const action = '用收了这份文档的构建（文档所在版本线不晚于构建）重跑，或等知识同步收进它后重跑；若文档在产品线不分版本范围，先取得该范围的根，用 get_nodes 读取 tree:<不分版本根>/；入口尚未落地时明确报 kb-unversioned 能力缺口，不要反复尝试其他构建';
    return [refute('not_indexed', `文档 ${document} 不在完整用例索引里；根 ${String(coverage.root)}，构建 ${String(coverage.build)}。下一步：${action}`, { scope: 'document', next_action: action })];
  }
  const partial = indexIncomplete || coverage.unmatched.length > 0 || (coverage.missing_identities?.length ?? 0) > 0 || (coverage.unclassified?.length ?? 0) > 0 || (Array.isArray(s.classification_missing) && s.classification_missing.length>0);
  const gapData = { ...data, missing_identities: coverage.missing_identities ?? [], unclassified: coverage.unclassified ?? [], pending_skips: coverage.pending_skips, orphaned_keys: coverage.orphaned, unmatched_cases_count: coverage.unmatched.length, unmatched_cases: coverage.unmatched, skipped_sources: coverage.skippedSources, unplaced_root: coverage.unplacedRoot, unplaced_scope: 'root', truncated: coverage.truncated, cut_keys: coverage.cutKeys, notes: coverage.notes, next_action: retry };
  const missing = [...(coverage.missing_identities?.length ? ['command_identities'] : []), ...(coverage.unclassified ?? []).map(id=>`classification:${id}`), ...(!coverage.documentIndexed ? ['case_index.document'] : []), ...(coverage.skippedSources > 0 ? ['case_index.sources'] : []), ...(coverage.truncated || coverage.cutKeys.includes(document) ? ['case_index.entries'] : []), ...coverage.unmatched];
  const gap = `缺完整身份的用例 ${coverage.missing_identities?.length ?? 0} 个（command_identities）；未分类用例 ${coverage.unclassified?.length ?? 0} 个；旧根需用新生产器重产，分类由客户端补判断后重新提交。文档 ${document} 有 ${coverage.unmatched.length} 个用例没对上索引（键缺失或标题、上级标签不一致）；索引有 ${coverage.orphaned.length} 个已无当前用例的旧键（${coverage.orphaned.join("、")}）；根有 ${coverage.skippedSources} 份来源没读入，未归位说明按视图原文披露（条目仍在索引内）：${coverage.notes.join('；') || '无说明'}${coverage.truncated ? '；视图截断' : ''}，所以可能还有命令没读到。下一步：${retry}`;
  const outcomes: CheckOutcome[] = coverage.commands.map(row => {
    const details = { ...data, orphaned_keys: coverage.orphaned, command: row.command, case_count: row.caseCount, categories: row.categories, skipped: row.skipped, missing: row.missing, identity: row.identity, unclassified: row.unclassified ?? [], potential_missing: row.potential_missing ?? [] };
    const grounds = [...new Set([...base.grounds, ...viewGrounds, ...row.references])];
    if (row.potential_missing?.length) return { ...unknown(`命令 ${row.command} 的用例尚未全部分类，不能判缺类别；${gap}`, missing, { ...details, missing_categories: [], next_action: '客户端补逐用例类别主张后重新提交' }), grounds };
    if (!row.missing.length) return { ...base, verdict: 'support', statement: `文档 ${document} 的命令 ${row.command}：${row.categories.length} 个必选类别均有用例或已声明跳过（用例 ${row.caseCount} 个，跳过 ${row.skipped.length} 类）`, grounds, data: details };
    if (partial) return { ...unknown(`命令 ${row.command} 的已读用例尚未显示 ${row.missing.join('、')}；${gap}`, missing, { ...gapData, command: row.command, missing_categories: row.missing, scope: 'command' }), grounds };
    return { ...refute('command_shortfall', `文档 ${document} 的命令 ${row.command} 缺少类别 ${row.missing.join('、')}；下一步：补齐该命令的这些类别用例，知识同步后重跑`, { ...details, next_action: '补齐该命令的缺失类别用例，知识同步后重跑' }), grounds };
  });
  if (partial) outcomes.push({ ...unknown(gap, missing, { ...gapData, scope: 'document' }), grounds: [...base.grounds, ...viewGrounds] });
  else if (!coverage.commands.length) outcomes.push(refute('no_commands', `文档 ${document} 的 ${coverage.caseCount} 个用例都没解析出命令；下一步：把命令写进用例标题或上级节点，知识同步后重跑`, { scope: 'document', case_count: coverage.caseCount, next_action: '把命令写进用例标题或上级节点，知识同步后重跑' }));
  return outcomes;
}
export default function (input: unknown): unknown {
  try {
    const raw=isRecord(input)?input:{}, subject=isRecord(raw.subject)?raw.subject:{};
    if(subject.source!==undefined){const texts=isRecord(raw.sources)?raw.sources as Record<string,string>:{},c=checkedClassification(subject,texts);
      if(c.errors.length)return coverageOutcomes(subject,texts);
      return commandOutcomes({...subject,cases:c.cases,case_count:c.cases.length,classification_missing:c.missing});
    }
    return commandOutcomes(subject);
  }
  catch { return [{ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + ('按命令覆盖检查出错；下一步：联系包维护人修复后重跑'), reason: 'check_error', statement: '按命令覆盖检查出错；下一步：联系包维护人修复后重跑', tier: TIER, grounds: [], data: { missing: ['command_coverage_check'], next_action: '联系包维护人修复后重跑', recovery: { action: '联系包维护人修复检查函数后重跑', object: { check: 'template-gap.command_coverage' }, deadline: '本轮最终回报前，修复后立即重跑', attempts: 1 } } }]; }
}
