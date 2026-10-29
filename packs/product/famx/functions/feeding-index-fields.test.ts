import assert from 'node:assert/strict';
import { test } from 'node:test';
import project from './feeding.ts';
import { PRODUCT_LINE } from './naming.ts';
import { kityminderParser } from '../../../../hub/testing/parsers.ts';

function rows(title = 'Synthetic case A') {
  const model = kityminderParser.parse(Buffer.from(JSON.stringify({ root: { data: { id: 'root', text: 'Synthetic root' }, children: [
    { data: { id: 'group', text: 'Synthetic group' }, children: [
      { data: { id: 'duplicate', text: title, priority: 2, resource: ['functional'] }, children: [{ data: { text: 'system show' }, children: [{ data: { text: 'Synthetic expected A' } }] }] },
      { data: { id: 'duplicate', text: 'Synthetic case B', priority: 2, resource: ['functional'] }, children: [{ data: { text: 'system show' }, children: [{ data: { text: 'Synthetic expected B' } }] }] },
    ] },
  ] } }))).model;
  const out = project({ product: PRODUCT_LINE.id, root: null, parser: 'kityminder@1', model,
    source: { system: 'agile', type: 'mindmap', key: 'SYN-DOC', bytes: 'a'.repeat(64) },
    meta: { root: { id: 'SYN-ROOT', title: PRODUCT_LINE.names[0] }, ancestors: ['060：10.8'] },
  }) as { rows: Array<{ body: Record<string, any>; identity: unknown; missing?: Array<{missing:string;next_action:string}> }> };
  return out.rows;
}

test('case source fields preserve exact titles, ancestors and duplicate-id selectors', () => {
  const out = rows();
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(row => row.body.node_key), ['duplicate#1', 'duplicate#2']);
  assert.deepEqual(out.map(row => row.body.node_selector), ['i/0/0', 'i/0/1']);
  assert.deepEqual(out.map(row => row.body.node_parser), ['kityminder@1', 'kityminder@1']);
  assert.deepEqual(out.map(row => row.body.title), ['Synthetic case A', 'Synthetic case B']);
  assert.deepEqual(out[0].body.path_labels, ['Synthetic root', 'Synthetic group']);
  assert.equal(out[0].body.command_tree_root, null);
  assert.equal(out[0].body.has_expected, true);
});

test('a blank expected node is not counted as an authored expectation', () => {
  const model = kityminderParser.parse(Buffer.from(JSON.stringify({ root: { data: { text: 'Synthetic root' }, children: [
    { data: { id: 'case', text: 'Synthetic case', priority: 2, resource: ['functional'] }, children: [
      { data: { text: 'system show' }, children: [{ data: { text: ' \u0085\t' } }] },
    ] },
  ] } }))).model;
  const out = project({ product: PRODUCT_LINE.id, root: null, parser: 'kityminder@1', model,
    source: { system: 'agile', type: 'mindmap', key: 'SYN-DOC', bytes: 'a'.repeat(64) },
    meta: { root: { id: 'SYN-ROOT', title: PRODUCT_LINE.names[0] }, ancestors: ['060：10.8'] },
  }) as { rows: Array<{ body: Record<string, any> }> };
  assert.equal(out.rows[0].body.expects.length, 1);
  assert.equal(out.rows[0].body.has_expected, false);
});

test('a title beyond the record limit stays local and has a missing fact and next action', () => {
  const out = rows('x'.repeat(1048577));
  assert.equal(out.length, 2);
  assert.equal(Object.hasOwn(out[0].body, 'title'), false);
  assert.ok(out[0].missing?.some(gap => gap.missing && gap.next_action));
  assert.equal(out[1].body.title, 'Synthetic case B');
});

test('only whole declared identifier fields supply case-to-story and case-to-defect links', () => {
  const model = kityminderParser.parse(Buffer.from(JSON.stringify({ root: { data: { id: 'root', text: 'Synthetic root' }, children: [
    { data: { id: 'group', text: 'story:7001' }, children: [
      { data: { id: 'case', text: 'mentions bug:8002 in prose', priority: 2, resource: ['functional'] }, children: [{ data: { text: 'system show' }, children: [{ data: { text: 'Synthetic expected' } }] }] },
    ] },
  ] } }))).model;
  const out = project({ product: PRODUCT_LINE.id, root: null, parser: 'kityminder@1', model,
    source: { system: 'agile', type: 'mindmap', key: 'SYN-DOC', bytes: 'a'.repeat(64) },
    meta: { root: { id: 'SYN-ROOT', title: PRODUCT_LINE.names[0] }, title: 'bug:8001', ancestors: ['060：10.8'] },
  }) as { rows: Array<{ body: Record<string, any> }> };
  assert.deepEqual(out.rows[0].body.stories, ['7001']);
  assert.deepEqual(out.rows[0].body.defects, ['8001']);
});

test('module comes from the layer immediately below a coded train', () => {
  const model = kityminderParser.parse(Buffer.from(JSON.stringify({ root: { data: { text: 'Synthetic root' }, children: [
    { data: { id: 'case', text: 'Synthetic case', priority: 2, resource: ['functional'] }, children: [{ data: { text: 'Synthetic step' }, children: [{ data: { text: 'Synthetic expected' } }] }] },
  ] } }))).model;
  const input = { product: PRODUCT_LINE.id, root: null, parser: 'kityminder@1', model,
    source: { system: 'agile', type: 'mindmap', key: 'SYN-DOC', bytes: 'a'.repeat(64) } };
  const run = (ancestors: string[]) => (project({ ...input, meta: { root: { id: 'SYN-ROOT', title: PRODUCT_LINE.names[0] }, ancestors } }) as { rows: Array<{ body: Record<string, any> }> }).rows[0].body;
  assert.equal(run(['060：10.8', '004：10.8-R1', '020：Synthetic module']).module, 'Synthetic module');
  assert.equal(run(['060：10.8', '10.8-R1', '020：Synthetic module']).module, null);
});
