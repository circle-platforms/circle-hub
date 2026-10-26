import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CheckReadBudget,CHECK_READ_CONCURRENCY,CHECK_READ_REFERENCES,CHECK_READ_TOTAL_BYTES} from './read-budget.ts';
import {HubReadFailure} from './retry-read.ts';
test('concurrent evaluations share a process-wide source gate and release capacity after a failure',async()=>{
 let active=0,peak=0,calls=0;
 await Promise.all(Array.from({length:3},async()=>{
  const budget=new CheckReadBudget();
  await Promise.allSettled(Array.from({length:20},(_,index)=>budget.read('src:'+index,async()=>{
   calls++;active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,1));active--;if(index===2)throw new Error('synthetic read fault');return {text:'synthetic'};
  })));
 }));
 assert.equal(calls,60);assert.equal(peak,CHECK_READ_CONCURRENCY);assert.equal(active,0);
});
test('reference and aggregate byte limits refuse excess I/O with missing fact and recovery; duplicates consume once',async()=>{
 const budget=new CheckReadBudget();let calls=0;
 for(let index=0;index<CHECK_READ_REFERENCES;index++)await budget.read('src:'+index,async()=>{calls++;return {text:'fixture'};});
 await assert.rejects(budget.read('src:overflow',async()=>{calls++;return {text:''};}),error=>error instanceof HubReadFailure&&error.message.includes('预算')&&error.fix.includes('拆分'));
 assert.equal(calls,CHECK_READ_REFERENCES);
 const sized=new CheckReadBudget(),text='x'.repeat(CHECK_READ_TOTAL_BYTES);
 await sized.read('src:same',async()=>({text}));await sized.read('src:same',async()=>({text}));assert.equal(sized.bytes,CHECK_READ_TOTAL_BYTES);
 await assert.rejects(sized.read('src:extra',async()=>({text:'x'})),HubReadFailure);
});
