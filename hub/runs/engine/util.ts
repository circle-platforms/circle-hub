// Small helpers of the runs engine: JSON Pointers, digests of received arguments, a per-key lock and bounded parallelism.
import { CanonicalizationError, canonicalize, sha256Hex } from '../../records/api.ts';

/** RFC 6901 JSON Pointer from tokens. */
export function pointerOf(...tokens: (string | number)[]): string {
  return tokens.map((t) => `/${String(t).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}

/** Tokens of an RFC 6901 JSON Pointer ('' is the whole value). */
export function pointerTokens(pointer: string): string[] {
  if (pointer === '') return [];
  return pointer
    .slice(1)
    .split('/')
    .map((t) => t.replaceAll('~1', '/').replaceAll('~0', '~'));
}

/** Value at a JSON Pointer, or undefined. Own properties only. */
export function valueAt(root: unknown, pointer: string): unknown {
  let value: unknown = root;
  for (const token of pointerTokens(pointer)) {
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(token)) return undefined;
      value = value[Number(token)];
    } else if (value !== null && typeof value === 'object' && Object.hasOwn(value, token)) {
      value = (value as Record<string, unknown>)[token];
    } else return undefined;
    if (value === undefined) return undefined;
  }
  return value;
}

/** JSON Pointer of a zod issue path (an unrecognized key is appended by the caller). */
export function pointerOfPath(path: readonly PropertyKey[]): string {
  return pointerOf(...path.map((p) => (typeof p === 'symbol' ? String(p.description ?? '') : (p as string | number))));
}

/** Digest of arguments as received: SHA-256 of their RFC 8785 text, or of their JSON text when they are not canonical JSON. */
export function receivedDigest(value: unknown): { digest: string; canonical: boolean; nonCanonicalPath: string | null } {
  try {
    return { digest: sha256Hex(canonicalize(value)), canonical: true, nonCanonicalPath: null };
  } catch (error) {
    if (!(error instanceof CanonicalizationError)) throw error;
    let text: string;
    try {
      text = JSON.stringify(value) ?? 'null';
    } catch {
      text = '{"non_canonical":true}';
    }
    return { digest: sha256Hex(text), canonical: false, nonCanonicalPath: error.path };
  }
}

/** A JSON Pointer cut to whole tokens within `max` characters, so a pointer into hostile input stays short and parsable. */
export function clipPointer(pointer: string, max = 1024): string {
  if (pointer.length <= max) return pointer;
  let end = 0;
  for (let next = pointer.indexOf('/', 1); next !== -1 && next <= max; next = pointer.indexOf('/', next + 1)) end = next;
  return pointer.slice(0, end);
}

/**
 * The JSON Pointer of the first object or array nested `max` levels deep (the root is level 0), or null. Iterative, so
 * hostile nesting cannot exhaust the call stack.
 */
export function tooDeep(value: unknown, max: number): string | null {
  const stack: { value: unknown; path: string; depth: number }[] = [{ value, path: '', depth: 0 }];
  while (stack.length > 0) {
    const top = stack.pop()!;
    if (top.value === null || typeof top.value !== 'object') continue;
    if (top.depth >= max) return top.path;
    if (Array.isArray(top.value)) {
      for (let i = top.value.length - 1; i >= 0; i--) stack.push({ value: top.value[i], path: `${top.path}/${i}`, depth: top.depth + 1 });
    } else {
      const entries = Object.entries(top.value as Record<string, unknown>);
      for (let i = entries.length - 1; i >= 0; i--) stack.push({ value: entries[i][1], path: `${top.path}${pointerOf(entries[i][0])}`, depth: top.depth + 1 });
    }
  }
  return null;
}

/** Text that canonical JSON can carry: lone surrogates replaced by U+FFFD (for messages and details built from input). */
export function wellFormed(text: string): string {
  return text.isWellFormed() ? text : text.toWellFormed();
}

/** The client session id of a call as the engine stores and compares it (well-formed text, or null when unobserved). */
export function sessionOf(call: { sessionId: string | null }): string | null {
  return call.sessionId === null ? null : wellFormed(call.sessionId);
}

/** At most `max` code points of well-formed text (never cut inside a surrogate pair). */
export function clipText(text: string, max: number): string {
  const points = [...wellFormed(text)];
  return points.length <= max ? points.join('') : `${points.slice(0, max).join('')}…`;
}

/** Runs `fn` exclusively per key within this process (serializes submissions of one run and starts under one client key). */
export function createKeyedLock(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Stored tails never reject: each one waits for the previous holder, then for this holder's release.
    const tail = previous.catch(() => {}).then(() => done);
    tails.set(key, tail);
    try {
      await previous.catch(() => {});
      return await fn();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

/** Maps with at most `limit` calls in flight, keeping order. */
export async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** Distinct values in first-seen order. */
export function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

/** A plain JSON object (not an array, not null). */
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Lower-cased media type without parameters. */
export function essence(mediaType: string): string {
  return mediaType.split(';')[0].trim().toLowerCase();
}
