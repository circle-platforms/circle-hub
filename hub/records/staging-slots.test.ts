import assert from 'node:assert/strict';
import {test} from 'node:test';
import {stagingSlots} from './staging-slots.ts';
import {LimitError} from './errors.ts';
import {barrier} from '../testing/member-freeze.ts';

async function refusesImmediately(slots:ReturnType<typeof stagingSlots>,owner:string){
 const job=slots(owner,async()=>'ran').then(value=>({value}),error=>({error}));
 await new Promise(resolve=>setImmediate(resolve));
 const result=await Promise.race([job,Promise.resolve({pending:true})]);
 assert.ok('error' in result&&result.error instanceof LimitError,'overflow must be refused while accepted jobs are still held');
 assert.equal(result.error.code,null);assert.equal(result.error.message,'发布校验繁忙，请稍后重试');
}

test('a member has one running and at most two waiting checks while other members can progress',async()=>{
 const slots=stagingSlots(2),gate=barrier();let ran=0;
 const jobs=Array.from({length:3},()=>slots('synthetic-member',async()=>{ran++;await gate.promise;})),all=Promise.allSettled(jobs);
 try{
  assert.equal(ran,1);await refusesImmediately(slots,'synthetic-member');
  assert.equal(await slots('synthetic-other',async()=>42),42);assert.equal(ran,1);
 }finally{gate.release();await all;}
 assert.equal(ran,3);assert.ok((await all).every(item=>item.status==='fulfilled'));
 assert.equal(await slots('synthetic-member',async()=>24),24,'completion recovers capacity');
});

test('all members together have at most eight queued checks and refusal consumes no slot',async()=>{
 const slots=stagingSlots(2),gate=barrier();let ran=0;
 const jobs=Array.from({length:10},(_,n)=>slots('synthetic-'+n,async()=>{ran++;await gate.promise;})),all=Promise.allSettled(jobs);
 try{assert.equal(ran,2);await refusesImmediately(slots,'synthetic-excess');assert.equal(ran,2);}finally{gate.release();await all;}
 assert.equal(ran,10);assert.ok((await all).every(item=>item.status==='fulfilled'));assert.equal(await slots('synthetic-excess',async()=>42),42);
});
