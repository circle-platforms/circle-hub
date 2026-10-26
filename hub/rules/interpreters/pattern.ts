// pattern@1: selected values must (or, negated, must not) match declared patterns. Patterns run on the linear-time matcher;
// their samples are checked when the table is validated (C04 R[0]), within a work budget, once per table content.
import { CORE_VIOLATION_CODES, type CoreViolationCode } from '../../../contracts/generated/protocol.ts';
import { PatternTable, type CheckOutcome } from '../../../contracts/src/tables.ts';
import { baseFor, quoted, refute, support, unknown } from '../outcome.ts';
import { compilePattern, MAX_INPUT, type CompiledPattern } from '../pattern/regex.ts';
import { codePoints, normalizeText } from '../text.ts';
import type { TableIssue } from '../types.ts';
import { defineInterpreter, pathIssues } from './define.ts';
import { missingNote, scalarText, selectLocations } from './values.ts';

export const PATTERN_CODES = (Object.keys(CORE_VIOLATION_CODES) as CoreViolationCode[]).filter((c) => CORE_VIOLATION_CODES[c].interpreter === 'pattern');

/** Matching work allowed per run, in code points times automaton states; beyond it values stay unknown (budget used up). */
export const MAX_WORK = 50_000_000;
/** Matching work allowed for a table's samples when it is validated; a table that needs more is not admitted. */
export const MAX_SAMPLE_WORK = 10_000_000;

type Rule = PatternTable['rules'][number];

const cache = new Map<string, ReturnType<typeof compilePattern>>();
function compiled(rule: Rule): ReturnType<typeof compilePattern> {
  const key = `${rule.flags ?? ''}\u0000${rule.mode ?? 'full'}\u0000${rule.pattern}`;
  let result = cache.get(key);
  if (!result) {
    result = compilePattern(rule.pattern, { ignoreCase: rule.flags === 'i', mode: rule.mode ?? 'full' });
    if (cache.size > 512) cache.clear();
    cache.set(key, result);
  }
  return result;
}

const accepts = (pattern: CompiledPattern, rule: Rule, value: string): boolean => pattern.test(value) !== (rule.negate === true);

function semantic(table: PatternTable): TableIssue[] {
  const issues: TableIssue[] = pathIssues(table.rules.map((r, i): [string, string] => [`/rules/${i}/values`, r.values]));
  let work = 0;
  for (const [i, rule] of table.rules.entries()) {
    const result = compiled(rule);
    if (!result.ok) {
      issues.push({ path: `/rules/${i}/pattern`, message: result.error });
      continue;
    }
    for (const [list, wanted] of [
      ['match', true],
      ['reject', false],
    ] as const) {
      for (const [k, sample] of rule.samples[list].entries()) {
        const text = normalizeText(sample, table.match);
        // Charged before matching, so a hostile table costs at most the budget.
        work += (codePoints(text) + 1) * result.pattern.states;
        if (work > MAX_SAMPLE_WORK) {
          issues.push({ path: `/rules/${i}/samples`, message: `样例的匹配工作量超过上限 ${MAX_SAMPLE_WORK}（字符数乘以自动机状态数），请减少或缩短样例，或简化模式` });
          return issues;
        }
        if (accepts(result.pattern, rule, text) !== wanted) {
          issues.push({ path: `/rules/${i}/samples/${list}/${k}`, message: wanted ? `样例 ${quoted(sample)} 应被接受，却没有` : `样例 ${quoted(sample)} 应被拒绝，却被接受了` });
        }
      }
    }
  }
  return issues;
}

export const patternInterpreter = defineInterpreter({
  id: 'pattern@1',
  codes: PATTERN_CODES,
  schema: PatternTable,
  check: semantic,
  run(table, request) {
    const base = baseFor(request.subject, table);
    const outcomes: CheckOutcome[] = [];
    const missing: string[] = [];
    let checked = 0;
    let work = 0;
    table.rules.forEach((rule, r) => {
      const result = compiled(rule);
      if (!result.ok) {
        outcomes.push(unknown(base, 'check_error', `第 ${r + 1} 条模式无法使用：${result.error}`));
        return;
      }
      const { values: selected, missing: absent } = selectLocations(request.subject, [rule.values]);
      if (absent.length > 0) {
        // Missing is not empty (C04 R[4]).
        if (table.required === true) outcomes.push(unknown(base, 'missing_input', `被判对象里没有 ${rule.values}（缺失，不同于空列表）`));
        else if (!missing.includes(rule.values)) missing.push(rule.values);
        return;
      }
      for (const { pointer, value } of selected) {
        const text = scalarText(value);
        if (text === undefined) {
          outcomes.push(unknown(base, 'check_error', `${pointer} 不是字符串或数值`, { pointer }));
          continue;
        }
        const normalized = normalizeText(text, table.match);
        const length = codePoints(normalized);
        if (length > MAX_INPUT) {
          outcomes.push(unknown(base, 'check_error', `${pointer} 超过 ${MAX_INPUT} 个字符，不做模式匹配`, { pointer }));
          continue;
        }
        work += (length + 1) * result.pattern.states;
        if (work > MAX_WORK) {
          outcomes.push(unknown(base, 'budget_exhausted', `本次核对的匹配工作量已用完，${pointer} 未核对`, { pointer }));
          continue;
        }
        checked += 1;
        const data = { value: text, pattern: rule.pattern, negate: rule.negate === true, rule: r };
        if (accepts(result.pattern, rule, normalized)) outcomes.push(support(base, `${quoted(text)} 符合声明的写法`, { pointer, data }));
        else {
          const why = rule.negate === true ? `不应匹配 ${rule.pattern}` : `应匹配 ${rule.pattern}`;
          outcomes.push(refute(base, 'core.pattern.no_match', `${quoted(text)} ${why}`, { pointer, data }));
        }
      }
    });
    if (outcomes.length === 0) {
      const note = missingNote(missing);
      outcomes.push(support(base, `没有需要核对写法的取值${note.text}`, { data: { checked, ...note.data } }));
    }
    return outcomes;
  },
});
