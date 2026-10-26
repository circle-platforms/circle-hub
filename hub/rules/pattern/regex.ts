// Linear-time matcher for the pattern language of pattern@1: ECMAScript regular expression syntax in Unicode mode, restricted
// to what a Thompson automaton runs without backtracking (no backreferences, lookaround or named groups; bounds at most 100).
// Tables are evaluated inside the Hub process, so a pack pattern must not be able to stall it. Character tests delegate to
// single-code-point ECMAScript expressions, so classes, escapes and case folding mean exactly what they mean in JavaScript.

export const MAX_BOUND = 100;
export const MAX_STATES = 1000;
/** Longest value matched, in code points; the caller reports longer values as unknown. */
export const MAX_INPUT = 20_000;

type Test = (cp: string) => boolean;
type AssertKind = 'start' | 'end' | 'word' | 'notword';
type Node =
  | { t: 'empty' }
  | { t: 'char'; test: Test }
  | { t: 'assert'; kind: AssertKind }
  | { t: 'cat'; items: Node[] }
  | { t: 'alt'; items: Node[] }
  | { t: 'repeat'; node: Node; min: number; max: number | null };

type State = { k: 'char'; test: Test; next: number } | { k: 'split'; next: number; alt: number } | { k: 'assert'; kind: AssertKind; next: number } | { k: 'match' };

export interface CompiledPattern {
  test(value: string): boolean;
  readonly states: number;
}

export type CompileResult = { ok: true; pattern: CompiledPattern } | { ok: false; error: string };

class PatternError extends Error {}

const SYNTAX = new Set(['^', '$', '\\', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '/']);
const LINE_TERMINATORS = new Set(['\n', '\r', ' ', ' ']);

class Parser {
  readonly cps: string[];
  readonly flags: string;
  readonly cache = new Map<string, Test>();
  i = 0;

  constructor(source: string, ignoreCase: boolean) {
    this.cps = Array.from(source);
    this.flags = ignoreCase ? 'iu' : 'u';
  }

  peek(): string | undefined {
    return this.cps[this.i];
  }

  fail(message: string): never {
    throw new PatternError(`${message}（位置 ${this.i}）`);
  }

  /** A test for one code point by a single-character ECMAScript expression. */
  single(source: string): Test {
    let test = this.cache.get(source);
    if (!test) {
      let re: RegExp;
      try {
        re = new RegExp(`^${source}$`, this.flags);
      } catch {
        this.fail(`无法解释的字符类 ${source}`);
      }
      test = (cp) => re.test(cp);
      this.cache.set(source, test);
    }
    return test;
  }

  literal(cp: string): Node {
    if (this.flags === 'u') return { t: 'char', test: (c) => c === cp };
    const escaped = SYNTAX.has(cp) ? `\\${cp}` : cp;
    return { t: 'char', test: this.single(escaped) };
  }

  parse(): Node {
    const node = this.alternation();
    if (this.i < this.cps.length) this.fail(`多余的 ${this.peek()}`);
    return node;
  }

  alternation(): Node {
    const items = [this.sequence()];
    while (this.peek() === '|') {
      this.i += 1;
      items.push(this.sequence());
    }
    return items.length === 1 ? items[0] : { t: 'alt', items };
  }

  sequence(): Node {
    const items: Node[] = [];
    while (this.i < this.cps.length && this.peek() !== '|' && this.peek() !== ')') items.push(this.repeat());
    if (items.length === 0) return { t: 'empty' };
    return items.length === 1 ? items[0] : { t: 'cat', items };
  }

  repeat(): Node {
    const atom = this.atom();
    const c = this.peek();
    let min: number;
    let max: number | null;
    if (c === '*') [min, max] = [0, null];
    else if (c === '+') [min, max] = [1, null];
    else if (c === '?') [min, max] = [0, 1];
    else if (c === '{') {
      const rest = this.cps.slice(this.i).join('');
      const m = /^\{(\d+)(,(\d*))?\}/.exec(rest);
      if (!m) this.fail('不完整的数量限定');
      min = Number(m[1]);
      max = m[2] === undefined ? min : m[3] === '' ? null : Number(m[3]);
      if (min > MAX_BOUND || (max !== null && max > MAX_BOUND)) this.fail(`数量上限不能超过 ${MAX_BOUND}`);
      if (max !== null && max < min) this.fail('数量限定的下限大于上限');
      this.i += Array.from(m[0]).length - 1;
    } else return atom;
    if (atom.t === 'assert') this.fail('断言不能重复');
    this.i += 1;
    if (this.peek() === '?') this.i += 1;
    const after = this.peek();
    if (after === '*' || after === '+' || after === '?' || after === '{') this.fail('连续的数量限定');
    return { t: 'repeat', node: atom, min, max };
  }

