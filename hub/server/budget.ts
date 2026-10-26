// The text budget of one tool answer. Measured on the real Circle client 1.10 with a scripted model: Circle forwards only the
// text content of a tool result (structuredContent never reaches the model) and concatenates its text blocks; an answer of
// about 49,000 characters reached the model whole, one of about 61,000 was replaced by "Tool output is too large to include
// here" and could not be used; a CJK character counts as one. So every answer is laid out from blocks within TEXT_BUDGET:
// a line is never cut here, what does not fit is left out whole, and one Chinese note names what was left out and how to
// read it (display rule 7: a truncation is marked 部分). What a renderer shortened itself (an entry's Omission) is named in the
// same note. The tail (the trace line) always ends the text, after the note.
import { labelOf } from '../../contracts/generated/vocabulary.ts';

/**
 * The most characters the text of one tool answer has, the note and the tail included. Well below the ~49,000 the client
 * delivered, so that the client's own framing and a client with a smaller limit still fit. Counted as String.length (UTF-16
 * code units): never less than the characters a client counts (an astral character counts twice).
 */
export const TEXT_BUDGET = 30_000;

/** Something a renderer left out of an entry it shows (the end of a long field, part of a node): named in the note. */
export interface Omission {
  /** What was left out, for the note; omissions with the same text are counted together (…（3 处）). */
  what: string;
  /** How to read what was left out: one Chinese sentence, or null. */
  more: string | null;
}

/** An entry with what its renderer left out of it. */
export interface Clipped {
  lines: readonly string[];
  omitted: readonly Omission[];
}

/** One entry of a block: shown whole or left out whole. A string is one line; an array is lines that belong together. */
export type Entry = string | readonly string[] | Clipped;

export interface Block {
  /** Kept first when the budget is short: lower numbers first, equal ones in display order. */
  priority: number;
  /** Lines before the entries: shown with the first entry, or alone (all or nothing) when the block has no entries. */
  head?: readonly string[];
  /** What the renderer left out of the head; named in the note when the head is shown. */
  omitted?: readonly Omission[];
  entries?: readonly Entry[];
  /** What one entry is, for the note: 条目, 规程, 原文. Default 内容. */
  unit?: string;
  /** The measure word of an entry in the note. Default 行. */
  measure?: '个' | '行' | '条';
  /** The number the note gives the first entry (the second part of a list split by softCap continues the count). Default 1. */
  first?: number;
  /** Index (in the blocks given to fit) of a block that must be shown whole before this one shows anything. */
  after?: number;
  /** How to read the entries from `from` on (index of the first one left out): one Chinese sentence, or null. */
  more?: (from: number) => string | null;
}

/** At most this many parts are named in the note; the rest are summed up, so that the note stays short. */
const MAX_PARTS = 12;

export interface FitOptions {
  budget?: number;
  /** Said for a cut block that gives no `more` of its own. */
  fallback?: string;
  /** Lines that always end the text, after the note (the trace line); never left out. */
  tail?: readonly string[];
}

export interface Fitted {
  text: string;
  /** Whether anything was left out or shortened; the text then has the note (before the tail). */
  cut: boolean;
  /** Entries shown per block, in the order the blocks were given (a block without entries: 1 when its head is shown). */
  shown: number[];
}

/** Line breaks of Unicode (UAX #14 mandatory breaks): CR LF, LF, CR, VT, FF, NEL, LINE and PARAGRAPH SEPARATOR. */
const BREAKS = new RegExp(`\r\n|[\n\r\v\f${String.fromCharCode(0x85, 0x2028, 0x2029)}]`, 'g');

/** A text on one line: every line break becomes a space (quotations match across white space, hub/refs quoteMatches). */
export function oneLine(text: string): string {
  return text.replace(BREAKS, ' ');
}

interface Prepared {
  block: Block;
  head: string[];
  headSize: number;
  entries: string[][];
  sizes: number[];
  omitted: (readonly Omission[])[];
}

