// Deterministic implementation of the integrator's runner G specification. No evaluation or execution.
export interface GArguments { args: string[]; keywords: Record<string, string | number> }
export interface GOptions { keywordNames?: readonly string[]; foldNewlines?: boolean; literalAssertion?: boolean; wait?: boolean }
export class GSyntaxError extends Error {
  readonly rule: string;
  constructor(rule: string, message: string) { super(`G 写法 ${rule}：${message}`); this.name = 'GSyntaxError'; this.rule = rule; }
}
const fail = (rule: string, text: string): never => { throw new GSyntaxError(rule, text); };
const PY_SPACE = /^[\p{White_Space}\u001c-\u001f]+|[\p{White_Space}\u001c-\u001f]+$/gu;
export const pythonTrim = (text: string): string => text.replace(PY_SPACE, '');
function decimal(text: string): number {
  let ascii = '';
  for (const char of text) {
    let start = char.codePointAt(0)!;
    while (start > 0 && /\p{Decimal_Number}/u.test(String.fromCodePoint(start - 1))) start--;
    ascii += String((char.codePointAt(0)! - start) % 10);
  }
  const value = Number(ascii);
  if (!Number.isSafeInteger(value)) fail('integer_range', '整数超出本包可精确表示的范围');
  return value;
}
function fragments(text: string): string[] {
  const out: string[] = []; let start = 0;
  for (let i = 0; i < text.length; i++) {
    const quote = text[i];
    if (quote === '"' || quote === "'") {
      let end = i + 1;
      for (; end < text.length; end++) { if (text[end] === '\\') end++; else if (text[end] === quote) break; }
      if (end < text.length) { i = end; continue; }
    }
    if (text[i] === ',') { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start)); return out;
}
export function decodeG(cell: string | null, options: GOptions = {}): GArguments {
  let text = cell === null || cell === '' ? 'None' : cell;
  if (options.literalAssertion) return { args: [text], keywords: {} };
  if (text.includes('\n')) {
    if (!options.foldNewlines) return { args: [text], keywords: {} };
    text = pythonTrim(text).replace(/[\n\r]/g, '');
  }
  const args: string[] = []; const keywords = Object.create(null) as Record<string, string | number>;
  for (const raw of fragments(text)) {
    let part = pythonTrim(raw); if (!part) continue;
    if ((part.startsWith('"') && part.endsWith('"') || part.startsWith("'") && part.endsWith("'")) && part.length >= 2) part = pythonTrim(part.slice(1, -1));
    const equal = part.indexOf('=');
    if (equal >= 0) {
      const key = pythonTrim(part.slice(0, equal)); const value = pythonTrim(part.slice(equal + 1));
      if (!key.includes(' ')) {
        if (/^\p{Decimal_Number}+$/u.test(value)) keywords[key] = decimal(value);
        else if (/^\p{Number}+$/u.test(value)) fail('unicode_numeric', '非十进制的非 ASCII 数字关键字不属于可核验的写入子集');
        else keywords[key] = value;
        continue;
      }
    }
    args.push(part);
  }
  if (options.wait && (args.length !== 1 || Object.keys(keywords).length || !/^[0-9]+$/.test(args[0]) || !Number.isSafeInteger(Number(args[0])))) fail('wait_ascii', '等待只能有一个 ASCII 数字时长，不能有关键字');
  return { args, keywords };
}
function quote(fragment: string): string {
  if (!fragment.includes(',') && !/^["']/.test(fragment)) return fragment;
  if (fragment.includes('"') && fragment.includes("'")) fail('mixed_quotes', '需要整段引号但值里同时有两种引号');
  if (fragment.endsWith('\\')) fail('quoted_backslash', '需要整段引号且值以反斜杠结尾');
  const mark = fragment.includes('"') ? "'" : '"'; return mark + fragment + mark;
}
const equalArguments = (a: GArguments, b: GArguments): boolean => JSON.stringify(a.args) === JSON.stringify(b.args) && JSON.stringify(Object.entries(a.keywords).sort(([x], [y]) => x < y ? -1 : x > y ? 1 : 0)) === JSON.stringify(Object.entries(b.keywords).sort(([x], [y]) => x < y ? -1 : x > y ? 1 : 0));
export function encodeG(input: GArguments, options: GOptions = {}): string {
  if (options.literalAssertion) {
    if (input.args.length !== 1 || Object.keys(input.keywords).length || !input.args[0]) fail('assertion_literal', '字面断言只收一个非空原样期望');
    return input.args[0];
  }
  if (!input.args.length && !Object.keys(input.keywords).length) fail('empty_cell', '空 G 会传入文字 None，不能表示零个参数');
  for (const value of input.args) {
    if (typeof value !== 'string' || !value || pythonTrim(value) !== value || value.includes('\r')) fail('positional_text', '位置参数不能为空、首尾不能有 Python 空白、不能含 CR');
    const equal = value.indexOf('='); if (!value.includes('\n') && equal >= 0 && !pythonTrim(value.slice(0, equal)).includes(' ')) fail('positional_keyword', '第一个等号前没有半角空格，会被当作关键字');
  }
  let text: string;
  if (input.args.some((v) => v.includes('\n'))) {
    if (input.args.length !== 1 || Object.keys(input.keywords).length || options.foldNewlines || options.wait) fail('newline_single', '换行值只能是唯一参数，且方法不能折叠换行或等待');
    text = input.args[0];
  } else {
    const parts = input.args.map(quote);
    for (const [key, value] of Object.entries(input.keywords).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      if (!(options.keywordNames ?? []).includes(key) || !key || key.includes(' ') || pythonTrim(key) !== key || /[\r\n=,"']/.test(key)) fail('keyword_name', '关键字名不是签名允许的非仅位置参数名，或含不可编码的字符');
      if (typeof value === 'number') { if (!Number.isSafeInteger(value) || value < 0) fail('keyword_integer', '整数关键字必须是安全非负整数'); }
      else if (typeof value !== 'string' || pythonTrim(value) !== value || /[\r\n]/.test(value)) fail('keyword_text', '文字关键字不能有首尾空白或换行');
      else if (/^\p{Number}+$/u.test(value)) fail('keyword_numeric_text', '全数字文字会被转成整数，非 ASCII 数字文字也不能写');
      parts.push(quote(`${key}=${value}`));
    }
    text = parts.join(',');
  }
  const back = decodeG(text, options);
  if (!equalArguments(input, back)) fail('roundtrip', '编码后按运行器读法不能逐值原样回来');
  return text;
}
