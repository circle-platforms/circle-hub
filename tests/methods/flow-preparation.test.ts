import assert from 'node:assert/strict';
import {test} from 'node:test';
import {canonicalHash,canonicalJson} from '../../packages/contracts/src/index.ts';
import {preparationPlan,preparationReceipt,preparationProofMatches,preparationSubject,preparationCleanupTransport} from '../../packages/execution/src/flow-prepare.ts';

const object=(properties:any={},required:string[]=[])=>({type:'object',properties,required,additionalProperties:false});
const tools=[{name:'observe_environment',description:'Synthetic environment',effect:'read',minimumRole:'member',approval:false,inputSchema:object({lease_id:{type:'string'},token:{type:'integer'},build:{type:'string'}},['lease_id','token'])},{name:'observe_topology',description:'Synthetic topology',effect:'read',minimumRole:'admin',approval:false,inputSchema:object({refresh:{type:'boolean'}})}];
const calls=[{tool:'observe_environment'},{tool:'observe_topology',args:{refresh:false}}];
const identity={operationId:'op_'+ '1'.repeat(32),inputRevisionId:'inrev_'+ '2'.repeat(32),fencingToken:3,requestHash:'4'.repeat(64),resource:{assetId:'ast_'+ '5'.repeat(32),version:'1.0.0',sha256:'6'.repeat(64)},leaseDigest:canonicalHash({lease_id:'synthetic-lease',token:7})};
const refs=[{artifactId:'art_'+ '7'.repeat(32),sha256:'8'.repeat(64),size:32},{artifactId:'art_'+ '9'.repeat(32),sha256:'a'.repeat(64),size:64}];
const record=(call:any,index:number,result:any)=>({index,tool:call.tool,reference:{...refs[index],sha256:canonicalHash(result),size:Buffer.byteLength(canonicalJson(result))},result});

test('cleanup transport records only the approved release attempt without dispatch or credential fields',()=>{
 assert.deepEqual(preparationCleanupTransport('tools/call','lease_release','lease_release'),{method:'tools/call',tool:'lease_release',plaintextAuthentication:true});
 for(const tool of ['lease_acquire','lease_heartbeat','case_submit','case_status'])assert.throws(()=>preparationCleanupTransport('tools/call',tool,'lease_release'),(error:any)=>error.code==='FORBIDDEN_ACTION');
 assert.throws(()=>preparationCleanupTransport('tools/list','lease_release','lease_release'),(error:any)=>error.code==='FORBIDDEN_ACTION');
});

test('preparation plans use declared read Tools and preserve approved order without product lease authority',()=>{
 assert.deepEqual(preparationPlan(calls,tools).map(call=>({index:call.index,tool:call.tool,args:call.args})),[{index:0,tool:'observe_environment',args:{}},{index:1,tool:'observe_topology',args:{refresh:false}}]);
 assert.throws(()=>preparationPlan([{tool:'unknown'}],tools),(error:any)=>error.code==='SOURCE_NOT_APPROVED');
 assert.throws(()=>preparationPlan(calls,[{...tools[0],effect:'write'},tools[1]]),(error:any)=>error.code==='INVALID_PAYLOAD');
 assert.throws(()=>preparationPlan(calls,[{...tools[0],minimumRole:'superuser'},tools[1]]),(error:any)=>error.code==='INVALID_PAYLOAD');
 assert.throws(()=>preparationPlan([{tool:'observe_environment',args:{token:7}}],tools,new Set(['lease_id','token'])),(error:any)=>error.code==='INVALID_PAYLOAD');
 assert.throws(()=>preparationPlan(calls,[{...tools[0],inputSchema:{type:'array'}},tools[1]]),(error:any)=>error.code==='INVALID_PAYLOAD');
});

test('preparation proofs bind every raw reference to this fence revision resource request and lease',()=>{
 const plan=preparationPlan(calls,tools),records=plan.map((call,index)=>record(call,index,{ready:true})),proof=preparationReceipt(identity,plan,records);
 assert.equal(preparationProofMatches(proof,identity,plan),true);
 for(const changed of [{...identity,fencingToken:4},{...identity,inputRevisionId:'inrev_'+ 'b'.repeat(32)},{...identity,requestHash:'c'.repeat(64)},{...identity,resource:{...identity.resource,version:'2.0.0'}},{...identity,leaseDigest:'d'.repeat(64)}])assert.equal(preparationProofMatches(proof,changed,plan),false);
 assert.equal(preparationProofMatches({...proof,records:[{...records[0],reference:{...refs[0],sha256:'e'.repeat(64)}},records[1]]},identity,plan),false);
 assert.throws(()=>preparationReceipt(identity,plan,records.slice(1)),(error:any)=>error.code==='EVIDENCE_INSUFFICIENT');
 assert.throws(()=>preparationReceipt(identity,plan,[records[1],records[0]]),(error:any)=>error.code==='EVIDENCE_INSUFFICIENT');
});

test('beforeDispatch preparation facts sanitize secrets lease fields and NUL without altering raw references',()=>{
 const plan=preparationPlan(calls,tools),records=plan.map((call,index)=>record(call,index,{ready:true,nested:{token:7,lease_id:'synthetic-lease',authorization:'synthetic-private-secret',detail:'before\0after synthetic-private-secret'}})),proof=preparationReceipt(identity,plan,records),subject=preparationSubject({build:'synthetic-build'},identity.operationId,proof,['synthetic-private-secret'],new Set(['lease_id','token']));
 assert.equal(subject.preparations.length,2);assert.deepEqual(subject.preparations[0].reference,records[0].reference);
 assert.ok(!JSON.stringify(subject).includes('synthetic-private-secret'));assert.ok(!JSON.stringify(subject.preparations[0].result).includes('lease_id'));assert.ok(!JSON.stringify(subject.preparations[0].result).includes('"token"'));assert.ok(!JSON.stringify(subject).includes('\\u0000'));
 assert.equal(subject.preparations[0].result.sanitized,true);
 assert.equal(subject.preparations[0].result.nulBytes,1);
 assert.equal(records[0].result.nested.detail,'before\0after synthetic-private-secret');
});

test('preparation projection rejects oversized or non-JSON facts instead of truncating a pass',()=>{
 const plan=preparationPlan(calls,tools),records=plan.map((call,index)=>record(call,index,{text:'x'.repeat(32769)})),proof=preparationReceipt(identity,plan,records);
 assert.throws(()=>preparationSubject({},identity.operationId,proof), (error:any)=>error.code==='RESULT_TOO_LARGE');
 const bad:any={};bad.self=bad;assert.throws(()=>preparationReceipt(identity,plan,[{...records[0],result:bad},records[1]]));
});
