// The definition diff: field by field, both values, top-level ignore list, order of keys and of entries does not matter.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { definitionDiff } from './diff.ts';

describe('definition diff', () => {
  it('lists a changed field with both values', () => {
    assert.deepEqual(definitionDiff([{ help: '旧帮助' }], [{ help: '新帮助' }], []), [{ path: '/help', before: '旧帮助', after: '新帮助' }]);
  });

  it('walks into arrays', () => {
    const before = [{ name: 'show', args: [{ name: 'n', type: 'string' }] }];
    const after = [{ name: 'show', args: [{ name: 'n', type: 'integer' }] }];
    assert.deepEqual(definitionDiff(before, after, []), [{ path: '/args/0/type', before: 'string', after: 'integer' }]);
  });

  it('ignores a top-level field and not a nested one of the same name', () => {
    assert.deepEqual(definitionDiff([{ name: 'show', help: '旧' }], [{ name: 'show', help: '新' }], ['help']), []);
    assert.deepEqual(definitionDiff([{ nested: { help: '旧' } }], [{ nested: { help: '新' } }], ['help']), [{ path: '/nested/help', before: '旧', after: '新' }]);
  });

  it('treats a missing key as different from null', () => {
    assert.deepEqual(definitionDiff([{ a: null }], [{}], []), [{ path: '/a', before: null, after: null, absent: 'after' }]);
    assert.deepEqual(definitionDiff([{}], [{ a: null }], []), [{ path: '/a', before: null, after: null, absent: 'before' }]);
  });

  it('does not treat key order or a swap of equal definitions as a change', () => {
    assert.deepEqual(definitionDiff([{ b: 1, a: 2 }], [{ a: 2, b: 1 }], []), []);
    assert.deepEqual(definitionDiff([{ n: 1 }, { n: 2 }], [{ n: 2 }, { n: 1 }], []), []);
  });

  it('diffs several definitions as an array, and escapes pointer tokens', () => {
    const fields = definitionDiff([{ n: 1 }, { n: 2 }], [{ n: 1 }, { n: 3 }], []);
    assert.deepEqual(fields, [{ path: '/1/n', before: 2, after: 3 }]);
    assert.deepEqual(definitionDiff([{ 'a/b': 1, 'a~b': 1 }], [{ 'a/b': 2, 'a~b': 2 }], []), [
      { path: '/a~1b', before: 1, after: 2 },
      { path: '/a~0b', before: 1, after: 2 },
    ]);
  });
});
