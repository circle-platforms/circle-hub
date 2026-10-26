// The traced check (pack function, applies run): one outcome per defect item, from the frozen item fields. Support lists
// the cases (ids, titles, documents, sorted) and grounds on the tree references of the defect and case entries; an
// untraced defect is an UNKNOWN (missing input) whose reason says the index cannot prove absence. Two advisory
// refutations guard the integrity of the frozen subject: a status conflict of the defect entries, and a listed case whose
// raw defect ids do not carry the bug (the check re-verifies the join instead of trusting the fields).
import { normalizeId } from './ids.ts';
import { STATUS_SHORT, statusText, systemNote } from './matrix.ts';
import { defectSystemInfoOf, defectSystemText, parsePlmResponses, readClosedStatuses, type DefectSystemInfo } from './plm-status.ts';
import { clip, compareText, guarded, internalError, isRecord, shown } from './text.ts';
import type { CaseRef, CheckOutcome, MatrixRow } from './types.ts';

const TIER = 'advisory' as const;

type Item = { id: string; location: string; fields: MatrixRow };

/** The fields as the projection froze them, or null when they are not the matrix shape (a pack defect). */
function fieldsOf(item: Item): MatrixRow | null {
  const fields = item.fields;
  if (!isRecord(fields)) return null;
  const cases = fields.cases;
  if (
    typeof fields.bug !== 'string' ||
    fields.bug === ''&&fields.identity_declaration_status!=='undeclared' ||
    !Array.isArray(fields.ids) ||
    !Array.isArray(fields.statuses) ||
    (fields.statuses as unknown[]).some((s) => typeof s !== 'string') ||
    typeof fields.conflict !== 'boolean' ||
    typeof fields.statement !== 'string' ||
    !Array.isArray(fields.references) ||
    (fields.references as unknown[]).some((r) => typeof r !== 'string') ||
    (fields.systems !== undefined && (!Array.isArray(fields.systems) || (fields.systems as unknown[]).some((s) => typeof s !== 'string'))) ||
    !Array.isArray(cases) ||
    cases.some((c) => !isRecord(c) || typeof c.case !== 'string' || typeof c.title !== 'string' || typeof c.reference !== 'string' || !Array.isArray((c as CaseRef).defects))
  ) {
    return null;
  }
  // Runs frozen before the systems field carry none.
  return fields.systems === undefined ? { ...fields, systems: [] } : fields;
}

/** The cases-view facts the projection froze, for the unknown reason (skipped sources, a cut view). */
function caseViewFacts(subject: unknown): { skipped: number; truncated: boolean } {
  const raw = isRecord(subject) && isRecord(subject.context) && Array.isArray(subject.context.groups) && isRecord(subject.context.groups[0]) && isRecord(subject.context.groups[0].views) && isRecord(subject.context.groups[0].views.cases)
    ? subject.context.groups[0].views.cases
    : {};
  return { skipped: typeof raw.skipped === 'number' ? raw.skipped : 0, truncated: raw.truncated === true };
}

function dataOf(fields: MatrixRow, info: DefectSystemInfo): Record<string, unknown> {
  return {
    bug: fields.bug,
    ids: fields.ids,
    status: fields.conflict ? null : (fields.statuses[0] ?? null),
    statuses: fields.statuses,
    conflict: fields.conflict,
    statement: fields.statement,
    systems: fields.systems,
    ambiguous_cases:fields.ambiguous_cases ?? [],
    defect_system_status: info.status,
    defect_system_unknown_reason: info.unknownReason,
    closed: info.isClosed,
    ...(info.unconnectedSystem ? { defect_system_unread: { system: info.unconnectedSystem, reason: 'system_not_connected' } } : {}),
    case_count: fields.cases.length,
    cases: fields.cases.map((c) => ({ case: c.case, title: c.title, document: c.document, reference: c.reference })),
  };
}

/** The unknown reason of an untraced defect: the index is incomplete by construction; absence is not proof. */
function untracedStatement(bug: string, statuses: readonly string[], info: DefectSystemInfo, facts: { skipped: number; truncated: boolean }): string {
  const sysText = defectSystemText(info);
  let statement = `缺陷 ${bug}（发布说明：${statusText(statuses)}；${sysText}）：没有已索引的用例标出缺陷 ${bug}。用例索引按构造不完整：没有列出不等于没有`;
  if (facts.skipped > 0) statement += `；索引有 ${facts.skipped} 份列出的来源没有读取`;
  if (facts.truncated) statement += '；用例索引视图被截断，只列出前一部分';
  return clip(statement, MAX_STATEMENT_LENGTH - 100) + '；下一步：请集成者补齐来源、完整范围和缺席观察后重跑';
}

