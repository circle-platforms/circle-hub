import assert from 'node:assert/strict';
import { test } from 'node:test';
import project from './feeding.ts';
import { PRODUCT_LINE } from './naming.ts';
import { kityminderParser } from '../../../../hub/testing/parsers.ts';

const model = kityminderParser.parse(Buffer.from(JSON.stringify({
  root: { data: { id: 'root', text: 'Synthetic document' }, children: [
    { data: { id: 'case', text: 'Synthetic case', priority: 2, resource: ['functional'] }, children: [
      { data: { text: 'Synthetic action' }, children: [{ data: { text: 'Synthetic expected' } }] },
    ] },
  ] },
}))).model;

function projected(root: unknown, ancestors = ['060：10.8.1', '004：10.8.1-R1']) {
  const result = project({ product: PRODUCT_LINE.id, root: null, parser: 'kityminder@1', model,
    source: { system: 'agile', type: 'mindmap', key: 'SYN-DOC', bytes: 'a'.repeat(64) },
    meta: { root, ancestors },
  }) as { rows: Array<{ lines: string[]; body: {document_lines:string[]}; missing?: Array<{missing:string;next_action:string}> }> };
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

test('a source in either exactly declared product root can bind the version', () => {
  for (const name of PRODUCT_LINE.names) assert.deepEqual(projected({id:'SYN-ROOT',title:name}).lines, ['10.8.1']);
});

test('foreign, missing and case-variant roots cannot assign a case to this product line', () => {
  for (const root of [{id:'SYN-ROOT',title:'ORBIT'}, null, {id:'SYN-ROOT',title:PRODUCT_LINE.names[0].toLowerCase()}]) {
    const row = projected(root);
    assert.deepEqual(row.lines, []);
    assert.deepEqual(row.body.document_lines, []);
    assert.ok(row.missing?.some(gap => gap.missing && gap.next_action));
  }
});

test('a manual-looking folder under a foreign agile root cannot bypass product identity', () => {
  const row = projected({id:'SYN-ROOT',title:'ORBIT'}, ['rel_famx_10_8']);
  assert.deepEqual(row.lines, []);
  assert.ok(row.missing?.some(gap => gap.missing && gap.next_action));
});
