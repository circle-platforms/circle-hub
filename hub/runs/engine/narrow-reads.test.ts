import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CheckReads } from '../../../contracts/src/pack.ts';

const narrow = { slot: 'lookup', key_path: '/lookup_keys', into: '/lookup', max_keys: 3, max_entries: 5 };
test('checks can opt into bounded item-key index reads without changing legacy reads', () => {
  assert.equal(CheckReads.safeParse({ roles: ['expected'], narrow }).success, true);
  assert.equal(CheckReads.safeParse({ roles: ['expected'] }).success, true);
});
for (const patch of [{ key_path: '/__proto__/keys' }, { into: '/' }, { max_keys: 1001 }, { max_entries: 0 }, { key_path: '$.keys[*]' }]) {
  test(`narrow reads reject unsafe or unbounded declarations ${JSON.stringify(patch)}`, () => {
    assert.equal(CheckReads.safeParse({ roles: ['expected'], narrow: { ...narrow, ...patch } }).success, false);
  });
}

import { narrowSubjectRead, type NarrowReadIO } from './narrow-reads.ts';
const root = 'a'.repeat(64);
const external = `knowledge:index:sample:build?kind=case&key=topic&fields=title,topic@${root}`;
const view = (patch = {}) => ({ schema: 'index-view@1', product: 'sample', build: { build: 'build', root }, kind: 'case', key: 'topic', keys: { 'alpha beta': [] }, entries: {}, total_keys: 1, total_entries: 0, truncated: false, skipped: 0, notes: [], ...patch });
function io(response = view(), patch: Partial<NarrowReadIO> = {}): NarrowReadIO & { calls: string[] } {
  const calls: string[] = [];
  return { calls, binding: { reference: `src:${root}`, external }, boundText: JSON.stringify(view()),
    read: async id => { calls.push(id); return { text: JSON.stringify(response), reference: `src:${'b'.repeat(64)}`, revision: root, manifest: 'receipt' }; }, ...patch };
}
test('narrows only the bound revision, preserves comma syntax, encodes keys and returns its receipt', async () => {
  const port = io(); const subject = { lookup_keys: ['alpha beta', 'alpha beta'], lookup: { stale: true } };
  const result = await narrowSubjectRead(narrow, subject, 1024, port);
  assert.equal(port.calls[0], external.replace(`@${root}`, `&only=alpha%20beta@${root}`));
  assert.deepEqual(result.subject, { ...subject, lookup: view() });
  assert.deepEqual(result.unread, []); assert.equal(result.manifest, 'receipt');
  assert.equal(subject.lookup.stale, true);
});
for (const [name, response] of Object.entries({ missing: view({ keys: {} }), truncated: view({ truncated: true }), skipped: view({ skipped: 1 }), cut: view({ cut_keys: ['alpha beta'] }), moved: view({ build: { build: 'build', root: 'c'.repeat(64) } }), wrongProduct: view({ product: 'other' }) })) {
  test(`incomplete or unpinned narrowed view is unknown with an actionable gap: ${name}`, async () => {
    const result = await narrowSubjectRead(narrow, { lookup_keys: ['alpha beta'], lookup: 'stale' }, 4096, io(response));
    assert.ok(result.unread.length); assert.ok(result.unread.every(row => row.missing_fact && row.next_action));
    if (name === 'moved' || name === 'wrongProduct') assert.equal((result.subject as any).lookup, null);
  });
}
for (const keys of [undefined, [], ['a', 'b', 'c', 'd'], ['a', 1]]) {
  test(`missing or over-budget subject keys do not initiate an unbounded read: ${JSON.stringify(keys)}`, async () => {
    const port = io(); const result = await narrowSubjectRead(narrow, { lookup_keys: keys, lookup: 'stale' }, 4096, port);
    assert.equal(port.calls.length, 0); assert.ok(result.unread.length); assert.equal((result.subject as any).lookup, null);
  });
}
test('a complete narrowed view may omit a requested key that has no entries', async () => {
  const response = view({ keys: {}, entries: {}, only: ['alpha beta'], total_keys: 0, total_entries: 0, cut_keys: [] });
  const result = await narrowSubjectRead(narrow, { lookup_keys: ['alpha beta'] }, 4096, io(response));
  assert.deepEqual(result.unread, []);
  assert.deepEqual((result.subject as { lookup: { keys: object } }).lookup.keys, {});
});
test('rebind replaces a disjoint bound only with the subject keys on the same revision', async () => {
  const response = view({ keys: {}, entries: {}, only: ['alpha beta'], total_keys: 0, total_entries: 0, cut_keys: [] });
  const port = io(response, { boundText: JSON.stringify(view({ only: ['user'], keys: {}, entries: {}, total_keys: 0, total_entries: 0 })) });
  const result = await narrowSubjectRead({ ...narrow, rebind: true }, { lookup_keys: ['alpha beta'] }, 4096, port);
  assert.equal(port.calls.length, 1);
  assert.match(port.calls[0], /only=alpha%20beta@/);
  assert.deepEqual(result.unread, []);
});
test('cannot widen an already restricted view or trust an unavailable/oversized read', async () => {
  for (const patch of [
    { boundText: JSON.stringify(view({ only: ['other'] })) },
    { read: async () => { throw new Error('private provider text'); } },
    { read: async () => ({ text: 'x'.repeat(4097), reference: 'src:response', revision: root, manifest: 'receipt' }) },
    { boundText: null },
  ]) {
    const result = await narrowSubjectRead(narrow, { lookup_keys: ['alpha beta'] }, 4096, io(view(), patch));
    assert.ok(result.unread.length); assert.ok(!JSON.stringify(result).includes('private provider text'));
  }
});

test('entry caps retain visible entries but never claim complete coverage', async () => {
  const entries = Object.fromEntries(['b', 'c'].map(char => {
    const entry = char.repeat(64);
    return [entry, { entry, kind: 'case', statement: '合成条目', data: {}, reference: `tree:${root}/lookup@${entry}` }];
  }));
  const response = view({ entries, keys: { 'alpha beta': Object.keys(entries) }, total_entries: 2 });
  const result = await narrowSubjectRead({ ...narrow, max_entries: 1 }, { lookup_keys: ['alpha beta'] }, 4096, io(response));
  assert.equal(Object.keys((result.subject as any).lookup.entries).length, 1);
  assert.equal((result.subject as any).lookup.truncated, true); assert.ok(result.unread.length);
});