const MAX_STATEMENT_CASES = 5;
const MAX_STATEMENT_LENGTH = 500;

/** Sorts cases: document numerically ascending, then case id string ascending. */
export function compareCaseOrder(a: CaseRef, b: CaseRef): number {
  const docA = a.document ?? '';
  const docB = b.document ?? '';
  const numA = Number.parseInt(docA, 10);
  const numB = Number.parseInt(docB, 10);
  if (!Number.isNaN(numA) && !Number.isNaN(numB) && numA !== numB) {
    return numA - numB;
  }
  if (docA !== docB) {
    return compareText(docA, docB);
  }
  return compareText(a.case, b.case);
}

function tracedStatement(fields: MatrixRow, info: DefectSystemInfo): string {
  const ordered = [...fields.cases].sort(compareCaseOrder);
  const listed = ordered.slice(0, MAX_STATEMENT_CASES);
  const caseParts = listed.map((c) => {
    const doc = c.document ?? '';
    const title = shown(c.title, 30);
    return title ? `${doc}:${c.case} ${title}` : `${doc}:${c.case}`;
  });
  const more = fields.cases.length - MAX_STATEMENT_CASES;
  const moreText = more > 0 ? `；另有 ${more} 个` : '';
  const note = systemNote(fields.systems);
  const sysText = defectSystemText(info);
  const full = `缺陷 ${fields.bug}（发布说明：${statusText(fields.statuses)}；${sysText}）：${fields.cases.length} 个已索引用例追溯：${caseParts.join('；')}${moreText}${note}`;
  return clip(full, MAX_STATEMENT_LENGTH);
}

function outcomeOf(item: Item, at: number, fields: MatrixRow, facts: { skipped: number; truncated: boolean }, info: DefectSystemInfo): CheckOutcome {
  const pointer = `/items/${at}/fields`;
  if(fields.declaration_status==='undeclared')return {verdict:'unknown',reason:'missing_input',missing:fields.missing??'缺发布说明的结构状态',statement:'已修复状态未声明；下一步：'+fields.next_action,grounds:fields.references,tier:TIER,item:item.id,pointer,data:{...fields,status:null,fixed:null}};
  const caseGrounds = fields.cases.map((c) => c.reference);
  const grounds = [...fields.references, ...caseGrounds];
  // The join re-verified against the raw ids of each listed case, not trusted. A slim view (fields=document,node,title)
  // does not carry the raw ids: the index's key mapping is the join's evidence then, and only a case whose raw ids are
  // present can contradict the bug it is listed under.
  const offending = fields.cases.filter((c) => c.defects.length > 0 && !c.defects.some((d) => normalizeId(d) === fields.bug));
  if (offending.length > 0) {
    return {
      verdict: 'refute',
      code: 'traceability.join_mismatch',
      statement: `条目 ${fields.bug} 的用例列表里有 ${offending.length} 个用例的原始缺陷编号不含这个缺陷（${offending
        .slice(0, 5)
        .map((c) => c.case)
        .join('、')}${offending.length > 5 ? ' 等' : ''}）：被判对象自相矛盾，追溯结论不可信`,
      grounds,
      tier: TIER,
      item: item.id,
      pointer,
      data: { bug: fields.bug, offending: offending.map((c) => c.case) },
    };
  }
  if ((fields.collision_systems?.length ?? 0) > 1) return {
    verdict: 'refute', code: 'traceability.id_collision',
    statement: `缺陷 ${fields.bug} 在系统 ${fields.collision_systems!.join('、')} 已确认撞号；按系统分别列项，${fields.ambiguous_cases?.length ?? 0} 个用例在当前视图中未带系统，不强行连接，请补取用例的系统来源后重跑`,
    grounds: [...new Set([...grounds, ...(fields.collision_references ?? [])])], tier: TIER, item: item.id, pointer,
    data: { ...dataOf(fields, info), collision_systems: fields.collision_systems, ambiguous_cases: fields.ambiguous_cases ?? [] },
  };
  const sysText = defectSystemText(info);
  if (fields.conflict) {
    return {
      verdict: 'refute',
      code: 'traceability.status_conflict',
      statement: `缺陷 ${fields.bug}（发布说明：${statusText(fields.statuses)}；${sysText}）：状态矛盾（${fields.statuses.map((s) => STATUS_SHORT[s] ?? s).join('、')}）：来源既把它列为已修复又列为已知；追溯到的用例照列（${fields.cases.length} 个），状态以缺陷系统为准${systemNote(fields.systems)}`,
      grounds,
      tier: TIER,
      item: item.id,
      pointer,
      data: dataOf(fields, info),
    };
  }
  if (fields.cases.length > 0) {
    const ambiguous = fields.ambiguous_cases ?? [];
    if (ambiguous.length > 0) {
      // Connected cases stay in the data, but a same-number case without a system field is not evidence for either
      // system: the conclusion stays unknown, naming the missing fact and the next step.
      const statement = `缺陷 ${fields.bug}（${sysText}）追溯到 ${fields.cases.length} 个已明确系统的用例；另有 ${ambiguous.length} 个同号用例未带系统，不能归入任何系统。缺少这些用例的系统来源事实；下一步由集成者按用例引用补取系统来源后重跑，不把未带系统的用例当作已有连接。`;
      return {
        verdict: 'unknown',
        missing: '尚未取得本检查所需的事实：' + (statement),
        reason: 'missing_input',
        statement,
        grounds,
        tier: TIER,
        item: item.id,
        pointer,
        data: dataOf(fields, info),
      };
    }
    return {
      verdict: 'support',
      statement: tracedStatement(fields, info),
      grounds,
      tier: TIER,
      item: item.id,
      pointer,
      data: dataOf(fields, info),
    };
  }
  return {
    verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (untracedStatement(fields.bug, fields.statuses, info, facts)),
    reason: 'missing_input',
    statement: fields.ambiguous_cases?.length ? `缺陷 ${fields.bug} 在当前视图有 ${fields.ambiguous_cases.length} 个同号用例的系统归属待补；请集成者补取用例系统来源，在本次追溯重跑前明确归属，不能按无追溯或任一系统处理` : untracedStatement(fields.bug, fields.statuses, info, facts),
    grounds: [...fields.references],
    tier: TIER,
    item: item.id,
    pointer,
    data: dataOf(fields, info),
  };
}

