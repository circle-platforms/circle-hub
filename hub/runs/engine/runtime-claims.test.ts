import assert from 'node:assert/strict';
import {test} from 'node:test';
import {factClaim} from './claims.ts';
const input={outcome:{verdict:'support' as const,statement:'合成结论',grounds:[],tier:'blocking' as const},rule:'运行内检查@'+'a'.repeat(64),judges:'subject' as const,overClaims:false,discrimination:true,bound:[]};
const runtime={admitted:true,admission:'rec:'+'b'.repeat(64)+'#/checks/0/samples',run:'c'.repeat(64),table:'a'.repeat(64),submission:'d'.repeat(64)};
test('admitted runtime claims cite contrast evidence and bind the table, submission and this run',()=>{
 const claim=factClaim({...input,runtime});
 assert.equal(claim.qualifier.discriminating_power,'established');
 assert.equal(claim.qualifier.marks.includes('discrimination_not_established'),false);
 assert.equal(claim.qualifier.marks.includes('conditional_on_judgment'),false);
 assert.ok(claim.grounds.includes(runtime.admission));
 assert.ok(claim.validity.bound.includes(runtime.run));
 assert.ok(claim.validity.bound.includes(runtime.table));
 assert.ok(claim.validity.bound.includes(runtime.submission));
 const another=factClaim({...input,runtime:{...runtime,run:'e'.repeat(64)}});
 assert.notDeepEqual(another.validity.bound,claim.validity.bound);
});
test('unadmitted runtime tables remain conditional even when the interpreter supports them',()=>{
 const claim=factClaim({...input,runtime:{...runtime,admitted:false}});
 assert.equal(claim.qualifier.discriminating_power,'not_established');
 assert.ok(claim.qualifier.marks.includes('conditional_on_judgment'));
 assert.ok(claim.qualifier.marks.includes('discrimination_not_established'));
});
