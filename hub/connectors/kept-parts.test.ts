// The parts a route keeps of a held answer: members at their places, and nothing a pointer could reach beyond the result.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { partsAt } from './read.ts';

test('the parts of an answer are the named members at their places, and a part the answer does not have is not invented', () => {
  const answer = { code: 1000, msg: 'ok', data: { id: 7, name: 'b', bug_detail: { resolved: ['x'.repeat(100)] } }, extra: true };
  assert.deepEqual(partsAt(answer, ['/code', '/msg', '/data/id', '/data/name']), { code: 1000, msg: 'ok', data: { id: 7, name: 'b' } });
  assert.deepEqual(partsAt(answer, ['/code', '/data/absent']), { code: 1000 });
  assert.deepEqual(partsAt({ 'a/b': { 'c~d': 1 } }, ['/a~1b/c~0d']), { 'a/b': { 'c~d': 1 } });
  assert.deepEqual(partsAt({ data: [{ name: 'x' }] }, ['/data/0/name']), {}, 'a position in an array names no fixed part');
  assert.deepEqual(partsAt({ a: 1 }, ['']), {}, 'the whole answer is no part of it');
});

test('a pointer through __proto__ or constructor stays inside the result', () => {
  const answer = JSON.parse('{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}}');
  const parts = partsAt(answer, ['/__proto__/polluted', '/constructor/prototype/polluted']);
  assert.equal(({} as Record<string, unknown>).polluted, undefined, 'Object.prototype is untouched');
  assert.equal(Object.getPrototypeOf(parts), Object.prototype);
  assert.deepEqual(JSON.parse(JSON.stringify(parts)), JSON.parse('{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}}'));
});
