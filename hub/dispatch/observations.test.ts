import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalBytes, sha256Hex } from '../records/api.ts';
import { observationHashes } from './observations.ts';
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
test('conversion and dispatch hashes use the shared RFC 8785 implementation and exclude transport ids', () => {
  const one = bytes({ jsonrpc: '2.0', id: 1, result: { structuredContent: { topology: { z: 2, a: '合成' } } } });
  const two = bytes({ jsonrpc: '2.0', id: 88, result: { structuredContent: { topology: { a: '合成', z: 2 } } } });
  const first = observationHashes(one, '/topology'); const second = observationHashes(two, '/topology');
  assert.equal(first.pointer, '/topology'); assert.equal(first.original_sha256, sha256Hex(one));
  assert.notEqual(first.original_sha256, second.original_sha256);
  assert.equal(first.canonical_content_sha256, second.canonical_content_sha256);
  assert.equal(first.canonical_content_sha256, sha256Hex(canonicalBytes({ a: '合成', z: 2 })));
  assert.throws(() => observationHashes(one, '/missing'));
});
test('array tool values and SSE are decoded without inventing missing values', () => {
  const result = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '[{"a":1}]' }] } };
  assert.equal(observationHashes(bytes(result), '/0/a').canonical_content_sha256, sha256Hex(canonicalBytes(1)));
  const sse = new TextEncoder().encode(`event: message\ndata: ${JSON.stringify(result)}\n\n`);
  assert.equal(observationHashes(sse, '/0/a').canonical_content_sha256, observationHashes(bytes(result), '/0/a').canonical_content_sha256);
});
