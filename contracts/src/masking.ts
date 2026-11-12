// The masking dictionary (B02 R[11], decision 159, issue 194 step two): rules an administrator configures, applied to the
// text a business system answers before the Hub stores it. A match is replaced by a placeholder that says what was there
// (a password, a key) without the value, and only the replaced text is kept. No I/O; the only clock is the one that times
// a pattern when a rule is set.
import { z } from 'zod';

export const MASKING_DICTIONARY_SCHEMA = 'masking-dictionary@1';
/** The stars every placeholder carries, so a reader recognises one whatever its label. */
export const MASK_STARS = '*****';
/** The named group that, when a pattern has it, is the only part of a match that is replaced. */
export const MASK_GROUP = 'secret';
export const MAX_MASKING_RULES = 64;
const MAX_PATTERN_CHARS = 500;
/** What a pattern is tried against when it is set: it must finish on each within this many milliseconds. */
const PROBE_BUDGET_MS = 50;

export const MaskingRuleName = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, '规则名以小写字母开头，只含小写字母、数字和连字符，至多 63 个字符');
/**
 * What the placeholder says was there, in the reader's words (密码, 密钥, 设备口令). It goes into text of any format, so
 * it holds nothing a format gives a meaning to: no quote, backslash, angle bracket, ampersand, square bracket or star.
 */
export const MaskingLabel = z.string().trim().min(1, '标签不能为空').max(20, '标签至多 20 个字符')
  .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}"'\\<>&\[\]*`]+$/u, '标签不能含引号、反斜杠、尖括号、方括号、& 和 * 这类有格式含义的字符');
export const MaskingRule = z.object({
  name: MaskingRuleName,
  label: MaskingLabel,
  /** A regular expression in the ECMAScript syntax, matched with the `u` flag over the whole text. */
  pattern: z.string().min(1, '模式不能为空').max(MAX_PATTERN_CHARS, `模式至多 ${MAX_PATTERN_CHARS} 个字符`),
  ignore_case: z.boolean(),
}).strict();
export type MaskingRule = z.infer<typeof MaskingRule>;
export const MaskingDictionary = z.object({
  schema: z.literal(MASKING_DICTIONARY_SCHEMA),
  rules: z.array(MaskingRule).max(MAX_MASKING_RULES, `规则至多 ${MAX_MASKING_RULES} 条`),
}).strict().refine((dictionary) => new Set(dictionary.rules.map((rule) => rule.name)).size === dictionary.rules.length, '规则名不能重复');
export type MaskingDictionary = z.infer<typeof MaskingDictionary>;

export class MaskingRuleError extends Error {}

/** What stands in place of a match: `[密码已遮盖 *****]`. */
export function maskPlaceholder(label: string): string { return `[${label}已遮盖 ${MASK_STARS}]`; }

function expressionOf(rule: MaskingRule): RegExp {
  try { return new RegExp(rule.pattern, `gdu${rule.ignore_case ? 'i' : ''}`); }
  catch (error) { throw new MaskingRuleError(`规则 ${rule.name} 的模式不是合法的正则表达式：${String((error as Error).message).slice(0, 200)}`); }
}

/**
 * The runs a pattern prone to catastrophic backtracking is slow on, each ended by a character that breaks the match. A
 * pattern that backtracks exponentially never finishes on a long run, so the lengths grow by steps: it is caught on a
 * short one, within about a second, before a longer one is tried.
 */
const PROBE_LENGTHS = [12, 16, 20, 24, 28, 32, 48, 64, 128, 256, 512, 1024, 2048, 4096];
function probeRuns(pattern: string): string[] {
  const literals = [...new Set(pattern.replace(/\\[dDwWsSbBpPuUxXcknrtfv0-9]|[()[\]{}|^$.*+?\\]/g, ' ').split(/\s+/).filter(Boolean))].slice(0, 6);
  return ['a', '1', ' ', 'a1', 'a ', '=', 'ab', ...literals];
}

/**
 * Checks a rule as it is set (never as it is applied): the pattern compiles, does not match the empty text (it would put a
 * placeholder between every two characters), and finishes quickly on texts that make a backtracking pattern slow. The
 * probe is a guard against a mistake, not a proof; `circle-hub mask test` shows what a rule does to a real sample.
 */
