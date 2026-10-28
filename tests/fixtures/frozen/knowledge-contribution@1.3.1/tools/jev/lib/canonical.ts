import { createHash } from 'node:crypto';
export const sha256Hex = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
// RFC 8785 JSON Canonicalization Scheme (JCS). Input is JSON data: null, booleans, finite numbers, well-formed strings,
// arrays and plain objects. Numbers and strings use ECMAScript JSON.stringify serialization, which is what RFC 8785 specifies;
// object members are sorted by the UTF-16 code units of their names.

export class CanonicalizationError extends TypeError {
  readonly path: string;
  constructor(message: string, path: string) {
    super(`${message} at ${path === '' ? '/' : path}`);
    this.name = 'CanonicalizationError';
    this.path = path;
  }
}

const MAX_DEPTH = 1000;

/**
 * Canonical JSON text of `value`. Object members whose value is `undefined` are omitted (as JSON.stringify does);
 * everything else that is not JSON data is refused: NaN and infinities, lone surrogates, `undefined` or holes in arrays,
 * bigint, functions, symbols, cycles and objects that are not plain (Date, Map, Buffer, class instances).
 */
export function canonicalize(value: unknown): string {
  return write(value, '', 0, new Set<object>());
}

export function canonicalBytes(value: unknown): Uint8Array {
  return Buffer.from(canonicalize(value), 'utf8');
}

function pointer(path: string, key: string | number): string {
  return `${path}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function write(value: unknown, path: string, depth: number, stack: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalizationError('non-finite number', path);
      // JSON.stringify gives the shortest round-trip form and serializes -0 as 0 (RFC 8785 section 3.2.2.3).
      return JSON.stringify(value);
    case 'string':
      if (!value.isWellFormed()) throw new CanonicalizationError('string with a lone surrogate', path);
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new CanonicalizationError(`unsupported ${typeof value} value`, path);
  }
  if (depth >= MAX_DEPTH) throw new CanonicalizationError('nesting deeper than 1000 levels', path);
  const object = value as object;
  if (stack.has(object)) throw new CanonicalizationError('cyclic structure', path);
  stack.add(object);
  try {
    if (Array.isArray(object)) {
      const items: string[] = [];
      for (let index = 0; index < object.length; index++) {
        if (!(index in object) || object[index] === undefined) {
          throw new CanonicalizationError('undefined array element', pointer(path, index));
        }
        items.push(write(object[index], pointer(path, index), depth + 1, stack));
      }
      return `[${items.join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) throw new CanonicalizationError('not a plain object', path);
    const record = object as Record<string, unknown>;
    // Default sort compares UTF-16 code units, which is the order RFC 8785 section 3.2.3 requires.
    const keys = Object.keys(record).sort();
    const members: string[] = [];
    for (const key of keys) {
      const member = record[key];
      if (member === undefined) continue;
      if (!key.isWellFormed()) throw new CanonicalizationError('member name with a lone surrogate', path);
      members.push(`${JSON.stringify(key)}:${write(member, pointer(path, key), depth + 1, stack)}`);
    }
    return `{${members.join(',')}}`;
  } finally {
    stack.delete(object);
  }
}
