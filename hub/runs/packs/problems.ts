// Problems for pack authors: Chinese messages that name the file and the field and say how to fix it, plus the text and
// JSON decoding every pack file goes through (UTF-8 only, a byte order mark allowed).
import type { PackProblem } from './types.ts';

/** Most problems reported per shape check, so one broken file cannot flood the answer. */
const MAX_SHAPE_ISSUES = 20;

export function problem(rule: string, file: string, message: string, fix: string, at: { field?: string; line?: number } = {}): PackProblem {
  const out: PackProblem = { rule, file, message, fix };
  if (at.field !== undefined) out.field = at.field;
  if (at.line !== undefined) out.line = at.line;
  return out;
}

/** RFC 6901 pointer of a path of keys and indexes. */
export function pointerOf(path: readonly PropertyKey[]): string {
  return path.map((key) => `/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}

/** Human form of a pointer for messages: the whole file when empty. */
export function fieldText(pointer: string): string {
  return pointer === '' ? '整个文件' : pointer;
}

interface Issue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/**
 * One problem per issue of a contract shape. The detail is the contract's own message (English, from contracts/src); the
 * frame says in Chinese which file, which field and which format applies.
 */
export function shapeProblems(rule: string, file: string, schema: string, issues: readonly Issue[], source = 'contracts/src/pack.ts'): PackProblem[] {
  const out = issues.slice(0, MAX_SHAPE_ISSUES).map((issue) => {
    const field = pointerOf(issue.path);
    return problem(rule, file, `${file} 的 ${fieldText(field)} 不符合 ${schema}：${issue.message}`, `按 ${source} 里 ${schema} 的格式改正这一处`, { field });
  });
  if (issues.length > MAX_SHAPE_ISSUES) {
    out.push(problem(rule, file, `${file} 还有 ${issues.length - MAX_SHAPE_ISSUES} 处不符合 ${schema}，没有一一列出`, `改正上面几处后再检查一次`));
  }
  return out;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** UTF-8 text without a leading byte order mark, or null when the bytes are not UTF-8. */
export function utf8(bytes: Uint8Array): string | null {
  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
}

export type JsonRead = { ok: true; value: unknown } | { ok: false; problem: PackProblem };

/**
 * Deepest nesting a pack JSON file may have: well below the 1000 levels the canonical JSON of records takes, so a pack value
 * embedded in a record still fits.
 */
export const MAX_JSON_DEPTH = 256;

interface Frame {
  value: unknown;
  depth: number;
  parent: Frame | null;
  key: PropertyKey;
}

const pathOf = (frame: Frame): PropertyKey[] => {
  const keys: PropertyKey[] = [];
  for (let f: Frame | null = frame; f !== null && f.parent !== null; f = f.parent) keys.unshift(f.key);
  return keys;
};

/**
 * The first value of parsed JSON that canonical JSON (RFC 8785, I-JSON) cannot hold: a string or member name with a lone
 * surrogate, a number outside the double range (JSON.parse makes it an infinity), nesting deeper than MAX_JSON_DEPTH.
 */
function nonCanonical(value: unknown): { pointer: string; message: string; fix: string } | null {
  const stack: Frame[] = [{ value, depth: 0, parent: null, key: '' }];
  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    const v = frame.value;
    if (typeof v === 'string') {
      if (!v.isWellFormed()) return { pointer: pointerOf(pathOf(frame)), message: '有不成对的 UTF-16 代理项，不是合法的 Unicode 文本', fix: '代理项（\\uD800 到 \\uDFFF）要成对出现：改正或删掉这个转义' };
      continue;
    }
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return { pointer: pointerOf(pathOf(frame)), message: '的数值超出了双精度浮点数的范围', fix: '把数值改到双精度范围内，或者写成字符串' };
      continue;
    }
    if (v === null || typeof v !== 'object') continue;
    if (frame.depth >= MAX_JSON_DEPTH) return { pointer: pointerOf(pathOf(frame)), message: `嵌套超过 ${MAX_JSON_DEPTH} 层`, fix: '把结构改浅' };
    const entries: [PropertyKey, unknown][] = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v);
    for (let i = entries.length - 1; i >= 0; i--) {
      const [key, child] = entries[i];
      if (typeof key === 'string' && !key.isWellFormed()) return { pointer: pointerOf(pathOf(frame)), message: '下有成员名含不成对的 UTF-16 代理项', fix: '代理项（\\uD800 到 \\uDFFF）要成对出现：改正这个成员名' };
      stack.push({ value: child, depth: frame.depth + 1, parent: frame, key });
    }
  }
  return null;
}

/**
 * Parses a pack file as JSON; a file that is not UTF-8, not JSON, or JSON that canonical JSON cannot hold is one problem
 * naming the file (and the field).
 */
export function readJsonFile(file: string, bytes: Uint8Array, rule = 'file.json'): JsonRead {
  const text = utf8(bytes);
  if (text === null) return { ok: false, problem: problem(rule, file, `${file} 不是 UTF-8 文本`, `把 ${file} 存成 UTF-8 编码`) };
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    const detail = error instanceof SyntaxError ? error.message : 'JSON 语法错误';
    return { ok: false, problem: problem(rule, file, `${file} 不是合法的 JSON：${detail}`, `改正 ${file} 的 JSON 语法`) };
  }
  const bad = nonCanonical(value);
  if (bad !== null) {
    return { ok: false, problem: problem(rule, file, `${file} 的 ${fieldText(bad.pointer)} ${bad.message}；Hub 的规范化 JSON（RFC 8785）无法表示它`, bad.fix, { field: bad.pointer }) };
  }
  return { ok: true, value };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