export function checkMaskingRule(input: unknown, now: () => number = () => performance.now()): MaskingRule {
  const parsed = MaskingRule.safeParse(input);
  if (!parsed.success) throw new MaskingRuleError(parsed.error.issues[0]?.message ?? '规则不合格式');
  const rule = parsed.data, expression = expressionOf(rule);
  if (new RegExp(expression.source, expression.flags.replace('g', '')).test('')) throw new MaskingRuleError(`规则 ${rule.name} 的模式能匹配空文本；请写出至少要匹配的一个字符`);
  for (const run of probeRuns(rule.pattern)) for (const length of PROBE_LENGTHS) {
    const body = run.repeat(Math.ceil(length / run.length));
    for (const probe of [body + '!', body + '\n', '"' + body]) {
      const started = now();
      expression.lastIndex = 0;
      let steps = 0;
      while (expression.exec(probe) !== null && ++steps < 10_000) if (expression.lastIndex === 0) break;
      if (now() - started > PROBE_BUDGET_MS) throw new MaskingRuleError(`规则 ${rule.name} 的模式在长文本上过慢（嵌套的重复或有歧义的分支）；请改写后重试`);
    }
  }
  return rule;
}

export interface MaskingCount { rule: string; count: number }
export interface MaskedText { text: string; applied: MaskingCount[] }
export interface CompiledMasking { readonly rules: readonly MaskingRule[]; apply(text: string): MaskedText }

/**
 * Compiles a dictionary once for many texts. Every rule is matched against the text as it was read, never against another
 * rule's placeholder; where two matches overlap the one that starts first stands, and of two that start together the
 * rule earlier in the dictionary. A pattern with a group named `secret` has only that group replaced, so the words around
 * the value (`password=`) stay for the reader.
 */
export function compileMasking(dictionary: MaskingDictionary | null): CompiledMasking {
  const rules = dictionary?.rules ?? [];
  const compiled = rules.map((rule) => ({ rule, expression: expressionOf(rule), placeholder: maskPlaceholder(rule.label) }));
  return {
    rules,
    apply(text: string): MaskedText {
      if (compiled.length === 0 || text.length === 0) return { text, applied: [] };
      const spans: Array<{ start: number; end: number; order: number }> = [];
      compiled.forEach(({ expression }, order) => {
        expression.lastIndex = 0;
        for (let match = expression.exec(text); match !== null; match = expression.exec(text)) {
          // With the `d` flag every match carries its indices; the checks keep the types honest where the library types say they may be absent.
          const whole = match.indices?.[0];
          if (whole === undefined) break;
          const [start, end] = match.indices?.groups?.[MASK_GROUP] ?? whole;
          if (end > start) spans.push({ start, end, order });
          // A match of no length cannot advance by itself (the group may be empty though the match is not).
          if (whole[1] === whole[0]) expression.lastIndex += 1;
        }
      });
      if (spans.length === 0) return { text, applied: [] };
      spans.sort((a, b) => a.start - b.start || a.order - b.order);
      const counts = new Map<number, number>();
      let out = '', at = 0;
      for (const span of spans) {
        if (span.start < at) continue;
        out += text.slice(at, span.start) + compiled[span.order].placeholder;
        at = span.end;
        counts.set(span.order, (counts.get(span.order) ?? 0) + 1);
      }
      out += text.slice(at);
      return { text: out, applied: [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([order, count]) => ({ rule: compiled[order].rule.name, count })) };
    },
  };
}

/** Media types whose bytes are text the dictionary applies to; anything else (a spreadsheet, an archive, an image) is left as it is. */
export function isMaskableMediaType(mediaType: string): boolean {
  const essence = mediaType.split(';')[0].trim().toLowerCase();
  if (essence.startsWith('text/')) return true;
  if (/\+(json|xml|yaml)$/.test(essence)) return true;
  return ['application/json', 'application/xml', 'application/xhtml+xml', 'application/javascript', 'application/yaml', 'application/x-yaml', 'application/x-ndjson', 'application/x-www-form-urlencoded', 'application/toml', 'application/sql'].includes(essence);
}