  atom(): Node {
    const c = this.peek();
    if (c === undefined) this.fail('模式意外结束');
    this.i += 1;
    switch (c) {
      case '(': {
        if (this.peek() === '?') {
          if (this.cps[this.i + 1] !== ':') this.fail('不支持断言组和命名组');
          this.i += 2;
        }
        const inner = this.alternation();
        if (this.peek() !== ')') this.fail('缺少右括号');
        this.i += 1;
        return inner;
      }
      case '[':
        return this.characterClass();
      case '.':
        return { t: 'char', test: (cp) => !LINE_TERMINATORS.has(cp) };
      case '^':
        return { t: 'assert', kind: 'start' };
      case '$':
        return { t: 'assert', kind: 'end' };
      case '\\':
        return this.escape();
      case '*':
      case '+':
      case '?':
        return this.fail('数量限定前面没有可重复的内容');
      case '{':
      case '}':
      case ']':
      case ')':
        return this.fail(`单独的 ${c}`);
      default:
        return this.literal(c);
    }
  }

  characterClass(): Node {
    const start = this.i - 1;
    while (this.i < this.cps.length && this.peek() !== ']') {
      if (this.peek() === '\\') {
        this.i += 1;
        const e = this.peek();
        if ((e === 'u' || e === 'p' || e === 'P') && this.cps[this.i + 1] === '{') {
          while (this.i < this.cps.length && this.peek() !== '}') this.i += 1;
        }
      }
      this.i += 1;
    }
    if (this.peek() !== ']') this.fail('缺少右方括号');
    this.i += 1;
    return { t: 'char', test: this.single(this.cps.slice(start, this.i).join('')) };
  }

  escape(): Node {
    const e = this.peek();
    if (e === undefined) this.fail('模式以反斜杠结束');
    this.i += 1;
    if ('dDwWsS'.includes(e)) return { t: 'char', test: this.single(`\\${e}`) };
    if (e === 'b') return { t: 'assert', kind: 'word' };
    if (e === 'B') return { t: 'assert', kind: 'notword' };
    if (e === 'p' || e === 'P') {
      if (this.peek() !== '{') this.fail('Unicode 属性转义缺少花括号');
      const close = this.cps.indexOf('}', this.i);
      if (close < 0) this.fail('Unicode 属性转义缺少右花括号');
      const body = this.cps.slice(this.i, close + 1).join('');
      this.i = close + 1;
      return { t: 'char', test: this.single(`\\${e}${body}`) };
    }
    const simple: Record<string, string> = { n: '\n', r: '\r', t: '\t', v: '\v', f: '\f' };
    if (e in simple) return this.literal(simple[e]);
    if (e === '0') {
      if (/[0-9]/.test(this.peek() ?? '')) this.fail('不支持八进制转义');
      return this.literal('\0');
    }
    if (/[1-9]/.test(e) || e === 'k') this.fail('不支持反向引用');
    if (e === 'x') {
      const hex = this.cps.slice(this.i, this.i + 2).join('');
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) this.fail('\\x 后面要两位十六进制数');
      this.i += 2;
      return this.literal(String.fromCodePoint(Number.parseInt(hex, 16)));
    }
    if (e === 'u') return this.literal(this.unicodeEscape());
    if (e === 'c') {
      const letter = this.peek() ?? '';
      if (!/^[A-Za-z]$/.test(letter)) this.fail('\\c 后面要一个字母');
      this.i += 1;
      return this.literal(String.fromCharCode(letter.charCodeAt(0) % 32));
    }
    if (SYNTAX.has(e)) return this.literal(e);
    return this.fail(`不支持的转义 \\${e}`);
  }

  unicodeEscape(): string {
    if (this.peek() === '{') {
      const close = this.cps.indexOf('}', this.i);
      const hex = close < 0 ? '' : this.cps.slice(this.i + 1, close).join('');
      if (!/^[0-9A-Fa-f]{1,6}$/.test(hex) || Number.parseInt(hex, 16) > 0x10ffff) this.fail('无效的 \\u{…} 转义');
      this.i = close + 1;
      return String.fromCodePoint(Number.parseInt(hex, 16));
    }
    const hex = this.cps.slice(this.i, this.i + 4).join('');
    if (!/^[0-9A-Fa-f]{4}$/.test(hex)) this.fail('\\u 后面要四位十六进制数');
    this.i += 4;
    const unit = Number.parseInt(hex, 16);
    // A surrogate pair written as two escapes is one code point in Unicode mode.
    if (unit >= 0xd800 && unit <= 0xdbff && this.peek() === '\\' && this.cps[this.i + 1] === 'u') {
      const low = this.cps.slice(this.i + 2, this.i + 6).join('');
      if (/^[0-9A-Fa-f]{4}$/.test(low)) {
        const lowUnit = Number.parseInt(low, 16);
        if (lowUnit >= 0xdc00 && lowUnit <= 0xdfff) {
          this.i += 6;
          return String.fromCharCode(unit, lowUnit);
        }
      }
    }
    return String.fromCharCode(unit);
  }
}

