import assert from 'node:assert/strict';
import {test} from 'node:test';
import {z} from 'zod';
import type {AssetRevisionPin} from '../../packages/knowledge/src/source-artifacts.ts';
import {
  EXECUTION_TRANSITION_LIMITS as limits, ExecutionTransitionAssetPin, ExecutionTransitionInput,
  ExecutionTransitionOutput, executionTransitionStepKey, executionTransitionRequestHash,
  parseExecutionTransitionInput, parseExecutionTransitionOutput, checkExecutionTransitionWire, executionTransitionJsonSchemas, sha256, canonicalHash,
} from '../../packages/contracts/src/index.ts';

const pin={assetId:'ast_method',version:'2.0.0',sha256:'a'.repeat(64),digest:'b'.repeat(64)};
const method={...pin,capabilityPackId:'fixture-execute',flowVersion:'fixture/2',implementationSha256:'c'.repeat(64)};
const currentInput={value:{sourceRevisionId:'src_workbook',sourceSha256:'a'.repeat(64)},sha256:canonicalHash({sourceRevisionId:'src_workbook',sourceSha256:'a'.repeat(64)})};
const binding={taskId:'task_fixture',inputRevisionId:'inrev_fixture',inputSha256:currentInput.sha256,method,resources:{gateway:{...pin,assetId:'ast_resource'}},sources:{workbook:{...pin,assetId:'ast_source'}}};
const input=()=>({schema:'hub-execution-transition/1',binding,currentInput,state:{stage:'received'},observations:[],controlledBytes:[]});
const action=(kind:string,rest:Record<string,unknown>={})=>({kind,stepId:'fixture-step',occurrence:0,...rest});
const output=(actions:unknown[]=[])=>({schema:'hub-execution-transition/1',state:{stage:'running'},actions});
const reference=(bytes:Buffer)=>({kind:'artifact',artifactId:'art_original',sha256:sha256(bytes),size:bytes.length});
const controlled=(bytes:Buffer)=>({slot:'original',role:'gateway-original',encoding:'base64',reference:reference(bytes),contentBase64:bytes.toString('base64')});

test('Execution transition: shared frozen pins are structurally compatible and six strict actions expose no execution authority',()=>{
 const a:z.infer<typeof ExecutionTransitionAssetPin>={} as AssetRevisionPin,b:AssetRevisionPin=a;void b;
 const actions=[action('tool.call',{path:'tools/results.ts',export:'parse',args:[{literal:'fixture'}],byteSlots:['original']}),action('provider.call',{resource:'gateway',tool:'case_submit',args:{workbook:'fixture'}}),action('operation.wait',{operationId:'op_existing'}),action('hook.verify',{event:'afterResult',subject:{result:{},operationId:'op_existing'}}),action('outcome.error',{code:'EVIDENCE_INSUFFICIENT',facts:{missing:'terminal'}}),action('delivery.propose',{status:'partial',result:{cases:[]},references:[]})];
 for(const item of actions){assert.equal(ExecutionTransitionOutput.safeParse(output([item])).success,true);for(const field of ['endpoint','credentials','fencingToken','effect','approval','status','unknown','freeze'])assert.equal(ExecutionTransitionOutput.safeParse(output([{...item,[field]:true}])).success,false);}
 assert.equal(ExecutionTransitionOutput.safeParse(output([action('shell',{command:'fixture'})])).success,false);
 assert.equal(ExecutionTransitionOutput.safeParse(output([action('hook.verify',{event:'newHook',subject:{}})])).success,false);
 assert.equal(ExecutionTransitionOutput.safeParse(output([action('outcome.error',{code:'UNREGISTERED_ERROR',facts:{}})])).success,false);
 assert.throws(()=>parseExecutionTransitionOutput(output([action('outcome.error',{code:'UNREGISTERED_ERROR',facts:{}})])),(error:any)=>error.code==='INVALID_PAYLOAD');
 assert.equal(ExecutionTransitionOutput.safeParse(output([actions[0],actions[0]])).success,false);
 assert.equal(ExecutionTransitionInput.safeParse({...input(),binding:{...binding,endpoint:'https://invalid.example.test'}}).success,false);
 const schemas=executionTransitionJsonSchemas();assert.equal(schemas.input.type,'object');assert.equal(schemas.output.type,'object');assert.equal(schemas.input.additionalProperties,false);
 assert.equal(ExecutionTransitionInput.safeParse(input()).success,true);
 assert.equal(ExecutionTransitionInput.safeParse({...input(),currentInput:{...currentInput,value:{sourceRevisionId:'src_tampered'}}}).success,false);
 assert.throws(()=>parseExecutionTransitionInput({...input(),currentInput:{...currentInput,sha256:'0'.repeat(64)}}),(error:any)=>error.code==='SOURCE_HASH_MISMATCH');
 assert.equal(ExecutionTransitionInput.safeParse({...input(),binding:{...binding,inputSha256:'0'.repeat(64)}}).success,false);
});