interface Filled {
  shown: number[];
  headShown: boolean[];
  /** Characters of the shown lines, each counted with its line break. */
  used: number;
}

const splitLines = (lines: readonly string[]): string[] => lines.flatMap((line) => String(line).split('\n'));
/** What lines add to a text: each line and its line break. */
const sizeOf = (lines: readonly string[]): number => lines.reduce((sum, line) => sum + line.length + 1, 0);

function isClipped(entry: Entry): entry is Clipped {
  return typeof entry === 'object' && !Array.isArray(entry) && Array.isArray((entry as Clipped).lines);
}

function prepare(block: Block): Prepared {
  const head = splitLines(block.head ?? []);
  const raw = block.entries ?? [];
  const entries = raw.map((entry) => splitLines(typeof entry === 'string' ? [entry] : isClipped(entry) ? entry.lines : (entry as readonly string[])));
  const omitted = raw.map((entry) => (isClipped(entry) ? entry.omitted : []));
  return { block, head, headSize: sizeOf(head), entries, sizes: entries.map(sizeOf), omitted };
}

/** Whether a block was shown whole: all its entries, or its head when it has none. */
function wholly(p: Prepared, shown: number, headShown: boolean): boolean {
  return p.entries.length === 0 ? p.head.length === 0 || headShown : shown >= p.entries.length;
}

/**
 * Fills `capacity` characters by priority; inside a block the entries are taken in order up to the first that does not fit.
 * A block that must follow another (`after`) is taken once that one has been taken, whatever their priorities, and shows
 * nothing unless that one was shown whole.
 */
function fill(prepared: readonly Prepared[], capacity: number): Filled {
  const order = prepared.map((_, i) => i).sort((a, b) => prepared[a].block.priority - prepared[b].block.priority || a - b);
  const shown = prepared.map(() => 0);
  const headShown = prepared.map(() => false);
  const done = new Set<number>();
  let used = 0;
  const prerequisite = (i: number): number | null => {
    const after = prepared[i].block.after;
    return after !== undefined && after !== i && prepared[after] !== undefined ? after : null;
  };
  const take = (i: number): void => {
    done.add(i);
    const p = prepared[i];
    const before = prerequisite(i);
    if (before !== null && !wholly(prepared[before], shown[before], headShown[before])) return;
    if (p.entries.length === 0) {
      if (p.head.length > 0 && used + p.headSize <= capacity) {
        used += p.headSize;
        headShown[i] = true;
        shown[i] = 1;
      }
      return;
    }
    let n = 0;
    while (n < p.entries.length && used + p.sizes[n] + (n === 0 ? p.headSize : 0) <= capacity) {
      used += p.sizes[n] + (n === 0 ? p.headSize : 0);
      n++;
    }
    shown[i] = n;
    headShown[i] = n > 0;
  };
  const waiting: number[] = [];
  for (const i of order) {
    const before = prerequisite(i);
    if (before !== null && !done.has(before)) {
      waiting.push(i);
      continue;
    }
    take(i);
    for (let k = 0; k < waiting.length; k++) {
      if (!done.has(prerequisite(waiting[k])!)) continue;
      take(waiting.splice(k, 1)[0]);
      k = -1;
    }
  }
  // Only blocks whose prerequisites form a cycle are left; they show nothing and the note names them.
  for (const i of waiting) take(i);
  return { shown, headShown, used };
}

const range = (from: number, to: number, measure: string): string => (from === to ? `第 ${from} ${measure}` : `第 ${from} 到第 ${to} ${measure}`);

/** The omissions of the shown heads and entries, in display order. */
function omissionsOf(prepared: readonly Prepared[], filled: Filled): Omission[] {
  const out: Omission[] = [];
  prepared.forEach((p, i) => {
    if (filled.headShown[i]) out.push(...(p.block.omitted ?? []));
    const shown = p.entries.length === 0 ? 0 : filled.shown[i];
    for (let n = 0; n < shown; n++) out.push(...p.omitted[n]);
  });
  return out;
}

