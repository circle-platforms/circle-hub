import type { CheckOutcome } from '../../../../contracts/src/tables.ts';

export const REVIEW_SCOPE_GROUP = 'case_review_scope';
export const REVIEW_SCOPE_SCHEMA = 'case-review-scope@1';

export type ReviewScopeEntry = { item: string; location: string };
export type ReviewScope = {
  schema: typeof REVIEW_SCOPE_SCHEMA;
  source: string;
  document: string;
  parameters: {
    case_rule: 'marked' | 'tagged';
    case_priority: number;
    group_priority: number | null;
    precondition_priority: number | null;
  };
  expected: ReviewScopeEntry[];
  selected: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const priority = (value: unknown): value is number | null => value === null || typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 9;
const casePriority = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 9;

export function createReviewScope(input: Omit<ReviewScope, 'schema'>): ReviewScope {
  return { schema: REVIEW_SCOPE_SCHEMA, ...input, expected: input.expected.map(entry => ({ ...entry })), selected: [...input.selected] };
}

export function readReviewScope(value: unknown): ReviewScope | null {
  if (!isRecord(value) || value.schema !== REVIEW_SCOPE_SCHEMA || typeof value.source !== 'string' || !/^[0-9a-f]{64}$/.test(value.source) || typeof value.document !== 'string' || value.document === '') return null;
  if (!isRecord(value.parameters) || (value.parameters.case_rule !== 'marked' && value.parameters.case_rule !== 'tagged') || !casePriority(value.parameters.case_priority) || !priority(value.parameters.group_priority) || !priority(value.parameters.precondition_priority)) return null;
  if (!Array.isArray(value.expected) || value.expected.length === 0 || !Array.isArray(value.selected)) return null;
  const prefix = `src:${value.source}/kityminder@1/`;
  const ids = new Set<string>();
  const locations = new Set<string>();
  const expected: ReviewScopeEntry[] = [];
  for (const entry of value.expected) {
    if (!isRecord(entry) || typeof entry.item !== 'string' || entry.item === '' || typeof entry.location !== 'string' || !entry.location.startsWith(prefix) || entry.location.length <= prefix.length) return null;
    if (ids.has(entry.item) || locations.has(entry.location)) return null;
    ids.add(entry.item);
    locations.add(entry.location);
    expected.push({ item: entry.item, location: entry.location });
  }
  const selected: string[] = [];
  for (const item of value.selected) {
    if (typeof item !== 'string' || !ids.has(item) || selected.includes(item)) return null;
    selected.push(item);
  }
  return {
    schema: REVIEW_SCOPE_SCHEMA,
    source: value.source,
    document: value.document,
    parameters: {
      case_rule: value.parameters.case_rule,
      case_priority: value.parameters.case_priority,
      group_priority: value.parameters.group_priority,
      precondition_priority: value.parameters.precondition_priority,
    },
    expected,
    selected,
  };
}

export function reviewScopeSubject(input: unknown): unknown {
  const groups = isRecord(input) && isRecord(input.context) && Array.isArray(input.context.groups) ? input.context.groups : [];
  const matches = groups.filter(group => isRecord(group) && group.kind === REVIEW_SCOPE_GROUP);
  const data = matches.length === 1 && isRecord(matches[0].data) ? matches[0].data : null;
  return { scope: data === null ? null : readReviewScope(data.review_scope), conflict: matches.length > 1 };
}

export function captureReviewScope(input: unknown, pack: string): CheckOutcome[] {
  const subject = isRecord(input) && isRecord(input.subject) ? input.subject : {};
  if (subject.conflict === true) return [{ verdict: 'refute', code: `${pack}.scope_conflict`, statement: '同一次运行有多份整份识别范围，不能选择其中一份充当完整覆盖', grounds: [], tier: 'blocking' }];
  const scope = readReviewScope(subject.scope);
  if (scope === null) return [{
    verdict: 'unknown', reason: 'check_error', tier: 'blocking', grounds: [],
    missing: '初评投影冻结的完整用例识别范围；下一步：使用当前评审包重新初评、独立复核，再开始终稿',
    statement: '缺少可核验的完整用例识别范围，不能把已有块当作整份覆盖',
    data: { pack },
  }];
  return [{
    verdict: 'support', tier: 'blocking', grounds: [`src:${scope.source}/kityminder@1/i/0`],
    statement: `已冻结整份 ${scope.expected.length} 个预期条目及本块 ${scope.selected.length} 个条目的识别范围`,
    data: { review_scope: scope },
  }];
}