test('Execution transition: finite JSON preserves UTF-8 limits and rejects cycles values or properties JSON would discard',()=>{
 const value=input();for(const bad of [undefined,NaN,Infinity,BigInt(1),new Date(),new Map(),()=>0,Symbol('fixture')])assert.equal(ExecutionTransitionInput.safeParse({...value,state:bad}).success,false);
 const cycle:any={};cycle.next=cycle;assert.equal(ExecutionTransitionInput.safeParse({...value,state:cycle}).success,false);
 const hidden={};Object.defineProperty(hidden,'hidden',{value:'discarded'});assert.equal(ExecutionTransitionInput.safeParse({...value,state:hidden}).success,false);
 const symbol:any={};symbol[Symbol('discarded')]=1;assert.equal(ExecutionTransitionInput.safeParse({...value,state:symbol}).success,false);
 const accessor={};Object.defineProperty(accessor,'secret',{enumerable:true,get(){throw new Error('must not invoke getter');}});assert.equal(ExecutionTransitionInput.safeParse({...value,state:accessor}).success,false);
 assert.equal(ExecutionTransitionInput.safeParse({...value,state:{text:'中'.repeat(Math.floor(limits.jsonStringBytes/3))}}).success,true);
 assert.equal(ExecutionTransitionInput.safeParse({...value,state:{text:'中'.repeat(Math.floor(limits.jsonStringBytes/3)+1)}}).success,false);
 assert.equal(ExecutionTransitionInput.safeParse({...value,state:Array(limits.arrayItems).fill(1)}).success,true);
 assert.equal(ExecutionTransitionInput.safeParse({...value,state:Array(limits.arrayItems+1).fill(1)}).success,false);
 const sparse=Array(2);sparse[1]=1;assert.equal(ExecutionTransitionInput.safeParse({...value,state:sparse}).success,false);
 const tagged:any=[1];tagged.extra='discarded';assert.equal(ExecutionTransitionInput.safeParse({...value,state:tagged}).success,false);
 const numericExtra:any=[1];numericExtra['4294967295']='discarded';assert.equal(ExecutionTransitionInput.safeParse({...value,state:numericExtra}).success,false);
 const prototypeKey=JSON.parse('{"__proto__":{"literal":"discarded"}}');assert.equal(ExecutionTransitionInput.safeParse({...value,state:prototypeKey}).success,false);
 let boundary:any=null;for(let i=0;i<limits.jsonDepth-2;i++)boundary={next:boundary};assert.equal(ExecutionTransitionInput.safeParse({...value,state:boundary}).success,true);
 assert.equal(ExecutionTransitionInput.safeParse({...value,state:{next:boundary}}).success,false);
 let deep:any=null;for(let i=0;i<limits.jsonDepth+1;i++)deep={next:deep};assert.equal(ExecutionTransitionInput.safeParse({...value,state:deep}).success,false);
});

test('Execution transition: state metadata and output budgets are cumulative and never truncate',()=>{
 const chunk='x'.repeat(limits.jsonStringBytes),largeState={chunks:Array(9).fill(chunk)};
 assert.equal(ExecutionTransitionInput.safeParse({...input(),state:{chunks:Array(7).fill(chunk)}}).success,true);
 assert.equal(ExecutionTransitionInput.safeParse({...input(),state:largeState}).success,false);
 const observations=Array(18).fill({operationId:'op_existing',reference:reference(Buffer.from('fixture')),facts:{text:chunk}});
 assert.equal(ExecutionTransitionInput.safeParse({...input(),observations:observations.slice(0,14)}).success,true);
 assert.equal(ExecutionTransitionInput.safeParse({...input(),observations}).success,false);
 const loadedInput={chunks:Array(18).fill(chunk)},loadedSha=canonicalHash(loadedInput);assert.throws(()=>parseExecutionTransitionInput({...input(),binding:{...binding,inputSha256:loadedSha},currentInput:{value:loadedInput,sha256:loadedSha}}),(error:any)=>error.code==='BODY_TOO_LARGE');
 assert.equal(ExecutionTransitionOutput.safeParse(output(Array(limits.arrayItems+1).fill(action('operation.wait',{operationId:'op_existing'})))).success,false);
 assert.equal(ExecutionTransitionOutput.safeParse(output(Array.from({length:limits.arrayItems},(_,index)=>action('operation.wait',{stepId:'wait-'+index,operationId:'op_existing'})))).success,true);
 assert.equal(ExecutionTransitionOutput.safeParse({...output(),state:{chunks:Array(8).fill(chunk)}}).success,false);
 assert.throws(()=>parseExecutionTransitionOutput({...output(),state:{chunks:Array(8).fill(chunk)}}),(error:any)=>error.code==='RESULT_TOO_LARGE');
});

