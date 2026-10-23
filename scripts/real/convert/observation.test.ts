import assert from 'node:assert/strict';
import { test } from 'node:test';
import { definition } from '../../../hub/dispatch/testing/definition.ts';
import { canonicalBytes, sha256Hex } from '../../../hub/records/api.ts';
import { observation } from './observation.ts';
import { topology } from './testing.ts';
const reply = (id: number, value: unknown) => Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result: { structuredContent: { snapshot: value } } }));
test('configured pointer uses the dispatcher RFC 8785 and separates original bytes from content identity', () => {
  const raw = topology(); const d = { ...definition('http://127.0.0.1/mcp'), capture_pointers: ['/snapshot'] };
  const first = observation(reply(1, raw), d); const second = observation(reply(2, raw), d);
  assert.equal(first.hashes.pointer, '/snapshot'); assert.equal(first.hashes.canonical_content_sha256, sha256Hex(canonicalBytes(raw)));
  assert.notEqual(first.hashes.original_sha256, second.hashes.original_sha256); assert.equal(first.hashes.canonical_content_sha256, second.hashes.canonical_content_sha256); assert.deepEqual(first.value, raw);
});
test('read selection and missing pointers are explicit and a mismatched declared digest cannot pass', () => {
  const d = { ...definition('http://127.0.0.1/mcp'), capture_pointers: ['/absent'], precheck_reads: [{ tool: 'inspect_slot', arguments: {}, capture_pointers: ['/snapshot'], conditions: [] }] };
  assert.throws(() => observation(reply(1, topology()), d)); assert.deepEqual(observation(reply(1, topology()), d, '1').value, topology());
  assert.throws(() => observation(reply(1, topology()), d, '-1')); assert.throws(() => observation(reply(1, topology()), d, '2'));
  assert.throws(() => observation(reply(1, topology()), { ...d, capture_pointers: ['/snapshot'], conditions: [{ pointer: '/snapshot', sha256: 'f'.repeat(64) }] }));
});
