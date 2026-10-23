// range@1: numeric ranges per value, prefixes per value (optionally by whole segments) and thresholds on an aggregate of all
// selected values. Numbers are JSON numbers (by their shortest decimal text) or decimal strings, compared exactly.
import { CORE_VIOLATION_CODES, type CoreViolationCode } from '../../../contracts/generated/protocol.ts';
import { MEASURE_LABEL, labelOf } from '../../../contracts/generated/vocabulary.ts';
import { RangeTable, type CheckOutcome } from '../../../contracts/src/tables.ts';
import { baseFor, quoted, refute, support, unknown } from '../outcome.ts';
import { normalizeText, trimWhitespace } from '../text.ts';
import type { TableIssue } from '../types.ts';
import {
  addDecimal,
  compareDecimal,
  decimalJson,
  decimalOfNumber,
  isIntegral,
  MAX_DECIMAL_LENGTH,
  parseDecimal,
  shownDecimal,
  ZERO,
  type Decimal,
} from './decimal.ts';
import { defineInterpreter, pathIssues, rangeIssue } from './define.ts';
import { missingNote, scalarText, selectLocations } from './values.ts';

export const RANGE_CODES = (Object.keys(CORE_VIOLATION_CODES) as CoreViolationCode[]).filter((c) => CORE_VIOLATION_CODES[c].interpreter === 'range');

interface Bounds {
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
}

type NumberRead = { ok: true; value: Decimal } | { ok: false; tooLong: boolean };

function numberOf(value: unknown): NumberRead {
  if (typeof value === 'number') {
    const d = decimalOfNumber(value);
    return d ? { ok: true, value: d } : { ok: false, tooLong: false };
  }
  if (typeof value !== 'string') return { ok: false, tooLong: false };
  const text = trimWhitespace(value);
  if (text.length > MAX_DECIMAL_LENGTH) return { ok: false, tooLong: /^[+-]?[0-9]+(?:\.[0-9]+)?$/.test(text) };
  const d = parseDecimal(text);
  return d ? { ok: true, value: d } : { ok: false, tooLong: false };
}

/** The bounds as exact decimals; table bounds are JSON numbers, so they always convert. */
function exactBounds(b: Bounds): { [K in keyof Bounds]?: Decimal } {
  const out: { [K in keyof Bounds]?: Decimal } = {};
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'] as const) {
    if (b[key] !== undefined) out[key] = decimalOfNumber(b[key] as number);
  }
  return out;
}

function within(n: Decimal, b: { [K in keyof Bounds]?: Decimal }): boolean {
  return (
    (b.minimum === undefined || compareDecimal(n, b.minimum) >= 0) &&
    (b.maximum === undefined || compareDecimal(n, b.maximum) <= 0) &&
    (b.exclusiveMinimum === undefined || compareDecimal(n, b.exclusiveMinimum) > 0) &&
    (b.exclusiveMaximum === undefined || compareDecimal(n, b.exclusiveMaximum) < 0)
  );
}

function boundsText(b: Bounds): string {
  const parts: string[] = [];
  if (b.minimum !== undefined) parts.push(`不小于 ${b.minimum}`);
  if (b.exclusiveMinimum !== undefined) parts.push(`大于 ${b.exclusiveMinimum}`);
  if (b.maximum !== undefined) parts.push(`不大于 ${b.maximum}`);
  if (b.exclusiveMaximum !== undefined) parts.push(`小于 ${b.exclusiveMaximum}`);
  return parts.join('、');
}

const hasBound = (b: Bounds): boolean => [b.minimum, b.maximum, b.exclusiveMinimum, b.exclusiveMaximum].some((x) => x !== undefined);

const MEASURE_TEXT = MEASURE_LABEL;

function semantic(table: RangeTable): TableIssue[] {
  const issues: TableIssue[] = pathIssues(table.checks.map((c, i): [string, string] => [`/checks/${i}/values`, c.values]));
  table.checks.forEach((check, i) => {
    const at = `/checks/${i}`;
    if ('range' in check) {
      if (!hasBound(check.range) && check.range.integer !== true) issues.push({ path: `${at}/range`, message: '范围至少要给出一个界限' });
      issues.push(...rangeIssue(`${at}/range`, check.range.minimum, check.range.maximum));
    } else if ('threshold' in check) {
      if (!hasBound(check.threshold)) issues.push({ path: `${at}/threshold`, message: '阈值至少要给出一个界限' });
      issues.push(...rangeIssue(`${at}/threshold`, check.threshold.minimum, check.threshold.maximum));
    }
  });
  return issues;
}

