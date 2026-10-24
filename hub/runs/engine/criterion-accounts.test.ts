import assert from 'node:assert/strict';
import {test} from 'node:test';
import {authorAccount,accountIndependenceOf,warrantIndependence} from './independence.ts';
import {requirementStatus} from './terminals.ts';
test('the sole author-account selector preserves delegated runners and configured Hub actors',()=>{
 assert.equal(authorAccount({runner:'author',configurer:'operator'}),'author');assert.equal(authorAccount({configurer:'operator'}),'operator');assert.equal(authorAccount({}),null);
});
test('independence by account ignores the session and model family but never admits an author',()=>{
 const authors={accounts:new Set(['author','operator']),complete:true};
 assert.equal(accountIndependenceOf('reviewer',authors),'independent');assert.equal(accountIndependenceOf('author',authors),'not_independent');
 assert.equal(accountIndependenceOf('reviewer',{...authors,complete:false}),'unknown');
 assert.equal(warrantIndependence('independent',true),'human_non_author');
 const input={producer:'independent_judgment' as const,layers:[{layer:'static' as const,terminal:'pass' as const}],hasProducer:true,expectation:{outcome:'support' as const,codes:[]},expectedRefutation:false,acceptsDeclared:false,accountVerified:true};
 assert.equal(requirementStatus({...input,independence:'independent'}).status,'satisfied');
 assert.equal(requirementStatus({...input,independence:'not_independent',acceptsDeclared:true}).status,'unsatisfied');
});
