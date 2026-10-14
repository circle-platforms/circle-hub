import assert from 'node:assert/strict';
import {test} from 'node:test';
import {canonicalHash,EXECUTION_TRANSITION_LIMITS,parseExecutionTransitionInput,sha256} from '../../packages/contracts/src/index.ts';
import {requiresControlledProjection} from '../../packages/execution/src/flow-projection.ts';

const id=(prefix:string,char:string)=>prefix+'_'+char.repeat(32);
const hash=(char:string)=>char.repeat(64);
const value={},reference={kind:'artifact' as const,artifactId:id('art','f'),sha256:hash('a'),size:1};
const input={schema:'hub-execution-transition/1' as const,binding:{taskId:id('task','a'),inputRevisionId:id('inrev','b'),inputSha256:canonicalHash(value),method:{assetId:id('ast','c'),version:'1.0.0',sha256:hash('d'),capabilityPackId:'synthetic-flow',flowVersion:'synthetic-flow/1',implementationSha256:hash('e')},resources:{},sources:{}},currentInput:{value,sha256:canonicalHash(value)},state:null,controlledBytes:[],observations:[{operationId:id('op','e'),reference,facts:{result:{}}}],expectedOccurrences:[]};
const nested=(layers:number):unknown=>{let result:unknown='leaf';for(let i=0;i<layers;i++)result={child:result};return result;};

test('Flow result projection: a small 257-item result fails the actual inline F frame and succeeds through its complete B bytes',()=>{
 const result={commands:Array.from({length:EXECUTION_TRANSITION_LIMITS.arrayItems+1},(_,i)=>`synthetic-${i}`)};
 assert.ok(Buffer.byteLength(JSON.stringify(result))<EXECUTION_TRANSITION_LIMITS.stateBytes);
 assert.equal(requiresControlledProjection(result),true);
 assert.throws(()=>parseExecutionTransitionInput({...input,observations:[{...input.observations[0],facts:{result}}]}),(error:any)=>error.code==='BODY_TOO_LARGE');
 const bytes=Buffer.from(JSON.stringify(result)),original={...reference,sha256:sha256(bytes),size:bytes.length},slot='hub.result.synthetic';
 const parsed=parseExecutionTransitionInput({...input,observations:[{...input.observations[0],reference:original,facts:{result:{original:{reference:original,slot}}}}],controlledBytes:[{slot,role:'provider-result',encoding:'base64',reference:original,contentBase64:bytes.toString('base64')}]});
 assert.deepEqual(JSON.parse(Buffer.from(parsed.controlledBytes[0].contentBase64,'base64').toString()),result);
});

test('Flow result projection: wrapper depth is counted exactly for result and metadata budgets',()=>{
 assert.equal(requiresControlledProjection(nested(11)),false);
 assert.doesNotThrow(()=>parseExecutionTransitionInput({...input,observations:[{...input.observations[0],facts:{result:nested(11)}}]}));
 assert.equal(requiresControlledProjection(nested(12)),true);
 assert.throws(()=>parseExecutionTransitionInput({...input,observations:[{...input.observations[0],facts:{result:nested(12)}}]}),(error:any)=>error.code==='BODY_TOO_LARGE');
 assert.equal(requiresControlledProjection(nested(10),6),false);
 assert.equal(requiresControlledProjection(nested(11),6),true);
});

test('Flow result projection: UTF-8 keys and values respect the unchanged 32 KiB limit',()=>{
 const at='a'.repeat(EXECUTION_TRANSITION_LIMITS.jsonStringBytes),over=at+'a';
 assert.equal(requiresControlledProjection({[at]:'small'}),false);
 assert.equal(requiresControlledProjection({[over]:'small'}),true);
 assert.equal(requiresControlledProjection({value:at}),false);
 assert.equal(requiresControlledProjection({value:over}),true);
 assert.equal(requiresControlledProjection({value:'界'.repeat(Math.floor(EXECUTION_TRANSITION_LIMITS.jsonStringBytes/3)+1)}),true);
});

test('Flow result projection: ordinary small JSON stays inline while cumulative JSON bytes retain the 256 KiB ceiling',()=>{
 assert.equal(requiresControlledProjection({items:[{name:'synthetic',ok:true}],nullable:null}),false);
 assert.equal(requiresControlledProjection({items:Array.from({length:256},()=>0)}),false);
 const large=Object.fromEntries(Array.from({length:17},(_,i)=>[`part-${i}`,'x'.repeat(16*1024)]));
 assert.ok(Buffer.byteLength(JSON.stringify(large))>EXECUTION_TRANSITION_LIMITS.stateBytes);
 assert.equal(requiresControlledProjection(large),true);
});
