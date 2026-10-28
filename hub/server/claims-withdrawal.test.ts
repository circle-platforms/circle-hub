import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Claim} from '../../contracts/src/claim.ts';
import {canonicalBytes} from '../records/api.ts';
import {claimFields} from './claims.ts';
const example=()=>Claim.parse({statement:{text:'合成观察',verdict:'support'},qualifier:{nature:'fact',provenance:'projected',basis_rank:'rule_over_claims',marks:[]},grounds:[],warrant:{producer:'function',id:'synthetic-rule@1'},validity:{status:'valid',bound:['a'.repeat(64)],premises:[]}});
const condition=(claim:Claim,withdrawn=false)=>claimFields(claim,withdrawn).find(([label])=>label==='有效条件')![1];
test('read-time withdrawal qualifies the effective-condition display without changing any claim byte',()=>{
 const claim=example(),before=canonicalBytes(claim);
 Object.freeze(claim.validity.bound);Object.freeze(claim.validity.premises);Object.freeze(claim.validity);Object.freeze(claim);
 const original=claimFields(claim),view=claimFields(claim,true);
 assert.ok(condition(claim,true).startsWith('规则已撤回（版本已下架）；记录时：'));
 assert.deepEqual(view.filter(([label])=>label!=='有效条件'),original.filter(([label])=>label!=='有效条件'));
 assert.deepEqual(canonicalBytes(claim),before);
 assert.deepEqual(claimFields(claim,false),original);
});
test('read-time withdrawal preserves the recorded validity reason and expiry',()=>{
 const claim=example();claim.validity.status='premise_failed';claim.validity.expires_at='2030-01-01T00:00:00.000Z';
 const original=condition(claim),before=canonicalBytes(claim);
 assert.ok(condition(claim,true).endsWith('记录时：'+original));
 assert.deepEqual(canonicalBytes(claim),before);
});
test('mentioning withdrawal in authored prose never changes the effective condition',()=>{
 const claim=example();claim.statement.text='模型原文提及规则已撤回（版本已下架）';
 assert.ok(condition(claim).startsWith('有效'));
 assert.ok(!condition(claim).startsWith('规则已撤回'));
});
