// The names offered when a workflow is asked for by a name the Hub does not have.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundedDistance, suggestNames, LISTED_NAMES, type NameCandidate } from './pack-names.ts';

const named = (...ids: string[]): NameCandidate[] => ids.map((id) => ({ id, pack: `${id}@1.0.0` }));

/** The plain dynamic-programming distance, to check the bounded one against. */
function levenshtein(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, column) => column);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    for (let column = 1; column <= right.length; column++) current[column] = Math.min(current[column - 1]! + 1, previous[column]! + 1, previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1));
    previous = current;
  }
  return previous[right.length]!;
}

test('the bounded distance is the edit distance up to the bound and one more beyond it', () => {
  assert.equal(boundedDistance('case-compile', 'case-compile', 2), 0);
  assert.equal(boundedDistance('case-compile', 'case-compil', 2), 1);
  assert.equal(boundedDistance('case-compile', 'case-kompile', 2), 1);
  assert.equal(boundedDistance('toy-reveiw', 'toy-review', 2), 2, 'a transposition is two edits');
  assert.equal(boundedDistance('abc', 'xyz', 2), 3);
  assert.equal(boundedDistance('', 'ab', 2), 2);
  assert.equal(boundedDistance('', 'abc', 2), 3);
  assert.equal(boundedDistance('a', 'a'.repeat(1_000_000), 2), 3, 'a name far longer than the other is answered by its length');
  const alphabet = 'ab-';
  const sample = (seed: number): string => Array.from({ length: seed % 7 }, (_, i) => alphabet[(seed * (i + 3) + i) % 3]).join('');
  for (let a = 0; a < 60; a++) for (let b = 0; b < 60; b++) {
    const exact = levenshtein(sample(a), sample(b));
    assert.equal(boundedDistance(sample(a), sample(b), 2), Math.min(exact, 3), `${sample(a)} / ${sample(b)}`);
  }
});

test('a name within a few edits of one name only is the one meant, and a version after it does not matter', () => {
  const names = named('case-compile', 'recompose', 'test-bed');
  assert.equal(suggestNames('case-compil', names).nearest?.pack, 'case-compile@1.0.0');
  assert.equal(suggestNames('Case-Compile@9.9.9', names).nearest?.pack, 'case-compile@1.0.0', 'letter case and a version that does not exist');
  assert.equal(suggestNames('recomopse', names).nearest?.pack, 'recompose@1.0.0');
});

test('two names equally near, a name too far or a short name with a wide gap is no match, and the nearest few are listed instead', () => {
  const twins = suggestNames('case-compila', named('case-compile', 'case-compilo', 'test-bed'));
  assert.equal(twins.nearest, null, 'which of two equally near names is meant is not for the Hub to pick');
  assert.deepEqual(twins.listed.slice(0, 2), ['case-compile@1.0.0', 'case-compilo@1.0.0']);
  assert.equal(suggestNames('no-such-flow', named('case-compile', 'test-bed')).nearest, null);
  assert.equal(suggestNames('abc', named('xbc2')).nearest, null, 'two edits on a short name is a different name');
  assert.equal(suggestNames('abc', named('abd')).nearest?.id, 'abd', 'one edit on a short name is not');
  const many = suggestNames('zzzz', named(...Array.from({ length: 12 }, (_, i) => `flow-${String.fromCharCode(97 + i)}`)));
  assert.equal(many.nearest, null);
  assert.equal(many.listed.length, LISTED_NAMES);
  assert.equal(many.total, 12);
});

test('nothing to offer gives nothing, and the same name twice is counted once', () => {
  assert.deepEqual(suggestNames('anything', []), { nearest: null, listed: [], total: 0 });
  const twice = suggestNames('test-bed', [...named('test-bed'), ...named('test-bed')]);
  assert.equal(twice.total, 1);
  assert.equal(twice.nearest?.pack, 'test-bed@1.0.0');
});
