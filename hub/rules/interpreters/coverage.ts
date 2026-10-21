// coverage@1: the covered set contains every required member, or a declared skip with a reason names it. Missing is not empty
// (C04 R[4]): required members selected from a missing location, or covered locations that are all missing, leave it unknown.
import { CORE_VIOLATION_CODES, type CoreViolationCode } from '../../../contracts/generated/protocol.ts';
import { CoverageTable } from '../../../contracts/src/tables.ts';
import { getAt } from '../json.ts';
import { baseFor, quoted, refute, support, unknown } from '../outcome.ts';
import { normalizeText, trimWhitespace } from '../text.ts';
import { defineInterpreter, pathIssues } from './define.ts';
import { resolveSet, scalarText, selectLocations, selectValues } from './values.ts';

export const COVERAGE_CODES = (Object.keys(CORE_VIOLATION_CODES) as CoreViolationCode[]).filter((c) => CORE_VIOLATION_CODES[c].interpreter === 'coverage');

export const coverageInterpreter = defineInterpreter({
  id: 'coverage@1',
  codes: COVERAGE_CODES,
  schema: CoverageTable,
  check: (table) =>
    pathIssues([
      ...table.covered.map((p, i): [string, string] => [`/covered/${i}`, p]),
      ['/required/select', 'select' in table.required ? table.required.select : undefined],
      ['/skipped/select', table.skipped?.select],
    ]),
  run(table, request) {
    const base = baseFor(request.subject, table);
    let required: string[];
    const grounds: string[] = [];
    if ('select' in table.required) {
      const selection = selectLocations(request.subject, [table.required.select]);
      if (selection.missing.length > 0) return [unknown(base, 'missing_input', `被判对象里没有 ${table.required.select}（缺失，不同于空列表），无法确定要覆盖的成员`)];
      required = [];
      for (const { value } of selection.values) {
        const text = scalarText(value);
        if (text !== undefined) required.push(text);
      }
    } else {
      const set = resolveSet(table.required, request);
      if (!set.ok) return [unknown(base, set.reason, set.detail)];
      required = set.values;
      if (set.ground) grounds.push(set.ground);
    }
    const norm = (text: string): string => normalizeText(text, table.match);
    const coveredSelection = selectLocations(request.subject, table.covered);
    if (coveredSelection.missing.length === table.covered.length) {
      return [unknown(base, 'missing_input', `被判对象里没有 ${table.covered.join('、')}（缺失，不同于空列表），无法确定覆盖到的成员`)];
    }
    const covered = new Set<string>();
    for (const { value } of coveredSelection.values) {
      const text = scalarText(value);
      if (text !== undefined) covered.add(norm(text));
    }
    const skipped = new Map<string, string>();
    if (table.skipped) {
      for (const { value } of selectValues(request.subject, [table.skipped.select])) {
        const member = getAt(value, table.skipped.member);
        const reason = getAt(value, table.skipped.reason);
        const memberText = member.found ? scalarText(member.value) : undefined;
        if (memberText !== undefined && reason.found && typeof reason.value === 'string' && trimWhitespace(reason.value) !== '') {
          skipped.set(norm(memberText), reason.value);
        }
      }
    }
    const unique = [...new Set(required.map(norm))];
    const missing = unique.filter((m) => !covered.has(m) && !skipped.has(m));
    const skippedList = unique.filter((m) => !covered.has(m) && skipped.has(m)).map((m) => ({ member: m, reason: skipped.get(m) }));
    const data = { required: unique.length, covered: unique.length - missing.length - skippedList.length, skipped: skippedList, missing: missing.slice(0, 100) };
    if (missing.length === 0) {
      return [support(base, `${unique.length} 个必须覆盖的成员都已覆盖${skippedList.length ? `（其中 ${skippedList.length} 个写明了跳过理由）` : ''}`, { grounds, data })];
    }
    const shown = missing.slice(0, 10).map((m) => quoted(m)).join('、');
    return [refute(base, 'core.coverage.shortfall', `缺 ${missing.length} 个：${shown}${missing.length > 10 ? '…' : ''}`, { grounds, data })];
  },
});
