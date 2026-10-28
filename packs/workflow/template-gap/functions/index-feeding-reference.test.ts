import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readCaseIndex } from './index.ts';
import { isFailure } from './common.ts';
import { bindIndex, digest, indexView, LOCK } from '../testing/index.ts';

function viewWith(reference: string) {
  const view = indexView([{ document: '900001', node: 'case-1', commands: ['/commands/system/show'], title: 'Synthetic case', path_labels: ['Synthetic group'] }]);
  const entry = Object.values(view.entries)[0];
  entry.reference = reference;
  if(reference.startsWith('rec:')&&reference.length===68){delete view.entries[entry.entry];entry.entry=reference.slice(4);view.entries[entry.entry]=entry;view.keys['900001']=[entry.entry];}
  return view;
}
function read(reference: string) {
  return readCaseIndex({ inputs: [bindIndex(viewWith(reference))], context: LOCK }, ['900001']);
}

test('the frozen index accepts a feeding-record reference and preserves it', () => {
  const reference = 'rec:' + digest('synthetic projected case record');
  const result = read(reference);
  assert.ok(result && !isFailure(result));
  assert.equal(Object.values(result.entries)[0].reference, reference);
});

test('invalid record references and a foreign-root tree reference are still refused', () => {
  for (const reference of ['rec:bad', 'rec:' + 'a'.repeat(64) + '#/unrelated', 'tree:' + 'b'.repeat(64) + '/cases@' + 'a'.repeat(64)]) {
    const result = read(reference);
    assert.ok(result && isFailure(result));
    assert.equal(result.error.code, 'template-gap.index_invalid');
  }
  const view = indexView([{ document: '900001', node: 'case-1', commands: [], title: 'Synthetic case', path_labels: [] }]);
  Object.values(view.entries)[0].reference = 'rec:' + digest('a different record');
  const mismatch = readCaseIndex({ inputs: [bindIndex(view)], context: LOCK }, ['900001']);
  assert.ok(mismatch && isFailure(mismatch));
});
