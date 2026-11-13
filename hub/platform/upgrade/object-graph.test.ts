import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalize, sha256Hex } from '../../records/api.ts';
import { expandSpaceObjectGraph } from './object-graph.ts';
import type { OldRecord } from './state.ts';

test('nested personal directories add every typed node to the payload closure', async () => {
  const nodes = new Map<string, Buffer>();
  const put = (body: unknown) => { const bytes = Buffer.from(canonicalize(body)), hash = sha256Hex(bytes); nodes.set(hash, bytes); return hash; };
  const leaf = put({ name: 'child', children: [], entries: [] });
  const root = put({ name: '', children: [{ name: 'child', digest: leaf }], entries: [] });
  const record = { digest: 'a'.repeat(64), schema: 'knowledge-space-version@1', body: { tree: root } } as OldRecord;
  const objects = new Set<string>();
  assert.deepEqual(await expandSpaceObjectGraph([record], new Set([record.digest]), objects, async hash => nodes.get(hash) ?? null), []);
  assert.deepEqual([...objects].sort(), [...nodes.keys()].sort());
});
test('a missing child fails by source row without silently losing the directory', async () => {
  const bytes = Buffer.from(canonicalize({ name: '', children: [{ name: 'child', digest: 'b'.repeat(64) }], entries: [] }));
  const root = sha256Hex(bytes);
  const record = { digest: 'a'.repeat(64), schema: 'knowledge-space-version@1', body: { tree: root } } as OldRecord;
  const issues = await expandSpaceObjectGraph([record], new Set([record.digest]), new Set(), async hash => hash === root ? bytes : null);
  assert.deepEqual(issues, [{ table: 'space_objects', row: 1, reason: '知识空间子树对象缺失、摘要不符或不合正式节点模式' }]);
});

test('a formally declared product mount is a record graph edge, never mistaken for a private node blob', async () => {
  const product = 'd'.repeat(64);
  const bytes = Buffer.from(canonicalize({ name: '', children: [{ name: 'product', digest: product }], entries: [] }));
  const root = sha256Hex(bytes);
  const record = { digest: 'a'.repeat(64), schema: 'knowledge-space-version@1', body: { tree: root, products: [{ path: '/product', root: product }] } } as OldRecord;
  const read: string[] = [], objects = new Set<string>();
  assert.deepEqual(await expandSpaceObjectGraph([record], new Set([record.digest]), objects, async hash => { read.push(hash); return hash === root ? bytes : null; }), []);
  assert.deepEqual(read, [root]);
  assert.equal(objects.has(product), false);
});
