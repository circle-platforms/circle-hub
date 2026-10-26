// RFC 8785 canonical JSON. A bounded sink avoids retaining a serialized string for every subtree.
export class CanonicalizationError extends TypeError {
  readonly path: string;
  constructor(message: string, path: string) {
    super(`${message} at ${path === '' ? '/' : path}`);
    this.name = 'CanonicalizationError';
    this.path = path;
  }
}

const MAX_DEPTH = 1000;
const CHUNK_CHARS = 32 * 1024;

/** Strict JCS text. Undefined object members are omitted; other non-JSON data is refused. */
export function canonicalize(value: unknown): string {
  return createCanonicalEncoder().text(value);
}

/** Strict JCS UTF-8 without a whole-answer intermediate string. */
export function canonicalBytes(value: unknown): Uint8Array {
  return createCanonicalEncoder().bytes(value);
}

/** Exact size with the same validation, without allocating the serialized answer. */
export function canonicalByteLength(value: unknown): number {
  return createCanonicalEncoder().size(value);
}

/** Reuse traversal scratch space and a bounded member-name cache within one synchronous operation. */
export function createCanonicalEncoder(): { text(value: unknown): string; bytes(value: unknown): Uint8Array; size(value: unknown): number; } {
  const stack: object[] = [];
  const path: Array<string | number> = [];
  const keys = new Map<string, string>();
  const strings: string[] = [];
  const buffers: Buffer[] = [];
  let pending = '';
  let length = 0;
  let mode: 'text' | 'bytes' | 'size' = 'text';
  let active = false;
  const fail = (message: string): never => {
    throw new CanonicalizationError(message, path.map(key => '/' + String(key).replace(/~/g, '~0').replace(/\//g, '~1')).join(''));
  };
  const flush = (): void => {
    if (!pending) return;
    if (mode === 'text') strings.push(pending);
    else {
      const bytes = Buffer.from(pending, 'utf8');
      buffers.push(bytes);
      length += bytes.length;
    }
    pending = '';
  };
  const emit = (text: string): void => {
    if (mode === 'size') { length += Buffer.byteLength(text, 'utf8'); return; }
    pending += text;
    if (pending.length >= CHUNK_CHARS) flush();
  };
  const visit = (value: unknown, depth: number): void => {
    if (value === null) { emit('null'); return; }
  switch (typeof value) {
      case 'boolean': emit(value ? 'true' : 'false'); return;
    case 'number':
        if (!Number.isFinite(value)) fail('non-finite number');
        emit(JSON.stringify(value)); return;
    case 'string':
        if (!value.isWellFormed()) fail('string with a lone surrogate');
        emit(JSON.stringify(value)); return;
      case 'object': break;
      default: fail(`unsupported ${typeof value} value`);
  }
    if (depth >= MAX_DEPTH) fail('nesting deeper than 1000 levels');
  const object = value as object;
    if (stack.includes(object)) fail('cyclic structure');
    stack.push(object);
  try {
    if (Array.isArray(object)) {
        emit('[');
        for (let i = 0; i < object.length; i++) {
          path.push(i);
          if (!(i in object) || object[i] === undefined) fail('undefined array element');
          if (i) emit(',');
          visit(object[i], depth + 1);
          path.pop();
        }
        emit(']'); return;
    }
    const prototype = Object.getPrototypeOf(object);
      if (prototype !== Object.prototype && prototype !== null) fail('not a plain object');
    const record = object as Record<string, unknown>;
      let comma = false;
      emit('{');
      const names = Object.keys(record);
      // V8's general Array.sort allocates a sort state even for a three-field projected entry.
      // Insertion sort has the same UTF-16 order and no scratch allocation for these small objects.
      if (names.length <= 16) {
        for (let i = 1; i < names.length; i++) {
          const name = names[i]; let j = i;
          while (j > 0 && names[j - 1] > name) { names[j] = names[j - 1]; j--; }
          names[j] = name;
        }
      } else names.sort();
      for (const key of names) {
      const member = record[key];
      if (member === undefined) continue;
        if (!key.isWellFormed()) fail('member name with a lone surrogate');
        path.push(key);
        let encoded = keys.get(key);
        if (encoded === undefined) {
          encoded = JSON.stringify(key) + ':';
          if (keys.size < 256) keys.set(key, encoded);
    }
        if (comma) emit(',');
        emit(encoded); comma = true;
        visit(member, depth + 1);
        path.pop();
  }
      emit('}');
    } finally { stack.pop(); }
  };
  const run = (value: unknown, nextMode: typeof mode): void => {
    if (active) throw new TypeError('canonical encoder is already writing');
    active = true;
    mode = nextMode; pending = ''; length = 0;
    strings.length = 0; buffers.length = 0; path.length = 0; stack.length = 0;
    try { visit(value, 0); flush(); }
    finally { active = false; path.length = 0; stack.length = 0; }
  };
  return {
    text(value) { run(value, 'text'); return strings.join(''); },
    bytes(value) { run(value, 'bytes'); return buffers.length === 1 ? buffers[0] : Buffer.concat(buffers, length); },
    size(value) { run(value, 'size'); return length; },
  }
}
