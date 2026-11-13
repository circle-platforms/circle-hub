import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {ProductDeclaration} from '../../contracts/src/product.ts';
import type {KnowledgeRunReadPort} from '../ports.ts';
import type {RecordStore} from '../records/api.ts';
import {completeOperationDevice} from './operation-device.ts';
import {productVariableProblems} from './variables.ts';
import {TEST_KNOWLEDGE_READ_PORTS} from './testing/read-ports.ts';

test('injected run reads preserve predecessor device scope and refuse a device outside it',async()=>{
 const store={} as RecordStore,seen:string[]=[];
 const runs:KnowledgeRunReadPort={
  runById:async(received,id)=>{
   assert.equal(received,store);seen.push(id);
   return {body:id==='synthetic-operation'?{predecessor:'synthetic-booking'}:{groups:[{manifest:{beds:[{name:'synthetic-bed',devices:[{name:'synthetic-device'}]}]}}]}} as unknown as NonNullable<Awaited<ReturnType<KnowledgeRunReadPort['runById']>>>;
  },
  canViewRun:async()=>{throw new Error('device completion does not decide run visibility');},
 };
 assert.deepEqual(await completeOperationDevice(runs,store,{run:'synthetic-operation',device:'synthetic-device'}),{device:'synthetic-device',bed:'synthetic-bed'});
 assert.deepEqual(seen,['synthetic-operation','synthetic-booking']);
 await assert.rejects(completeOperationDevice(runs,store,{run:'synthetic-operation',device:'outside-device'}),{code:'SUBMISSION_SCHEMA_VIOLATION'});
});

test('injected existing schema compiler preserves product variable validation',()=>{
 const product={variables:[{name:'DEMO_COUNT',schema:{type:'integer',minimum:1}}],producers:[]} as unknown as ProductDeclaration;
 const reads=TEST_KNOWLEDGE_READ_PORTS.packReads;
 assert.deepEqual(productVariableProblems(reads,product,new Map([['DEMO_COUNT',1]])),[]);
 assert.equal(productVariableProblems(reads,product,new Map([['DEMO_COUNT',0]])).length,1);
 assert.equal(productVariableProblems(reads,product,new Map()).length,1);
});