export const rangeInterpreter = defineInterpreter({
  id: 'range@1',
  codes: RANGE_CODES,
  schema: RangeTable,
  check: semantic,
  run(table, request) {
    const base = baseFor(request.subject, table);
    const outcomes: CheckOutcome[] = [];
    const missing: string[] = [];
    table.checks.forEach((check, c) => {
      const { values: selected, missing: absent } = selectLocations(request.subject, [check.values]);
      if (absent.length > 0) {
        // Missing is not empty (C04 R[4]): not even a count of zero.
        if (table.required === true) outcomes.push(unknown(base, 'missing_input', `被判对象里没有 ${check.values}（缺失，不同于空列表）`));
        else if (!missing.includes(check.values)) missing.push(check.values);
        return;
      }
      if ('threshold' in check) {
        const t = check.threshold;
        let measured: Decimal;
        if (t.measure === 'count') measured = decimalOfNumber(selected.length) as Decimal;
        else {
          const numbers = selected.map((s) => numberOf(s.value));
          if (numbers.some((n) => !n.ok)) {
            const tooLong = numbers.some((n) => !n.ok && n.tooLong);
            const why = tooLong ? `有超过 ${MAX_DECIMAL_LENGTH} 个字符的数值文本` : '有非数值';
            outcomes.push(unknown(base, 'check_error', `${check.values} 选中的取值里${why}，无法计算${MEASURE_TEXT[t.measure]}`));
            return;
          }
          const ns = numbers.map((n) => (n as { value: Decimal }).value);
          if (ns.length === 0 && t.measure !== 'sum') {
            const data={measure:t.measure,empty:true,check:c};
            const message=check.values+' 是空集，按'+(t.empty===undefined?'默认规则':'声明')+labelOf('verdict',t.empty??'refute')+'其'+MEASURE_TEXT[t.measure]+'阈值检查';
            outcomes.push(t.empty==='support'?support(base,message,{data}):refute(base,'core.range.out_of_bounds',message,{data}));
            return;
          }
          if (t.measure === 'sum') measured = ns.reduce(addDecimal, ZERO);
          else measured = ns.reduce((a, b) => ((t.measure === 'min' ? compareDecimal(b, a) < 0 : compareDecimal(b, a) > 0) ? b : a));
        }
        const data = { measure: t.measure, value: decimalJson(measured), check: c };
        if (within(measured, exactBounds(t))) outcomes.push(support(base, `${check.values} 的${MEASURE_TEXT[t.measure]}为 ${shownDecimal(measured)}，在界限内`, { data }));
        else outcomes.push(refute(base, 'core.range.out_of_bounds', `${check.values} 的${MEASURE_TEXT[t.measure]}为 ${shownDecimal(measured)}，要求${boundsText(t)}`, { data }));
        return;
      }
      for (const { pointer, value } of selected) {
        if ('range' in check) {
          const n = numberOf(value);
          const data = { value, check: c };
          if (!n.ok && n.tooLong) {
            outcomes.push(unknown(base, 'check_error', `${pointer} 的数值文本超过 ${MAX_DECIMAL_LENGTH} 个字符，不做比较`, { pointer, data: { check: c } }));
          } else if (!n.ok) outcomes.push(refute(base, 'core.range.out_of_bounds', `${quoted(value)} 不是数值`, { pointer, data }));
          else if (check.range.integer === true && !isIntegral(n.value)) outcomes.push(refute(base, 'core.range.out_of_bounds', `${shownDecimal(n.value)} 不是整数`, { pointer, data }));
          else if (!within(n.value, exactBounds(check.range))) {
            outcomes.push(refute(base, 'core.range.out_of_bounds', `${shownDecimal(n.value)} 超出界限，要求${boundsText(check.range)}`, { pointer, data }));
          } else outcomes.push(support(base, `${shownDecimal(n.value)} 在界限内`, { pointer, data }));
          continue;
        }
        const text = scalarText(value);
        if (text === undefined) {
          outcomes.push(unknown(base, 'check_error', `${pointer} 不是字符串或数值`, { pointer }));
          continue;
        }
        const normalized = normalizeText(text, table.match);
        const prefixes = check.prefix.values.map((p) => normalizeText(p, table.match));
        const separator = check.prefix.separator;
        const starts = (p: string): boolean => {
          if (separator === undefined) return normalized.startsWith(p);
          const own = normalized.split(separator);
          const want = p.split(separator);
          return want.length <= own.length && want.every((segment, i) => segment === own[i]);
        };
        const matched = prefixes.find(starts);
        const data = { value: text, check: c, ...(matched !== undefined ? { prefix: matched } : {}) };
        if (matched !== undefined) outcomes.push(support(base, `${quoted(text)} 以 ${quoted(matched)} 开头`, { pointer, data }));
        else outcomes.push(refute(base, 'core.range.out_of_bounds', `${quoted(text)} 不以声明的前缀开头（${check.prefix.values.join('、')}）`, { pointer, data }));
      }
    });
    if (outcomes.length === 0) {
      const note = missingNote(missing);
      outcomes.push(support(base, `没有需要核对界限的取值${note.text}`, { data: { checked: 0, ...note.data } }));
    }
    return outcomes;
  },
});
