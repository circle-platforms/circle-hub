// Selection inside JSON values: RFC 9535 JSONPath restricted to member names, indexes and wildcards (what tables use to point
// at the subject), and RFC 6901 JSON Pointer (what outcomes use to say where). Total: invalid input gives null, never a throw.

export type PathSegment = { kind: 'name'; name: string } | { kind: 'index'; index: number } | { kind: 'wildcard' };

export interface Selected {
  /** RFC 6901 pointer of the selected value inside the root. */
  pointer: string;
  value: unknown;
}

const NAME_FIRST = /[A-Za-z_\u0080-￿]/;
const NAME_CHAR = /[A-Za-z0-9_\u0080-￿]/;
const ESCAPES: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', '/': '/', '\\': '\\', "'": "'", '"': '"' };

/** Parses the supported JSONPath subset; null when the path is outside it. */
export function parseJsonPath(path: string): PathSegment[] | null {
  if (typeof path !== 'string' || !path.startsWith('$')) return null;
  const segments: PathSegment[] = [];
  let i = 1;
  while (i < path.length) {
    const c = path[i];
    if (c === '.') {
      i += 1;
      if (path[i] === '*') {
        segments.push({ kind: 'wildcard' });
        i += 1;
        continue;
      }
      if (i >= path.length || !NAME_FIRST.test(path[i])) return null;
      let name = '';
      while (i < path.length && NAME_CHAR.test(path[i])) name += path[i++];
      segments.push({ kind: 'name', name });
      continue;
    }
    if (c !== '[') return null;
    i += 1;
    if (path[i] === '*' && path[i + 1] === ']') {
      segments.push({ kind: 'wildcard' });
      i += 2;
      continue;
    }
    if (path[i] === "'" || path[i] === '"') {
      const quote = path[i++];
      let name = '';
      for (;;) {
        if (i >= path.length) return null;
        const ch = path[i];
        if (ch === quote) break;
        if (ch === '\\') {
          const next = path[i + 1];
          if (next === 'u') {
            const hex = path.slice(i + 2, i + 6);
            if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return null;
            name += String.fromCharCode(Number.parseInt(hex, 16));
            i += 6;
            continue;
          }
          if (next === undefined || !(next in ESCAPES)) return null;
          name += ESCAPES[next];
          i += 2;
          continue;
        }
        name += ch;
        i += 1;
      }
      if (path[i + 1] !== ']') return null;
      segments.push({ kind: 'name', name });
      i += 2;
      continue;
    }
    const match = /^-?(?:0|[1-9][0-9]*)\]/.exec(path.slice(i));
    if (!match) return null;
    const index = Number(match[0].slice(0, -1));
    if (!Number.isSafeInteger(index)) return null;
    segments.push({ kind: 'index', index });
    i += match[0].length;
  }
  return segments;
}

const escapeToken = (token: string): string => token.replace(/~/g, '~0').replace(/\//g, '~1');

export function pointerOf(tokens: readonly (string | number)[]): string {
  return tokens.map((t) => `/${escapeToken(String(t))}`).join('');
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

type Node = { tokens: (string | number)[]; value: unknown };

function step(current: Node[], segment: PathSegment): Node[] {
  const next: Node[] = [];
  for (const node of current) {
    const { value } = node;
    if (segment.kind === 'wildcard') {
      if (Array.isArray(value)) value.forEach((v, i) => next.push({ tokens: [...node.tokens, i], value: v }));
      else if (isObject(value)) for (const key of Object.keys(value)) next.push({ tokens: [...node.tokens, key], value: value[key] });
    } else if (segment.kind === 'name') {
      if (isObject(value) && Object.hasOwn(value, segment.name)) next.push({ tokens: [...node.tokens, segment.name], value: value[segment.name] });
    } else if (Array.isArray(value)) {
      const index = segment.index < 0 ? value.length + segment.index : segment.index;
      if (index >= 0 && index < value.length) next.push({ tokens: [...node.tokens, index], value: value[index] });
    }
  }
  return next;
}

/** All values the path selects, in document order. null when the path is invalid. */
export function selectAll(root: unknown, path: string): Selected[] | null {
  const segments = parseJsonPath(path);
  if (!segments) return null;
  let current: Node[] = [{ tokens: [], value: root }];
  for (const segment of segments) current = step(current, segment);
  return current.map((node) => ({ pointer: pointerOf(node.tokens), value: node.value }));
}

export interface Located {
  selected: Selected[];
  /**
   * The member the path names up to its first wildcard does not exist (C04 R[4]: missing is not empty). `$.cases[*].id`
   * is missing without `cases`; an empty `cases`, or cases without `id`, select nothing but are present.
   */
  missing: boolean;
}

/** Values a path selects and whether its location is missing. An invalid path counts as missing. */
export function locate(root: unknown, path: string): Located {
  const segments = parseJsonPath(path);
  if (!segments) return { selected: [], missing: true };
  let current: Node[] = [{ tokens: [], value: root }];
  let wildcard = false;
  for (const segment of segments) {
    wildcard ||= segment.kind === 'wildcard';
    current = step(current, segment);
    if (current.length === 0) return { selected: [], missing: !wildcard };
  }
  return { selected: current.map((node) => ({ pointer: pointerOf(node.tokens), value: node.value })), missing: false };
}

/** Tokens of an RFC 6901 pointer; null when malformed. */
export function parsePointer(pointer: string): string[] | null {
  if (typeof pointer !== 'string') return null;
  if (pointer === '') return [];
  if (!pointer.startsWith('/') || /~[^01]|~$/.test(pointer)) return null;
  return pointer
    .slice(1)
    .split('/')
    .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
}

export interface Found {
  found: boolean;
  value?: unknown;
}

/** The value at a pointer. Missing members, out-of-range indexes and malformed pointers are not found. */
export function getAt(root: unknown, pointer: string): Found {
  const tokens = parsePointer(pointer);
  if (!tokens) return { found: false };
  let value = root;
  for (const token of tokens) {
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(token)) return { found: false };
      const index = Number(token);
      if (index >= value.length) return { found: false };
      value = value[index];
    } else if (isObject(value)) {
      if (!Object.hasOwn(value, token)) return { found: false };
      value = value[token];
    } else {
      return { found: false };
    }
  }
  return { found: true, value };
}

/** Pointer of a location relative to another location. */
export function joinPointer(base: string, relative: string): string {
  return relative === '' ? base : `${base}${relative}`;
}

/** Deterministic JSON text with sorted object keys, for comparing composite keys. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
