// The traced check (pack function, applies run): one outcome per defect item, from the frozen item fields. Support lists
// the cases (ids, titles, documents, sorted) and grounds on the tree references of the defect and case entries; an
// untraced defect is an UNKNOWN (missing input) whose reason says the index cannot prove absence. Two advisory
// refutations guard the integrity of the frozen subject: a status conflict of the defect entries, and a listed case whose
// raw defect ids do not carry the bug (the check re-verifies the join instead of trusting the fields).
import { normalizeId } from './ids.ts';
import { STATUS_SHORT, statusText } from './matrix.ts';
import { guarded, internalError, isRecord } from './text.ts';
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
    fields.bug === '' ||
    !Array.isArray(fields.ids) ||
    !Array.isArray(fields.statuses) ||
    (fields.statuses as unknown[]).some((s) => typeof s !== 'string') ||
    typeof fields.conflict !== 'boolean' ||
    typeof fields.statement !== 'string' ||
    !Array.isArray(fields.references) ||
    (fields.references as unknown[]).some((r) => typeof r !== 'string') ||
    !Array.isArray(cases) ||
    cases.some((c) => !isRecord(c) || typeof c.case !== 'string' || typeof c.title !== 'string' || typeof c.reference !== 'string' || !Array.isArray((c as CaseRef).defects))
  ) {
    return null;
  }
  return fields;
}

/** The cases-view facts the projection froze, for the unknown reason (skipped sources, a cut view). */
function caseViewFacts(subject: unknown): { skipped: number; truncated: boolean } {
  const raw = isRecord(subject) && isRecord(subject.context) && Array.isArray(subject.context.groups) && isRecord(subject.context.groups[0]) && isRecord(subject.context.groups[0].views) && isRecord(subject.context.groups[0].views.cases)
    ? subject.context.groups[0].views.cases
    : {};
  return { skipped: typeof raw.skipped === 'number' ? raw.skipped : 0, truncated: raw.truncated === true };
}

function dataOf(fields: MatrixRow): Record<string, unknown> {
  return {
    bug: fields.bug,
    ids: fields.ids,
    status: fields.conflict ? null : (fields.statuses[0] ?? null),
    statuses: fields.statuses,
    conflict: fields.conflict,
    statement: fields.statement,
    case_count: fields.cases.length,
    cases: fields.cases.map((c) => ({ case: c.case, title: c.title, document: c.document, reference: c.reference })),
  };
}

/** The unknown reason of an untraced defect: the index is incomplete by construction; absence is not proof. */
function untracedStatement(bug: string, facts: { skipped: number; truncated: boolean }): string {
  let statement = `没有已索引的用例标出缺陷 ${bug}。用例索引按构造不完整：没有列出不等于没有`;
  if (facts.skipped > 0) statement += `；索引有 ${facts.skipped} 份列出的来源没有读取`;
  if (facts.truncated) statement += '；用例索引视图被截断，只列出前一部分';
  return statement;
}

function outcomeOf(item: Item, at: number, fields: MatrixRow, facts: { skipped: number; truncated: boolean }): CheckOutcome {
  const pointer = `/items/${at}/fields`;
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
  if (fields.conflict) {
    return {
      verdict: 'refute',
      code: 'traceability.status_conflict',
      statement: `缺陷 ${fields.bug} 的状态矛盾（${fields.statuses.map((s) => STATUS_SHORT[s] ?? s).join('、')}）：来源既把它列为已修复又列为已知；追溯到的用例照列（${fields.cases.length} 个），状态以缺陷系统为准`,
      grounds,
      tier: TIER,
      item: item.id,
      pointer,
      data: dataOf(fields),
    };
  }
  if (fields.cases.length > 0) {
    return {
      verdict: 'support',
      statement: `缺陷 ${fields.bug}（${statusText(fields.statuses)}）：${fields.cases.length} 个已索引用例追溯`,
      grounds,
      tier: TIER,
      item: item.id,
      pointer,
      data: dataOf(fields),
    };
  }
  return {
    verdict: 'unknown',
    reason: 'missing_input',
    statement: untracedStatement(fields.bug, facts),
    grounds: [...fields.references],
    tier: TIER,
    item: item.id,
    pointer,
    data: dataOf(fields),
  };
}

/** Outcomes of the check for a subject of the subject builder (functions/subject.ts). */
export function traceOutcomes(subject: unknown): CheckOutcome[] {
  const raw = isRecord(subject) ? subject : {};
  const items = (Array.isArray(raw.items) ? raw.items : []).filter(isRecord);
  const facts = caseViewFacts(subject);
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
        out.push({ verdict: 'unknown', reason: 'check_error', statement: `条目 ${item.id} 的字段不是追溯矩阵的形状（任务包缺陷）`, grounds: [], tier: TIER, item: item.id, pointer: `/items/${at}/fields` });
        continue;
      }
      out.push(outcomeOf(item, at, fields, facts));
    } catch (error) {
      out.push({ verdict: 'unknown', reason: 'check_error', statement: `追溯检查出错（任务包缺陷）：${internalError(error)}`, grounds: [], tier: TIER, item: item.id });
    }
  }
  if (out.length === 0) out.push({ verdict: 'unknown', reason: 'check_error', statement: '追溯检查的被判对象里没有条目（子对象构建函数没有给出 items）', grounds: [], tier: TIER });
  return out;
}

/** Pack check function: PackCheckInput of hub/rules -> check-outcome@1 array. */
export default function traceCheck(input: unknown): unknown {
  return guarded<unknown>(
    () => traceOutcomes(isRecord(input) ? input.subject : undefined),
    (message) => [{ verdict: 'unknown', reason: 'check_error', statement: `追溯检查出错（任务包缺陷）：${message}`, grounds: [], tier: TIER }],
  );
}