class Builder {
  readonly states: State[] = [{ k: 'match' }];

  push(state: State): number {
    if (this.states.length >= MAX_STATES) throw new PatternError(`模式展开后超过 ${MAX_STATES} 个状态，请简化`);
    this.states.push(state);
    return this.states.length - 1;
  }

  /** States for `node` followed by `next`; returns the entry state. */
  build(node: Node, next: number): number {
    switch (node.t) {
      case 'empty':
        return next;
      case 'char':
        return this.push({ k: 'char', test: node.test, next });
      case 'assert':
        return this.push({ k: 'assert', kind: node.kind, next });
      case 'cat': {
        let at = next;
        for (let i = node.items.length - 1; i >= 0; i--) at = this.build(node.items[i], at);
        return at;
      }
      case 'alt': {
        const starts = node.items.map((item) => this.build(item, next));
        let at = starts[starts.length - 1];
        for (let i = starts.length - 2; i >= 0; i--) at = this.push({ k: 'split', next: starts[i], alt: at });
        return at;
      }
      case 'repeat': {
        let at: number;
        if (node.max === null) {
          const loop = this.push({ k: 'split', next: -1, alt: next });
          const body = this.build(node.node, loop);
          const state = this.states[loop] as { k: 'split'; next: number; alt: number };
          state.next = body;
          at = loop;
        } else {
          at = next;
          for (let k = 0; k < node.max - node.min; k++) at = this.push({ k: 'split', next: this.build(node.node, at), alt: next });
        }
        for (let k = 0; k < node.min; k++) at = this.build(node.node, at);
        return at;
      }
    }
  }
}

/** Compiles a pattern. `full` requires the whole value to match; `search` accepts a match anywhere. */
export function compilePattern(source: string, options: { ignoreCase?: boolean; mode?: 'full' | 'search' } = {}): CompileResult {
  const ignoreCase = options.ignoreCase === true;
  const mode = options.mode ?? 'full';
  try {
    new RegExp(source, ignoreCase ? 'iu' : 'u');
  } catch (error) {
    return { ok: false, error: `不是有效的正则表达式：${(error as Error).message}` };
  }
  let root: Node;
  let parser: Parser;
  const builder = new Builder();
  let start: number;
  try {
    parser = new Parser(source, ignoreCase);
    root = parser.parse();
    start = builder.build(root, 0);
  } catch (error) {
    if (error instanceof PatternError) return { ok: false, error: error.message };
    throw error;
  }
  const states = builder.states;
  const isWord = parser.single('\\w');
  const pattern: CompiledPattern = {
    states: states.length,
    test(value: string): boolean {
      const cps = Array.from(value);
      const n = cps.length;
      const mark = new Int32Array(states.length).fill(-1);
      let generation = 0;
      const holds = (kind: AssertKind, pos: number): boolean => {
        if (kind === 'start') return pos === 0;
        if (kind === 'end') return pos === n;
        const boundary = (pos > 0 && isWord(cps[pos - 1])) !== (pos < n && isWord(cps[pos]));
        return kind === 'word' ? boundary : !boundary;
      };
      const add = (list: number[], s: number, pos: number): void => {
        const stack = [s];
        while (stack.length > 0) {
          const at = stack.pop() as number;
          if (mark[at] === generation) continue;
          mark[at] = generation;
          const state = states[at];
          if (state.k === 'split') stack.push(state.alt, state.next);
          else if (state.k === 'assert') {
            if (holds(state.kind, pos)) stack.push(state.next);
          } else list.push(at);
        }
      };
      let list: number[] = [];
      add(list, start, 0);
      for (let pos = 0; ; pos++) {
        if ((mode === 'search' || pos === n) && list.some((s) => states[s].k === 'match')) return true;
        if (pos === n) return false;
        generation += 1;
        const next: number[] = [];
        for (const s of list) {
          const state = states[s];
          if (state.k === 'char' && state.test(cps[pos])) add(next, state.next, pos + 1);
        }
        if (mode === 'search') add(next, start, pos + 1);
        if (next.length === 0 && mode === 'full') return false;
        list = next;
      }
    },
  };
  return { ok: true, pattern };
}
