// The comparison of two validation results of one submission (the recorded one and the replayed one), field by field.
// Pure JSON in, pure JSON out: nothing here reads a file, a database or the Hub. Only the fields listed in NORMALIZATIONS are
// normalized, and every normalization that was applied is reported with its counts, so a reader can see exactly what was
// taken out of the comparison. Everything else, down to the wording of one error message, decides `same` or `changed`.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** The top-level groups a difference is filed under. */
export type DiffField = 'acceptance' | 'errors' | 'partitions' | 'coverage' | 'cross_item' | 'rounds' | 'locks' | 'identity' | 'other';

export interface FieldDiff {
  field: DiffField;
  /** JSON Pointer-like path into the result; array positions are the position in the recorded (or, for an addition, the replayed) result. */
  path: string;
  kind: 'changed' | 'removed' | 'added';
  /** A short human label of what sits there (code, item, requirement, layer ...), empty when there is none. */
  label: string;
  recorded?: Json;
  replayed?: Json;
}

export interface NormalizationRule {
  id: string;
  /** Why the field cannot be compared, in the words of the report. */
  description: string;
  /** Whether the rule applies at this path (segments from the root of the result; array positions as `*`). */
  matches(path: readonly string[]): boolean;
  /** What both sides carry in place of the value. */
  placeholder: string;
}

export interface AppliedNormalization {
  id: string;
  description: string;
  recorded: number;
  replayed: number;
}

export interface Comparison {
  same: boolean;
  normalizations: AppliedNormalization[];
  diffs: FieldDiff[];
}

export interface CompareOptions {
  /** The replayed run was bound to another pack version than the recorded one (candidate mode): `locks.pack` and `locks.pack_digest` are the binding itself. */
  rebound?: boolean;
}

const NONDETERMINISTIC: NormalizationRule[] = [
  {
    id: 'trace',
    description: '调用的追踪号（每次调用随机生成 32 位十六进制数）',
    matches: (path) => path.length === 1 && path[0] === 'trace',
    placeholder: '<trace>',
  },
  {
    id: 'exit.due',
    description: '未知的下一步期限 exit.due（调用时刻加 24 小时的时间戳；回放的时钟与当时的不同）',
    matches: (path) => path.length >= 2 && path[path.length - 1] === 'due' && path[path.length - 2] === 'exit',
    placeholder: '<due>',
  },
];

const REBINDING: NormalizationRule[] = [
  {
    id: 'locks.pack',
    description: '候选模式把运行改绑到候选提交里的同名任务包：locks.pack 就是这个绑定本身',
    matches: (path) => path.length === 2 && path[0] === 'locks' && path[1] === 'pack',
    placeholder: '<bound pack>',
  },
  {
    id: 'locks.pack_digest',
    description: '候选模式把运行改绑到候选提交里的同名任务包：locks.pack_digest 就是这个绑定本身',
    matches: (path) => path.length === 2 && path[0] === 'locks' && path[1] === 'pack_digest',
    placeholder: '<bound pack digest>',
  },
];

/** The normalizations that apply to a comparison, in the order they are listed in the output. */
export function normalizationRules(options: CompareOptions = {}): readonly NormalizationRule[] {
  return options.rebound === true ? [...NONDETERMINISTIC, ...REBINDING] : NONDETERMINISTIC;
}

function isObject(value: unknown): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A deep copy of the value with every normalized field replaced by its placeholder; counts per rule go into `counts`. */
function normalize(value: Json, rules: readonly NormalizationRule[], counts: Map<string, number>, path: string[] = []): Json {
  for (const rule of rules) {
    if (value !== undefined && path.length > 0 && rule.matches(path) && !Array.isArray(value) && !isObject(value)) {
      counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1);
      return rule.placeholder;
    }
  }
  if (Array.isArray(value)) return value.map((element) => normalize(element, rules, counts, [...path, '*']));
  if (isObject(value)) {
    const out: { [key: string]: Json } = {};
    for (const key of Object.keys(value)) out[key] = normalize(value[key], rules, counts, [...path, key]);
    return out;
  }
  return value;
}

/** Stable text of a value: object keys sorted, so two equal values are equal strings whatever the key order. */
export function stable(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

const MAX_ALIGNMENT_CELLS = 4_000_000;

/** Pairs of positions (i in a, j in b) of one longest common subsequence of the two lists of stable texts. */
function align(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_ALIGNMENT_CELLS) {
    // Too large to align: compare by position only.
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < Math.min(n, m); i += 1) if (a[i] === b[i]) pairs.push([i, i]);
    return pairs;
  }
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) i += 1;
    else j += 1;
  }
  return pairs;
}

const LABEL_KEYS = ['code', 'item', 'requirement', 'layer', 'id', 'key', 'name'] as const;

/** What names an object for a reader: the identifying fields it carries, in a fixed order. */
function labelOf(value: Json | undefined): string {
  if (!isObject(value)) return '';
  const parts: string[] = [];
  for (const key of LABEL_KEYS) {
    const field = value[key];
    if (typeof field === 'string' || typeof field === 'number') parts.push(`${key}=${String(field)}`);
  }
  return parts.join(' ');
}

function fieldOf(path: readonly string[]): DiffField {
  const first = path[0];
  switch (first) {
    case 'acceptance':
    case 'errors':
    case 'partitions':
    case 'coverage':
    case 'cross_item':
    case 'rounds':
    case 'locks':
      return first;
    case 'run':
    case 'submission':
    case 'schema':
    case 'trace':
      return 'identity';
    default:
      return 'other';
  }
}

