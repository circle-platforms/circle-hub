import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContributionRelationRecord, ContributionSource, KnowledgeContributionBody } from './contributions.ts';
test('stored contribution sources allow only observed or projected provenance',()=>{
  const source={reference:`src:${'a'.repeat(64)}`,quote:'synthetic',fragment:'b'.repeat(64),records:['c'.repeat(64)],sources:['a'.repeat(64)]};
  for(const provenance of ['observed','projected'])assert.ok(ContributionSource.safeParse({...source,provenance}).success);
  for(const provenance of ['candidate','declared'])assert.equal(ContributionSource.safeParse({...source,provenance}).success,false);
});
test('the stored relation schema is the one shared with record readers',()=>{
  assert.equal(KnowledgeContributionBody.shape.relation.unwrap(),ContributionRelationRecord);
  assert.equal(ContributionRelationRecord.shape.other,ContributionSource);
});