/**
 * What the budget left out of each block (`dropped`) and what the renderers shortened in the entries that are shown
 * (`shortened`, a field over its own length cap: the budget did not cut it), and how to read both.
 */
function leftOut(prepared: readonly Prepared[], filled: Filled, fallback: string | undefined): { dropped: string[]; shortened: string[]; mores: string[] } {
  const dropped: string[] = [];
  const shortened: string[] = [];
  const mores: string[] = [];
  let unnamedDropped = 0;
  let unnamedShortened = 0;
  const readOn = (more: string | null): void => {
    if (more !== null && more !== '') {
      const sentence = oneLine(more).replace(/[。；;]+$/, '');
      if (!mores.includes(sentence) && mores.length < MAX_PARTS) mores.push(sentence);
    }
  };
  const nameDropped = (part: string, more: string | null): void => {
    if (dropped.length < MAX_PARTS) dropped.push(part);
    else unnamedDropped++;
    readOn(more);
  };
  prepared.forEach((p, i) => {
    const unit = p.block.unit ?? '内容';
    const measure = p.block.measure ?? '行';
    const first = p.block.first ?? 1;
    if (p.entries.length === 0) {
      if (p.head.length === 0 || filled.headShown[i]) return;
      nameDropped(`${unit} ${p.head.length} 行`, p.block.more?.(0) ?? fallback ?? null);
      return;
    }
    const shown = filled.shown[i];
    const total = p.entries.length;
    if (shown >= total) return;
    nameDropped(`${unit} ${total - shown} ${measure}（${range(first + shown, first + total - 1, measure)}）`, p.block.more?.(shown) ?? fallback ?? null);
  });
  const groups = new Map<string, { count: number; more: string | null }>();
  for (const o of omissionsOf(prepared, filled)) {
    const group = groups.get(o.what);
    if (group === undefined) groups.set(o.what, { count: 1, more: o.more });
    else {
      group.count++;
      group.more ??= o.more;
    }
  }
  for (const [what, group] of groups) {
    const part = group.count === 1 ? what : `${what}（${group.count} 处）`;
    if (shortened.length < MAX_PARTS) shortened.push(part);
    else unnamedShortened++;
    readOn(group.more ?? fallback ?? null);
  }
  if (unnamedDropped > 0) dropped.push(`另外 ${unnamedDropped} 处`);
  if (unnamedShortened > 0) shortened.push(`另外 ${unnamedShortened} 处`);
  return { dropped, shortened, mores };
}

/**
 * A list split so that its first part (up to `cap` characters, whole entries) keeps the list's priority and the rest yields
 * to other blocks: `[first, rest]` with the rest numbered on and shown only after the first part is shown whole. `index` is
 * where the first part will stand among the blocks given to fit, so that the rest can name it. The rest never comes before
 * the first part: its priority is at least the list's.
 */
export function softCap(block: Block & { entries: readonly Entry[] }, cap: number, restPriority: number, index: number): [Block, Block] {
  let size = 0;
  let n = 0;
  while (n < block.entries.length) {
    const entry = block.entries[n];
    const lines = splitLines(typeof entry === 'string' ? [entry] : isClipped(entry) ? entry.lines : (entry as readonly string[]));
    if (n > 0 && size + sizeOf(lines) > cap) break;
    size += sizeOf(lines);
    n++;
  }
  const more = block.more;
  const first = block.first ?? 1;
  return [
    { ...block, entries: block.entries.slice(0, n) },
    {
      ...block,
      head: [],
      omitted: [],
      entries: block.entries.slice(n),
      priority: Math.max(restPriority, block.priority),
      first: first + n,
      after: index,
      ...(more ? { more: (from: number) => more(n + from) } : {}),
    },
  ];
}

