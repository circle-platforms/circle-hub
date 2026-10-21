// RFC 8785 canonical JSON and the record digest, used to re-verify `rec:` references. hub/records owns the record
// digest; this copy exists because refs may import only contracts, and must stay identical in behaviour to
// hub/records/canonical.ts: the same output, and the same values refused.
import { createHash } from 'node:crypto';

const MAX_DEPTH = 1000;

function refused(message: string, path: string): TypeError {
  return new TypeError(`${message} at ${path === '' ? '/' : path}`);
}

function pointer(path: string, key: string | number): string {
  return `${path}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

/**
 * RFC 8785 (JCS): members sorted by UTF-16 code units, ECMAScript number and string serialization, no white space.
 * Object members whose value is `undefined` are omitted; everything else that is not JSON data throws a TypeError:
 * NaN and infinities, lone surrogates, `undefined` or holes in arrays, bigint, functions, symbols, cycles, nesting
 * deeper than 1000 levels and objects that are not plain (Date, Map, Buffer, class instances).
 */
export function canonicalJson(value: unknown): string {
  return write(value, '', 0, new Set<object>());
}

function write(value: unknown, path: string, depth: number, stack: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw refused('non-finite number', path);
      return JSON.stringify(value);
    case 'string':
      if (!value.isWellFormed()) throw refused('string with a lone surrogate', path);
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw refused(`unsupported ${typeof value} value`, path);
  }
  if (depth >= MAX_DEPTH) throw refused('nesting deeper than 1000 levels', path);
  const object = value as object;
  if (stack.has(object)) throw refused('cyclic structure', path);
  stack.add(object);
  try {
    if (Array.isArray(object)) {
      const items: string[] = [];
      for (let index = 0; index < object.length; index++) {
        if (!(index in object) || object[index] === undefined) throw refused('undefined array element', pointer(path, index));
        items.push(write(object[index], pointer(path, index), depth + 1, stack));
      }
      return `[${items.join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) throw refused('not a plain object', path);
    const record = object as Record<string, unknown>;
    const members: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const member = record[key];
      if (member === undefined) continue;
      if (!key.isWellFormed()) throw refused('member name with a lone surrogate', path);
      members.push(`${JSON.stringify(key)}:${write(member, pointer(path, key), depth + 1, stack)}`);
    }
    return `{${members.join(',')}}`;
  } finally {
    stack.delete(object);
  }
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Digest of a record: SHA-256 of the canonical JSON of {kind, schema, provenance, created_at, body}. */
export function recordDigest(record: { kind: string; schema: string; provenance: string; created_at: string; body: unknown }): string {
  return sha256Hex(canonicalJson({ kind: record.kind, schema: record.schema, provenance: record.provenance, created_at: record.created_at, body: record.body }));
}