test('Execution transition: controlled original bytes are explicit SHA checked slots and escape no generic string or decoded total bound',()=>{
 const bytes=Buffer.alloc(64*1024,65),slot=controlled(bytes);assert.equal(ExecutionTransitionInput.safeParse({...input(),controlledBytes:[slot]}).success,true);
 for(const bad of [{...slot,encoding:'utf8'},{...slot,contentBase64:slot.contentBase64+'='},{...slot,reference:{...slot.reference,size:bytes.length+1}},{...slot,reference:{...slot.reference,sha256:'0'.repeat(64)}},{...slot,reference:{...slot.reference,downloadPath:'https://invalid.example.test'}}])assert.equal(ExecutionTransitionInput.safeParse({...input(),controlledBytes:[bad]}).success,false);
 assert.throws(()=>parseExecutionTransitionInput({...input(),controlledBytes:[{...slot,reference:{...slot.reference,sha256:'0'.repeat(64)}}]}),(error:any)=>error.code==='SOURCE_HASH_MISMATCH');
 const half=Buffer.alloc(limits.controlledBytes/2+1),a=controlled(half),b={...a,slot:'other'};assert.equal(ExecutionTransitionInput.safeParse({...input(),controlledBytes:[a,b]}).success,false);
 assert.equal(ExecutionTransitionInput.safeParse({...input(),controlledBytes:[slot,slot]}).success,false);
 const facts={operationId:'op_existing',reference:reference(bytes),facts:{terminal:'claimed-by-product'}};assert.equal(ExecutionTransitionInput.safeParse({...input(),observations:[facts]}).success,true);
 // Shape acceptance does not make this client-authored assertion a D terminal.
 assert.equal(ExecutionTransitionInput.safeParse({...input(),observations:[{...facts,verifiedTerminal:true}]}).success,false);
 assert.equal(ExecutionTransitionOutput.safeParse(output([action('delivery.propose',{status:'partial',result:{sessions:[{log:'synthetic uncovered session shape'}]},references:[]})])).success,true);
});

test('Execution transition: full serialized Tool wire has a separate exact byte ceiling including code framing and base64',()=>{
 assert.equal(checkExecutionTransitionWire('x'.repeat(limits.toolInputWireBytes),'input'),limits.toolInputWireBytes);
 assert.throws(()=>checkExecutionTransitionWire('x'.repeat(limits.toolInputWireBytes+1),'input'),(error:any)=>error.code==='BODY_TOO_LARGE');
 assert.equal(checkExecutionTransitionWire(new Uint8Array(limits.toolOutputWireBytes),'output'),limits.toolOutputWireBytes);
 assert.throws(()=>checkExecutionTransitionWire(new Uint8Array(limits.toolOutputWireBytes+1),'output'),(error:any)=>error.code==='RESULT_TOO_LARGE');
 const wire=JSON.stringify({files:[['tools/fixture.ts','中文\n\\'.repeat(100)]],args:[{$bytes:Buffer.from('原件').toString('base64')}]});assert.equal(checkExecutionTransitionWire(wire,'input'),Buffer.byteLength(wire));
 assert.throws(()=>checkExecutionTransitionWire({byteLength:0} as any,'input'),(error:any)=>error.code==='INVALID_PAYLOAD');
 const spoofed=new Uint8Array(8);Object.defineProperty(spoofed,'byteLength',{get(){throw new Error('do not trust own byteLength');}});assert.equal(checkExecutionTransitionWire(spoofed,'input'),8);
 assert.throws(()=>checkExecutionTransitionWire(new Proxy(new Uint8Array(8),{}) as any,'input'),(error:any)=>error.code==='INVALID_PAYLOAD');
});

