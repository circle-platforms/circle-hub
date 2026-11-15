// A literal of a set length (a 253-character domain name, a 64-character name) is not something a model types reliably: in a real
// run its 253-character domains were 246 to 288 characters long, and the device refused every command that carried one. The
// reference engine generates such a literal from the author's stated length and checks the length before a workbook is emitted.
// Here the plan writes a placeholder and the client expands it the same way every time, before the plan leaves the client:
//   {{domain:N}}  {{domain:N|prefix}}  {{domain:N|prefix|suffix}}  {{name:N}}  {{name:N|prefix}}  {{name:N|prefix|suffix}}
// A domain name is filled with labels of at most 63 characters (RFC 1035 §2.3.4) so that the whole is exactly N characters; a name
// is filled without dots. The fixed parts are kept verbatim and the same placeholder always gives the same literal, so a case that
// names its domain in a command and in an expectation names the same one. Nothing here decides what a case means.
import { CallFailure, isRecord } from './text.ts';

export const MAX_LABEL = 63;
const MAX_LENGTH = 4096;
const PLACEHOLDER = /\{\{(domain|name):([1-9][0-9]{0,3})((?:\|[^|{}]*){0,2})\}\}/g;
const LEFTOVER = /\{\{\s*(?:domain|name)\b/;
const FIXED = /^[\x21-\x7e]*$/;
const QUOTES = /["'`\\]/;
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
export const PLACEHOLDER_FORMS = '{{domain:253}}、{{domain:253|前缀|后缀}} 或 {{name:64}}';

export interface Expansion { placeholder: string; literal: string; length: number; labels: number[] | null }

/** Labels of filler whose joined length, dots included, is exactly `total` (at least 1), none longer than MAX_LABEL. */
function fillerLabels(total: number): string[] {
  const labels: string[] = [];
  let rest = total;
  while (rest > MAX_LABEL) {
    const take = rest === MAX_LABEL + 1 ? MAX_LABEL - 1 : MAX_LABEL; // never leave an empty last label
    labels.push(LETTERS[labels.length % LETTERS.length].repeat(take));
    rest -= take + 1;
  }
  labels.push(LETTERS[labels.length % LETTERS.length].repeat(rest));
  return labels;
}

function expandOne(placeholder: string, kind: string, length: number, prefix: string, suffix: string): Expansion {
  if (length > MAX_LENGTH) throw new CallFailure("invalid_parameters", `占位 ${placeholder} 的长度超过 ${MAX_LENGTH}`, "把长度占位值 N 写在 1 到 4096 之间，或使用原始资料明确给出的完整字面量");
  if (!FIXED.test(prefix + suffix) || QUOTES.test(prefix + suffix)) throw new CallFailure("invalid_parameters", `占位 ${placeholder} 的固定部分只能是不含空白和引号的可见 ASCII 字符`, "长度占位的固定前后缀仅使用不含空白、引号和反斜杠的可见 ASCII 字符");
  if (kind === 'name') {
    const fill = length - prefix.length - suffix.length;
    if (fill < 1) throw new CallFailure("invalid_parameters", `占位 ${placeholder} 的固定部分已有 ${prefix.length + suffix.length} 字符，补不出 ${length} 字符`, "缩短固定前后缀，使声明长度至少还能容纳 1 个填充字符");
    const literal = prefix + 'a'.repeat(fill) + suffix;
    return { placeholder, literal, length: literal.length, labels: null };
  }
  const head = prefix && !prefix.endsWith('.') ? prefix + '.' : prefix;
  const tail = suffix && !suffix.startsWith('.') ? '.' + suffix : suffix;
  const fill = length - head.length - tail.length;
  if (fill < 1) throw new CallFailure("invalid_parameters", `占位 ${placeholder} 的固定部分已有 ${head.length + tail.length} 字符，补不出 ${length} 字符的域名`, "缩短固定域名前后缀，把补充点号也计入总长度，并至少留下 1 个填充字符");
  const literal = head + fillerLabels(fill).join('.') + tail;
  const labels = literal.split('.').map((label) => label.length);
  if (labels.some((n) => n === 0)) throw new CallFailure("invalid_parameters", `占位 ${placeholder} 的固定部分有空的一段（连续的点或首尾的点）`, "移除固定域名前后缀中的连续点和会形成空段的首尾点后重试");
  if (labels.some((n) => n > MAX_LABEL)) throw new CallFailure("invalid_parameters", `占位 ${placeholder} 的固定部分有一段超过 ${MAX_LABEL} 字符；要一段超长时写 {{name:N}}`, "缩短固定域名每段至 63 字符以内；需要超长单段的用例明确使用 {{name:N}}");
  if (literal.length !== length) throw new CallFailure("temporarily_unavailable", `占位 ${placeholder} 展开后是 ${literal.length} 字符，不是 ${length}`, "停止使用本次展开结果；请维护者核对长度占位生成器，再用相同占位重新生成");
  return { placeholder, literal, length, labels };
}

/** Every placeholder of one string expanded; a string that still names one in another form is refused, never sent half-expanded. */
export function expandText(text: string): { text: string; expansions: Expansion[] } {
  const expansions: Expansion[] = [];
  const out = text.replace(PLACEHOLDER, (placeholder: string, kind: string, digits: string, rest: string) => {
    const [prefix = '', suffix = ''] = rest ? rest.slice(1).split('|') : [];
    const expansion = expandOne(placeholder, kind, Number(digits), prefix, suffix);
    expansions.push(expansion);
    return expansion.literal;
  });
  if (LEFTOVER.test(out)) throw new CallFailure("invalid_parameters", `长度占位写法不对：${JSON.stringify(text.slice(0, 120))}；写 ${PLACEHOLDER_FORMS}`, "使用 {{domain:253}}、{{domain:253|前缀|后缀}} 或 {{name:64}} 这种完整占位写法");
  return { text: out, expansions };
}

/** A JSON value with every string's placeholders expanded, and the expansions in order of appearance. */
export function expandValue(value: unknown): { value: unknown; expansions: Expansion[] } {
  const expansions: Expansion[] = [];
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') { const done = expandText(v); expansions.push(...done.expansions); return done.text; }
    if (Array.isArray(v)) return v.map(walk);
    if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([key, inner]) => [key, walk(inner)]));
    return v;
  };
  return { value: walk(value), expansions };
}

/** One line per distinct placeholder: what it became, for the model to read back instead of counting. */
export function describeExpansions(file: string, expansions: Expansion[]): string[] {
  const seen = new Set<string>();
  return expansions.filter((e) => !seen.has(e.placeholder) && seen.add(e.placeholder)).map((e) => `${file}：${e.placeholder} → ${e.length} 字符${e.labels ? `，${e.labels.length} 段，各段 ${e.labels.join('/')}` : ''}`);
}