/** The one note: what the budget left out says the budget, what a field cap shortened says the cap (the answer itself was within the budget). */
function noteOf(dropped: readonly string[], shortened: readonly string[], mores: readonly string[], budget: number): string {
  const said = [
    ...(dropped.length > 0 ? [`这段回答以 ${budget} 个字符为限，略去了${dropped.join('、')}`] : []),
    ...(shortened.length > 0 ? [`有字段超过长度上限被截短：${shortened.join('、')}`] : []),
  ];
  const head = `${labelOf('qualifier_mark', 'partial')}：${said.join('；')}。`;
  return mores.length === 0 ? head : `${head}读其余部分：${mores.join('；')}。`;
}

function assemble(prepared: readonly Prepared[], filled: Filled, note: string | null, tail: readonly string[]): string {
  const lines: string[] = [];
  prepared.forEach((p, i) => {
    if (filled.headShown[i]) lines.push(...p.head);
    for (let n = 0; n < (p.entries.length === 0 ? 0 : filled.shown[i]); n++) lines.push(...p.entries[n]);
  });
  if (note !== null) lines.push(note);
  lines.push(...tail);
  return lines.join('\n');
}

/**
 * Lays the blocks out within the budget. Everything fits and nothing was shortened: the lines in display order, then the
 * tail, no note. Otherwise blocks are filled by priority, each up to its first entry that does not fit, and ONE note before
 * the tail names what was left out (counts and positions) and what was shortened, and how to read it. Whatever the input,
 * the text is at most `budget` characters and no line is cut.
 */
export function fit(blocks: readonly Block[], options: FitOptions = {}): Fitted {
  const budget = options.budget ?? TEXT_BUDGET;
  const tail = splitLines(options.tail ?? []);
  const tailSize = sizeOf(tail);
  const prepared = blocks.map(prepare);
  const all = fill(prepared, Number.POSITIVE_INFINITY);
  const whole = prepared.every((p, i) => wholly(p, all.shown[i], all.headShown[i]));
  if (whole && omissionsOf(prepared, all).length === 0 && all.used + tailSize - 1 <= budget) return { text: assemble(prepared, all, null, tail), cut: false, shown: all.shown };
  // Leave room for the note, then check that the note of what was left out fits; a longer note takes more room next round.
  let reserve = Math.min(400, Math.floor(budget / 4));
  for (let round = 0; round < 8; round++) {
    const filled = fill(prepared, Math.max(0, budget - tailSize - reserve));
    const { dropped, shortened, mores } = leftOut(prepared, filled, options.fallback);
    let note = noteOf(dropped, shortened, mores, budget);
    // A note that would take a third of the answer names the counts only.
    if (note.length > budget / 3) note = noteOf(dropped, shortened, options.fallback === undefined ? [] : [options.fallback], budget);
    if (filled.used + note.length + tailSize <= budget) return { text: assemble(prepared, filled, note, tail), cut: true, shown: filled.shown };
    reserve = Math.max(reserve + 200, note.length + 1);
  }
  // Only for pathological input (hundreds of blocks): a short fixed note and whatever fits beside it. The note itself is cut
  // only for a budget shorter than it and the tail (about 70 characters), never for TEXT_BUDGET.
  const recovery=options.fallback??leftOut(prepared,fill(prepared,0),undefined).mores[0]??'缺少其余部分的读取入口；请管理员补充可读引用后用 get_nodes 读取';
  const shortRecovery=recovery.length<Math.max(80,budget/2)?recovery:'请管理员补充未显示部分的可读引用，再用 get_nodes 读取';
  const note = `${labelOf('qualifier_mark', 'partial')}：这段回答以 ${budget} 个字符为限，有些内容没有显示。读其余部分：${shortRecovery}`;
  const filled = fill(prepared, Math.max(0, budget - tailSize - note.length - 1));
  const text = assemble(prepared, filled, note, tail);
  return text.length <= budget ? { text, cut: true, shown: filled.shown } : { text: note.slice(0, budget), cut: true, shown: prepared.map(() => 0) };
}