const pointer = (path: readonly string[]): string => (path.length === 0 ? '' : `/${path.join('/')}`);

function walk(recorded: Json | undefined, replayed: Json | undefined, path: string[], out: FieldDiff[], labels: readonly string[] = []): void {
  if (recorded === undefined && replayed === undefined) return;
  // The identifying fields of every enclosing object, outermost first (item, requirement, layer ...), name the place for a reader.
  const own = labelOf(recorded) || labelOf(replayed);
  const named = own === '' || labels.includes(own) ? labels : [...labels, own];
  const label = named.join(' ');
  if (recorded === undefined) {
    out.push({ field: fieldOf(path), path: pointer(path), kind: 'added', label, replayed });
    return;
  }
  if (replayed === undefined) {
    out.push({ field: fieldOf(path), path: pointer(path), kind: 'removed', label, recorded });
    return;
  }
  if (Array.isArray(recorded) && Array.isArray(replayed)) {
    walkArrays(recorded, replayed, path, out, labels);
    return;
  }
  if (isObject(recorded) && isObject(replayed)) {
    for (const key of [...new Set([...Object.keys(recorded), ...Object.keys(replayed)])].sort()) {
      walk(recorded[key], replayed[key], [...path, key], out, named);
    }
    return;
  }
  if (stable(recorded) !== stable(replayed)) out.push({ field: fieldOf(path), path: pointer(path), kind: 'changed', label, recorded, replayed });
}

function walkArrays(recorded: readonly Json[], replayed: readonly Json[], path: string[], out: FieldDiff[], labels: readonly string[]): void {
  const pairs = align(recorded.map(stable), replayed.map(stable));
  let i = 0;
  let j = 0;
  const flush = (toI: number, toJ: number): void => {
    // Between two common elements: the unmatched ones of both sides. They sit in the same place, so they are paired in order
    // (one element that changed); what is left over on either side is a removal or an addition.
    const removed: number[] = [];
    const added: number[] = [];
    for (; i < toI; i += 1) removed.push(i);
    for (; j < toJ; j += 1) added.push(j);
    const paired = Math.min(removed.length, added.length);
    for (let k = 0; k < paired; k += 1) {
      const before = recorded[removed[k]];
      const after = replayed[added[k]];
      // Only elements of the same shape are one element that changed; otherwise it is a removal and an addition.
      if ((isObject(before) && isObject(after)) || (Array.isArray(before) && Array.isArray(after))) walk(before, after, [...path, String(removed[k])], out, labels);
      else {
        walk(before, undefined, [...path, String(removed[k])], out, labels);
        walk(undefined, after, [...path, String(added[k])], out, labels);
      }
    }
    for (let k = paired; k < removed.length; k += 1) walk(recorded[removed[k]], undefined, [...path, String(removed[k])], out, labels);
    for (let k = paired; k < added.length; k += 1) walk(undefined, replayed[added[k]], [...path, String(added[k])], out, labels);
  };
  for (const [pi, pj] of pairs) {
    flush(pi, pj);
    i = pi + 1;
    j = pj + 1;
  }
  flush(recorded.length, replayed.length);
}

/** Compares a recorded validation result with a replayed one. Neither argument is changed. */
export function compareResults(recorded: Json, replayed: Json, options: CompareOptions = {}): Comparison {
  const rules = normalizationRules(options);
  const recordedCounts = new Map<string, number>();
  const replayedCounts = new Map<string, number>();
  const left = normalize(recorded, rules, recordedCounts);
  const right = normalize(replayed, rules, replayedCounts);
  const diffs: FieldDiff[] = [];
  walk(left, right, [], diffs);
  return {
    same: diffs.length === 0,
    normalizations: rules.map((rule) => ({ id: rule.id, description: rule.description, recorded: recordedCounts.get(rule.id) ?? 0, replayed: replayedCounts.get(rule.id) ?? 0 })),
    diffs,
  };
}

const CLIP = 240;
const clip = (text: string): string => (text.length <= CLIP ? text : `${text.slice(0, CLIP - 1)}…`);
const show = (value: Json | undefined): string => (value === undefined ? '（无）' : clip(typeof value === 'string' ? JSON.stringify(value) : stable(value)));

/** One readable line per difference, in Chinese, for the report. */
export function describeDiff(diff: FieldDiff): string {
  const where = `${diff.path === '' ? '（整份结果）' : diff.path}${diff.label === '' ? '' : `〔${diff.label}〕`}`;
  switch (diff.kind) {
    case 'removed':
      return `${where}：记录里有，回放里没有。记录：${show(diff.recorded)}`;
    case 'added':
      return `${where}：记录里没有，回放里多出。回放：${show(diff.replayed)}`;
    default:
      return `${where}：记录 ${show(diff.recorded)} → 回放 ${show(diff.replayed)}`;
  }
}

/** The differences of a comparison grouped by field, in the fixed order the report lists them. */
export function groupDiffs(diffs: readonly FieldDiff[]): Array<{ field: DiffField; diffs: FieldDiff[] }> {
  const order: DiffField[] = ['acceptance', 'errors', 'partitions', 'coverage', 'cross_item', 'rounds', 'locks', 'identity', 'other'];
  return order.flatMap((field) => {
    const rows = diffs.filter((diff) => diff.field === field);
    return rows.length === 0 ? [] : [{ field, diffs: rows }];
  });
}
