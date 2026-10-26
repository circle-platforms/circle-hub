import {submissionOrigin} from './independence.ts';
import {Submission} from '../../../contracts/src/submission.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountIndependenceOf, authorAccount, declaredFamily, independenceGap, independenceOf, warrantIndependence, type AuthorOrigin, type ProducerOrigin } from './independence.ts';

/** An author origin whose producers all declared a family id. */
const author = (sessions: string[], models: string[], families: string[] | null, complete = true): AuthorOrigin =>
  families === null
    ? { sessions: new Set(sessions), models: new Set(models), complete }
    : { sessions: new Set(sessions), models: new Set(models), families: new Set(families), familiesComplete: true, complete };

/** A producer that declared its model identity (model-identity@1). */
const producer = (sessions: (string | null)[], model: string | null, family?: string | null): ProducerOrigin => ({ sessions, model, family });

test('a family is what the client declared, taken exactly: no folding, no trimming, no name read', () => {
  assert.equal(declaredFamily('synthetic-family-a'), 'synthetic-family-a');
  assert.equal(declaredFamily(''), null, 'an empty declaration is no family');
  assert.equal(declaredFamily(null), null);
  assert.equal(declaredFamily(undefined), null);
  // Exact equality: a case, width or space difference is another declaration, not the same family written differently.
  assert.notEqual(declaredFamily('Family-A'), declaredFamily('family-a'));
  assert.equal(declaredFamily('ＦＡＭＩＬＹ'), 'ＦＡＭＩＬＹ', 'the value is kept as declared, not normalized');
});

test('one declared family is not independent, two declared families are, whatever the model names look like', () => {
  // Reproduces the retired rule in both directions: the names share no word, so the old comparison called them apart.
  const drafter = author(['s-draft', 's-draft-submit'], ['q7'], ['synthetic-family-a']);
  assert.equal(independenceOf(producer(['s-verify', 's-verify'], '4.1', 'synthetic-family-a'), drafter), 'not_independent');
  // The names share a provider word, so the old comparison called them one family; the declarations tell them apart.
  assert.equal(independenceOf(producer(['s-verify'], 'vendor/aster-grand-4-5', 'synthetic-family-b'), author(['s-draft'], ['eu.vendor.aster-swift-4-5-v1:0'], ['synthetic-family-a'])), 'independent');
  // The same family with another configuration, version or hosting prefix is still not independent (A04 F[2]).
  assert.equal(independenceOf(producer(['s-verify'], 'aster-7 temperature=1', 'synthetic-family-a'), drafter), 'not_independent');
  assert.equal(independenceOf(producer(['s-verify'], 'aster-7-20261001', 'synthetic-family-a'), drafter), 'not_independent');
  // Every author counts: a second drafter's declared family is just as dependent.
  assert.equal(independenceOf(producer(['s-verify'], 'cedar-1', 'synthetic-family-c'), author(['s-draft'], ['aster-7', 'cedar-3'], ['synthetic-family-a', 'synthetic-family-c'])), 'not_independent');
  // The same observed session anywhere is known not to be independent, whatever the families declare.
  assert.equal(independenceOf(producer(['s-verify', 's-draft-submit'], 'birch-2', 'synthetic-family-b'), drafter), 'not_independent');
});

test('one exactly equal declared model id is not independent, and a name one character apart is no evidence', () => {
  const drafter = author(['s-draft'], ['aster-7 temperature=0'], null);
  // The same declared id, byte for byte: the same model, so not independent. No folding is involved.
  assert.equal(independenceOf(producer(['s-verify'], 'aster-7 temperature=0'), drafter), 'not_independent');
  // Another configuration, another case, a dated alias: names are not compared, so nothing is concluded either way.
  for (const model of ['aster-7 temperature=1', 'ASTER-7 temperature=0', 'aster-7-20261001', ' aster-7 temperature=0']) {
    assert.equal(independenceOf(producer(['s-verify'], model), drafter), 'unknown', model);
  }
});

