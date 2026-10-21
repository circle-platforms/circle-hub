import assert from 'node:assert/strict';
import { test } from 'node:test';
import { familyWords, independenceOf, modelFamily, sameModelFamily, warrantIndependence, type AuthorOrigin } from './independence.ts';

const author = (sessions: string[], models: string[], complete = true): AuthorOrigin => ({ sessions: new Set(sessions), models: new Set(models), complete });

test('model name: the text before any configuration, ignoring case and width; its words are runs of two or more letters', () => {
  assert.equal(modelFamily('Model-A temperature=0'), 'model-a');
  assert.equal(modelFamily('  ｍｏｄｅｌ-a  '), 'model-a');
  assert.deepEqual(familyWords('aster-grand-4-5-20261001 thinking=on'), ['aster', 'grand']);
  assert.deepEqual(familyWords('eu.vendor.aster-swift-4-5-v1:0'), ['eu', 'vendor', 'aster', 'swift']);
  assert.deepEqual(familyWords('birch-k2-0905'), ['birch']);
  assert.deepEqual(familyWords('q7'), []);
});

test('model family: a shared word is one family, no shared word two, a name without a word cannot be told apart', () => {
  // a dated alias, another version and a hosting prefix of one model are one family (A04 F[2])
  assert.equal(sameModelFamily('aster-grand-4-5', 'aster-grand-4-5-20261001'), true);
  assert.equal(sameModelFamily('aster-grand-4-1', 'aster-grand-4-5'), true);
  assert.equal(sameModelFamily('vendor/aster-grand-4-5', 'ASTER-grand-4-5 temperature=1'), true);
  assert.equal(sameModelFamily('model-a', 'model-b'), true, 'a shared word is enough: the Hub errs towards not independent');
  assert.equal(sameModelFamily('aster-7 temperature=0', 'birch-2'), false);
  assert.equal(sameModelFamily('birch-k2-0905', 'cedar-4.6'), false);
  assert.equal(sameModelFamily('q7', 'birch-2'), null);
  assert.equal(sameModelFamily('birch-2', '4.1'), null);
});

test('independence from the author of the work under verification: sessions, model families, completeness', () => {
  const draft = author(['s-draft', 's-draft-submit'], ['aster-7 temperature=0']);
  assert.equal(independenceOf({ sessions: ['s-verify', 's-verify'], model: 'birch-2' }, draft), 'independent');
  // the same session anywhere is known not to be independent
  assert.equal(independenceOf({ sessions: ['s-verify', 's-draft-submit'], model: 'birch-2' }, draft), 'not_independent');
  // another configuration, a dated alias or another version of the same family is not independent (A04 F[2])
  assert.equal(independenceOf({ sessions: ['s-verify', 's-verify'], model: 'aster-7 temperature=1' }, draft), 'not_independent');
  assert.equal(independenceOf({ sessions: ['s-verify', 's-verify'], model: 'aster-7-20261001' }, draft), 'not_independent');
  // every author counts: a second drafter's family is just as dependent
  assert.equal(independenceOf({ sessions: ['s-verify'], model: 'cedar-1' }, author(['s-draft'], ['aster-7', 'cedar-3'])), 'not_independent');
  // an unobserved session on either side leaves independence unknown
  assert.equal(independenceOf({ sessions: [null, 's-verify'], model: 'birch-2' }, draft), 'unknown');
  assert.equal(independenceOf({ sessions: ['s-verify'], model: 'birch-2' }, author(['s-draft'], ['aster-7'], false)), 'unknown');
  // an author without a known model, or a model the Hub cannot tell apart, leaves it unknown
  assert.equal(independenceOf({ sessions: ['s-verify'], model: 'birch-2' }, author(['s-draft'], [], false)), 'unknown');
  assert.equal(independenceOf({ sessions: ['s-verify'], model: 'q7' }, draft), 'unknown');
  assert.equal(independenceOf({ sessions: ['s-verify'], model: null }, draft), 'unknown');
  // without an author the Hub knows (no predecessor: the target's author, A04 R[5]) independence is unknown
  assert.equal(independenceOf({ sessions: ['s-verify', 's-verify'], model: 'birch-2' }, null), 'unknown');
  assert.equal(warrantIndependence('independent'), 'model_family_declared');
  assert.equal(warrantIndependence('not_independent'), 'not_independent');
  assert.equal(warrantIndependence('unknown'), 'unknown');
});
