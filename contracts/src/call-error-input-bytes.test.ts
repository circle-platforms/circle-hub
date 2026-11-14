// Protect raw published input blocks and descriptions; output additions may change all other bytes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

type Digest = { bytes: number; sha256: string };
function rawInputDigests(text: string): Record<string, { inputSchema: Digest; description: Digest }> {
  const digest = (value: string): Digest => ({ bytes: Buffer.byteLength(value), sha256: createHash('sha256').update(value).digest('hex') });
  const whitespace = (start: number): number => { while (/\s/u.test(text[start] ?? '') && start < text.length) start++; return start; };
  const stringEnd = (start: number): number => {
    assert.equal(text[start], '"');
    for (let i = start + 1; i < text.length; i++) {
      if (text[i] === '\\') i++;
      else if (text[i] === '"') return i + 1;
    }
    throw new Error('unterminated JSON string');
  };
  const valueEnd = (start: number): number => {
    if (text[start] === '"') return stringEnd(start);
    if (text[start] === '{' || text[start] === '[') {
      let depth = 0;
      for (let i = start; i < text.length; i++) {
        if (text[i] === '"') { i = stringEnd(i) - 1; continue; }
        if (text[i] === '{' || text[i] === '[') depth++;
        else if ((text[i] === '}' || text[i] === ']') && --depth === 0) return i + 1;
      }
      throw new Error('unterminated JSON container');
    }
    let end = start;
    while (end < text.length && !/[\s,}\]]/u.test(text[end])) end++;
    return end;
  };
  JSON.parse(text); // Reject invalid syntax before retaining raw, unnormalized slices.
  const out: ReturnType<typeof rawInputDigests> = {};
  let i = whitespace(0); assert.equal(text[i++], '[');
  while (text[i = whitespace(i)] !== ']') {
    assert.equal(text[i++], '{');
    const fields: Record<string, string> = {};
    while (text[i = whitespace(i)] !== '}') {
      const end = stringEnd(i), key = JSON.parse(text.slice(i, end)) as string;
      i = whitespace(end); assert.equal(text[i++], ':'); i = whitespace(i);
      const until = valueEnd(i); fields[key] = text.slice(i, until); i = whitespace(until);
      if (text[i] === ',') i++; else assert.equal(text[i], '}');
    }
    i++;
    out[JSON.parse(fields.name) as string] = { inputSchema: digest(fields.inputSchema), description: digest(fields.description) };
    i = whitespace(i); if (text[i] === ',') i++; else assert.equal(text[i], ']');
  }
  return out;
}

test('R7 retains every raw six-tool input block and description byte from cb05a8c97c', () => {
  const before = JSON.parse(readFileSync(new URL('./call-error-input-bytes.fixture.json', import.meta.url), 'utf8'));
  const current = rawInputDigests(readFileSync(new URL('../generated/tools.json', import.meta.url), 'utf8'));
  assert.equal(Object.keys(current).length, 6);
  assert.deepEqual(current, before.tools);
});
