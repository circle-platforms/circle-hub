import assert from 'node:assert/strict';
import test from 'node:test';
import {terminalInterpretationFacts,terminalPartialDelivery} from '../../packages/execution/src/flow-interpretation.ts';

const reference={kind:'artifact',artifactId:'art_synthetic',sha256:'1'.repeat(64),size:123};
const error={code:'SOURCE_HASH_MISMATCH',message:'Synthetic result SHA differs',details:{stage:'results'}};

test('A terminal interpretation failure records a gap without changing the observed device status',()=>{
 const facts=terminalInterpretationFacts('op_synthetic',error,reference);
 assert.equal(facts.interpretationStatus,'failed');assert.deepEqual(facts.error,error);
 assert.deepEqual(facts.unmapped,[{operationId:'op_synthetic',reason:'interpretation_unavailable',code:'SOURCE_HASH_MISMATCH',reference}]);
 assert.ok(!Object.hasOwn(facts,'status'));assert.ok(!Object.hasOwn(facts,'terminal'));assert.ok(!Object.hasOwn(facts,'remoteLeaseReleased'));
});

test('Partial delivery retains the failed interpretation as metadata and never changes the Hook candidate bytes',()=>{
 const facts=terminalInterpretationFacts('op_synthetic',error,reference),candidate={cases:[],unmapped:[]},rows=[{operationId:'op_synthetic',facts:{terminal:true,status:'succeeded',...facts}}];
 const original=structuredClone(candidate),delivery=terminalPartialDelivery('partial',candidate,rows);
 assert.deepEqual(candidate,original);assert.deepEqual(delivery.error,error);assert.deepEqual(delivery.unmapped,facts.unmapped);
 assert.throws(()=>terminalPartialDelivery('succeeded',candidate,rows),(failure:any)=>failure.code==='EVIDENCE_INSUFFICIENT');
 assert.deepEqual(terminalPartialDelivery('succeeded',{cases:[],unmapped:[]},[{facts:{terminal:false,error}}]),{unmapped:[]});
});
