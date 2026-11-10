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
test('four items reuse one large source while distinct fragments and evaluations retain independent accounting',async()=>{
 const bytes=3*1024*1024,text='x'.repeat(bytes),reference='src:'+'a'.repeat(64),budget=new CheckReadBudget();
 for(let item=0;item<4;item++)for(let check=0;check<6;check++)await budget.read(reference,async()=>({text}));
 assert.equal(budget.references.size,1);assert.equal(budget.bytes,bytes);
 await budget.read(reference,async()=>({text:text+'more'}));assert.equal(budget.bytes,bytes+4);
 await budget.read(reference,async()=>({text:'short'}));assert.equal(budget.bytes,bytes+4);
 const fragment=reference+'/text@1/other';await budget.read(fragment,async()=>({text}));assert.equal(budget.references.size,2);assert.equal(budget.bytes,2*bytes+4);
 const other=new CheckReadBudget();await other.read(reference,async()=>({text}));assert.equal(other.bytes,bytes);assert.equal(budget.bytes,2*bytes+4);
 await assert.rejects(budget.read('src:'+'b'.repeat(64),async()=>({text:'y'.repeat(CHECK_READ_TOTAL_BYTES-budget.bytes+1)})),HubReadFailure);
 assert.equal(budget.bytes,2*bytes+4);
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
