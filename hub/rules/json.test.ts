import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JsonPath } from '../../contracts/src/tables.ts';
import { getAt, parseJsonPath, parsePointer, pointerOf, selectAll, stableJson } from './json.ts';

const doc = {
  items: [
    { id: 'a', tags: ['x', 'y'], 'odd/key~': 1 },
    { id: 'b', tags: [] },
  ],
  标题: '中文键',
  "it's": true,
};

describe('JSONPath subset', () => {
  it('selects members, indexes, wildcards and quoted names, with RFC 6901 pointers', () => {
    assert.deepEqual(selectAll(doc, '$.items[*].id'), [
      { pointer: '/items/0/id', value: 'a' },
      { pointer: '/items/1/id', value: 'b' },
    ]);
    assert.deepEqual(selectAll(doc, '$.items[-1].id'), [{ pointer: '/items/1/id', value: 'b' }]);
    assert.deepEqual(selectAll(doc, "$.items[0]['odd/key~']"), [{ pointer: '/items/0/odd~1key~0', value: 1 }]);
    assert.deepEqual(selectAll(doc, '$.标题'), [{ pointer: '/标题', value: '中文键' }]);
    assert.deepEqual(selectAll(doc, "$['it\\'s']"), [{ pointer: "/it's", value: true }]);
    assert.deepEqual(selectAll(doc, '$.items[0].tags.*'), [
      { pointer: '/items/0/tags/0', value: 'x' },
      { pointer: '/items/0/tags/1', value: 'y' },
    ]);
    assert.deepEqual(selectAll(doc, '$'), [{ pointer: '', value: doc }]);
    assert.deepEqual(selectAll(doc, '$.missing[*]'), []);
    assert.deepEqual(selectAll(doc, '$.items[5]'), []);
    assert.deepEqual(selectAll('text', '$.length'), []);
  });

  it('does not reach inherited members', () => {
    assert.deepEqual(selectAll({}, '$.constructor'), []);
    assert.deepEqual(selectAll([], '$.length'), []);
    const parsed = JSON.parse('{"__proto__": {"x": 1}}');
    assert.deepEqual(selectAll(parsed, '$.__proto__.x'), [{ pointer: '/__proto__/x', value: 1 }]);
  });

  it('refuses what is outside the subset, and agrees with the contract pattern', () => {
    for (const bad of ['', 'items', '$..id', '$[?(@.id)]', '$[0:2]', '$.', '$[', "$['a]", '$[01]', '$.1a', '$["\\x"]']) {
      assert.equal(parseJsonPath(bad), null, bad);
    }
    for (const good of ['$', '$.a.b', '$[*]', '$.a[*].b[0]', "$['a b']", '$["x\\"y"]', '$[-1]', '$.中文']) {
      assert.ok(parseJsonPath(good), good);
      assert.ok(JsonPath.safeParse(good).success, good);
    }
  });
});

describe('JSON Pointer', () => {
  it('reads values, escapes tokens, and treats missing members as not found', () => {
    assert.deepEqual(getAt(doc, '/items/0/odd~1key~0'), { found: true, value: 1 });
    assert.deepEqual(getAt(doc, ''), { found: true, value: doc });
    assert.equal(getAt(doc, '/items/2').found, false);
    assert.equal(getAt(doc, '/items/01').found, false);
    assert.equal(getAt(doc, '/items/-').found, false);
    assert.equal(getAt({}, '/toString').found, false);
    assert.equal(getAt(doc, 'items').found, false);
    assert.equal(getAt(doc, '/a~2').found, false);
    assert.deepEqual(getAt({ a: null }, '/a'), { found: true, value: null });
    assert.deepEqual(parsePointer('/a~1b/~0'), ['a/b', '~']);
    assert.equal(pointerOf(['a/b', '~', 3]), '/a~1b/~0/3');
  });

  it('stableJson sorts keys', () => {
    assert.equal(stableJson({ b: 1, a: [{ d: 1, c: 2 }] }), '{"a":[{"c":2,"d":1}],"b":1}');
  });
});