test('without a declared family on both sides independence is unknown, and nothing is back-filled', () => {
  const drafter = author(['s-draft', 's-draft-submit'], ['aster-7 temperature=0'], ['synthetic-family-a']);
  // An unobserved session on either side leaves independence unknown.
  assert.equal(independenceOf(producer([null, 's-verify'], 'birch-2', 'synthetic-family-b'), drafter), 'unknown');
  assert.equal(independenceOf(producer(['s-verify'], 'birch-2', 'synthetic-family-b'), author(['s-draft'], ['aster-7'], ['synthetic-family-a'], false)), 'unknown');
  // This side declared no family: a differing model name proves nothing.
  for (const family of [undefined, null, '']) {
    assert.equal(independenceOf(producer(['s-verify'], 'birch-2', family), drafter), 'unknown', JSON.stringify(family));
  }
  // An author side that declared none, or not for every producer, cannot be told apart either.
  assert.equal(independenceOf(producer(['s-verify'], 'birch-2', 'synthetic-family-b'), author(['s-draft'], ['aster-7'], null)), 'unknown');
  assert.equal(independenceOf(producer(['s-verify'], 'birch-2', 'synthetic-family-b'), { sessions: new Set(['s-draft']), models: new Set(['aster-7']), families: new Set<string>(), familiesComplete: false, complete: true }), 'unknown');
  // An author without a known model, and no author at all (A04 R[5]).
  assert.equal(independenceOf(producer(['s-verify'], 'birch-2', 'synthetic-family-b'), author(['s-draft'], [], ['synthetic-family-a'], false)), 'unknown');
  assert.equal(independenceOf(producer(['s-verify', 's-verify'], 'birch-2', 'synthetic-family-b'), null), 'unknown');
});

test('an unknown names the missing declaration and who supplies it, and never turns into a verdict', () => {
  const drafter = author(['s-draft'], ['aster-7'], ['synthetic-family-a']);
  const undeclared = independenceGap(producer(['s-verify'], 'birch-2', null), drafter)!;
  assert.match(undeclared.missing, /model_family_id/);
  assert.match(undeclared.next, /model-identity@1/);
  assert.match(undeclared.next, /不从模型名推族/);
  assert.match(independenceGap(producer(['s-verify'], 'birch-2', 'synthetic-family-b'), author(['s-draft'], ['aster-7'], null))!.missing, /作者没有完整声明模型族/);
  assert.match(independenceGap(producer(['s-verify'], 'birch-2', 'synthetic-family-b'), null)!.missing, /作者来源/);
  assert.match(independenceGap(producer([null], 'birch-2', 'synthetic-family-b'), drafter)!.missing, /观察会话/);
  assert.match(independenceGap(producer(['s-verify'], 'birch-2', 'synthetic-family-b'), author(['s-draft'], ['aster-7'], ['synthetic-family-a'], false))!.missing, /产出者不完整/);
  // A finding that rests on nothing missing has no gap, and the warrant values stay the closed vocabulary's.
  assert.equal(independenceGap(producer(['s-verify'], 'birch-2', 'synthetic-family-b'), drafter), null);
  assert.equal(warrantIndependence('independent'), 'model_family_declared');
  assert.equal(warrantIndependence('independent', true), 'human_non_author');
  assert.equal(warrantIndependence('not_independent'), 'not_independent');
  assert.equal(warrantIndependence('unknown'), 'unknown');
});

test('W10 independence stays an account the Hub can verify: a declared family never stands in for it', () => {
  const authors = { accounts: new Set(['synthetic-author']), complete: true };
  assert.equal(accountIndependenceOf('synthetic-author', authors), 'not_independent', 'the author themself');
  assert.equal(accountIndependenceOf('synthetic-reviewer', authors), 'independent');
  assert.equal(accountIndependenceOf('', authors), 'unknown', 'an account the Hub does not know is unknown, not independent');
  assert.equal(accountIndependenceOf('synthetic-reviewer', { accounts: new Set(['synthetic-author']), complete: false }), 'unknown');
  assert.equal(accountIndependenceOf('synthetic-reviewer', null), 'unknown');
  // A different declared family does not make an author account independent, and the account rule reads no model at all.
  const authorRun = { runner: 'synthetic-author', configurer: 'synthetic-configurer' };
  assert.equal(authorAccount(authorRun), 'synthetic-author');
  assert.equal(authorAccount({ runner: null, configurer: 'synthetic-configurer' } as never), 'synthetic-configurer', 'a delegated execution keeps its configuring account as the author');
  assert.equal(accountIndependenceOf(authorAccount(authorRun) ?? '', authors), 'not_independent');
});

test('submission identity is explicit and legacy display names never supply a family',()=>{
 const legacy={run:'run_0'+ 'a'.repeat(25),model:'synthetic display',items:[]};
 assert.equal(Submission.safeParse(legacy).success,true);
 assert.deepEqual(submissionOrigin(legacy,['s']),{sessions:['s'],model:'synthetic display',family:null});
 const modern={...legacy,model_identity:{model_id:'synthetic-id',model_family_id:'synthetic-family'}};
 assert.equal(Submission.safeParse(modern).success,true);
 assert.deepEqual(submissionOrigin(modern,['s']),{sessions:['s'],model:'synthetic-id',family:'synthetic-family'});
 for(const model_identity of [{model_id:'synthetic-id'},{model_id:'synthetic-id',model_family_id:''},{model_id:'synthetic-id',model_family_id:'synthetic-family',extra:true}])assert.equal(Submission.safeParse({...legacy,model_identity}).success,false);
});