test('Execution transition: step identity freezes method flow and occurrence while arguments stay in a separate request hash',()=>{
 const identity={taskId:binding.taskId,inputRevisionId:binding.inputRevisionId,method,flowVersion:method.flowVersion,stepId:'submit',occurrence:0};
 const key=executionTransitionStepKey(identity),first=action('provider.call',{resource:'gateway',tool:'case_submit',args:{value:1}}),second={...first,args:{value:2}};
 assert.equal(executionTransitionStepKey(identity),key);assert.notEqual(executionTransitionRequestHash(binding,first),executionTransitionRequestHash(binding,second));
 assert.notEqual(executionTransitionRequestHash(binding,first),executionTransitionRequestHash({...binding,inputSha256:'f'.repeat(64)},first));
 for(const changed of [{...identity,inputRevisionId:'inrev_next'},{...identity,method:{...method,version:'3.0.0'}},{...identity,method:{...method,digest:'d'.repeat(64)}},{...identity,method:{...method,flowVersion:'fixture/3'},flowVersion:'fixture/3'},{...identity,stepId:'next'},{...identity,occurrence:1}])assert.notEqual(executionTransitionStepKey(changed),key);
 assert.throws(()=>executionTransitionStepKey({...identity,argsDigest:'e'.repeat(64)}));
 assert.throws(()=>executionTransitionStepKey({...identity,flowVersion:'unbound/1'}));
 const dropped:any=[1];dropped.extra='lost';assert.throws(()=>executionTransitionRequestHash(binding,{...first,args:{dropped}}));
});

test('Execution transition: provider binary arguments bind authorized slot references without copying large base64 into ordinary JSON',()=>{
 const bytes=Buffer.alloc(64*1024,65),full=controlled(bytes),refOnly={slot:full.slot,role:full.role,reference:full.reference};
 const inline=action('provider.call',{resource:'gateway',tool:'case_submit',args:{xlsx_b64:full.contentBase64}});
 assert.throws(()=>parseExecutionTransitionOutput(output([inline])),(error:any)=>error.code==='RESULT_TOO_LARGE');
 const mapped=action('provider.call',{resource:'gateway',tool:'case_submit',args:{label:'literal'},byteArgs:{xlsx_b64:'original'}});
 assert.equal(ExecutionTransitionOutput.safeParse(output([mapped])).success,true);
 const original=executionTransitionRequestHash(binding,mapped,[refOnly]);assert.equal(executionTransitionRequestHash(binding,mapped,[full]),original);
 const otherBytes=Buffer.from('different original'),otherFull=controlled(otherBytes),otherRef={slot:otherFull.slot,role:otherFull.role,reference:otherFull.reference};
 assert.notEqual(executionTransitionRequestHash(binding,mapped,[otherRef]),original);
 assert.notEqual(executionTransitionRequestHash(binding,mapped,[{...refOnly,reference:{...refOnly.reference,artifactId:'art_other'}}]),original);
 const unused={...otherRef,slot:'unused'};assert.equal(executionTransitionRequestHash(binding,mapped,[refOnly,unused]),original);
 const parser=action('tool.call',{path:'tools/results.ts',export:'parse',args:[],byteSlots:['original']});assert.notEqual(executionTransitionRequestHash(binding,parser,[refOnly]),executionTransitionRequestHash(binding,parser,[otherRef]));
 assert.throws(()=>executionTransitionRequestHash(binding,parser));
 assert.throws(()=>executionTransitionRequestHash(binding,mapped));
 assert.throws(()=>executionTransitionRequestHash(binding,mapped,[refOnly,refOnly]));
 assert.throws(()=>executionTransitionRequestHash(binding,mapped,[{...full,reference:{...full.reference,sha256:'0'.repeat(64)}}]),(error:any)=>error.code==='SOURCE_HASH_MISMATCH');
 assert.throws(()=>executionTransitionRequestHash(binding,mapped,[{...refOnly,reference:{...refOnly.reference,size:limits.controlledBytes+1}}]),(error:any)=>error.code==='BODY_TOO_LARGE');
 assert.equal(ExecutionTransitionOutput.safeParse(output([{...mapped,args:{xlsx_b64:'collision'}}])).success,false);
 for(const key of ['constructor','prototype','__proto__'])assert.equal(ExecutionTransitionOutput.safeParse(output([{...mapped,byteArgs:JSON.parse(JSON.stringify({[key]:'original'}))}])).success,false);
 assert.equal(ExecutionTransitionOutput.safeParse(output([{...mapped,effect:'read',endpoint:'https://invalid.example.test'}])).success,false);
 const identity={taskId:binding.taskId,inputRevisionId:binding.inputRevisionId,method,flowVersion:method.flowVersion,stepId:mapped.stepId,occurrence:mapped.occurrence};
 assert.equal(executionTransitionStepKey(identity),executionTransitionStepKey({...identity}));
});