/** Outcomes of the check for a subject of the subject builder (functions/subject.ts). */
export function traceOutcomes(
  subject: unknown,
  sources?: Readonly<Record<string, string>>,
  table?: unknown,
  unreadSources?: ReadonlyArray<{ reference: string; reason: string; external?: string; slot?: string }>,
): CheckOutcome[] {
  const raw = isRecord(subject) ? subject : {};
  const items = (Array.isArray(raw.items) ? raw.items : []).filter(isRecord);
  const facts = caseViewFacts(subject);
  const closedStatuses = readClosedStatuses(table);
  const closedSet = new Set(closedStatuses);
  const { hasPlmSource, hasUnreadSources, statuses: plmStatuses, unread: plmUnread } = parsePlmResponses(sources, unreadSources);
  const out: CheckOutcome[] = [];
  for (const [at, value] of items.entries()) {
    const item: Item = {
      id: typeof value.id === 'string' ? value.id : '',
      location: typeof value.location === 'string' ? value.location : '',
      fields: value.fields as MatrixRow,
    };
    if (item.id === '') continue;
    try {
      const fields = fieldsOf(item);
      if (fields === null) {
        out.push({ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (`条目 ${item.id} 的字段不是追溯矩阵的形状（任务包缺陷）`), reason: 'check_error', statement: `条目 ${item.id} 的字段不是追溯矩阵的形状（任务包缺陷）`, grounds: [], tier: TIER, item: item.id, pointer: `/items/${at}/fields` });
        continue;
      }
      const info = defectSystemInfoOf(fields.bug, fields.systems, plmStatuses, plmUnread, closedSet, hasPlmSource, hasUnreadSources);
      out.push(outcomeOf(item, at, fields, facts, info));
    } catch (error) {
      out.push({ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (`追溯检查出错（任务包缺陷）：${internalError(error)}`), reason: 'check_error', statement: `追溯检查出错（任务包缺陷）：${internalError(error)}`, grounds: [], tier: TIER, item: item.id });
    }
  }
  if (out.length === 0) out.push({ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + ('追溯检查的被判对象里没有条目（子对象构建函数没有给出 items）'), reason: 'check_error', statement: '追溯检查的被判对象里没有条目（子对象构建函数没有给出 items）', grounds: [], tier: TIER });
  return out;
}

/** Pack check function: PackCheckInput of hub/rules -> check-outcome@1 array. */
export default function traceCheck(input: unknown): unknown {
  const checkInput = isRecord(input) ? input : {};
  return guarded<unknown>(
    () =>
      traceOutcomes(
        checkInput.subject,
        checkInput.sources as Readonly<Record<string, string>> | undefined,
        checkInput.table,
        checkInput.unread_sources as ReadonlyArray<{ reference: string; reason: string }> | undefined,
      ),
    (message) => [{ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (`追溯检查出错（任务包缺陷）：${message}`), reason: 'check_error', statement: `追溯检查出错（任务包缺陷）：${message}`, grounds: [], tier: TIER }],
  );
}
