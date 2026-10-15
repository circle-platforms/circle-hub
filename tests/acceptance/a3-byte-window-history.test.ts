import assert from 'node:assert/strict';
import {sandboxTest,until} from './harness.ts';
import {canonicalJson,sha256,EXECUTION_TRANSITION_LIMITS} from '../../packages/contracts/src/index.ts';
import {meridianFlow,meridianModule,assetPin} from '../fixtures/meridian-flow.ts';

const observationCount=250,payloadBytes=2*1024;

// Test-owned modules use the actual frozen Tool host and C flow path. The
// individual results fit F; their accumulated observation metadata does not.
async function installByteHistoryModule(h:any,controlled:boolean){
 const id=controlled?'synthetic-byte-window':'synthetic-inline-history',flowId=id+'-execute',fixture=await meridianModule('1.0.0',id,flowId);
 const replace=(path:string,text:string)=>{let file=fixture.files.find(file=>file.path===path);if(!file){file={path,base64:'',sha256:''};fixture.files.push(file);}const bytes=Buffer.from(text);file.base64=bytes.toString('base64');file.sha256=sha256(bytes);};
 replace('tools/transition.ts',`export function transition(input){
  const stage=input.state?.stage??0,action=(kind,stepId,rest)=>({kind,stepId,occurrence:0,...rest}),out=(next,actions)=>({schema:'hub-execution-transition/1',state:{stage:next},actions});
  if(stage===0)return out(1,Array.from({length:${observationCount}},(_,index)=>action('tool.call','observation-'+index,{path:'tools/observe.ts',export:'observe',args:[index]})));
  if(stage===1){const window=input.observationWindow;if(!window?.archive||window.complete!==false||window.total!==${observationCount})return out(9,[action('outcome.error','missing-byte-window',{code:'EVIDENCE_INSUFFICIENT',facts:{reason:'byte-budget-history-archive-required'}})]);
   const original=input.controlledBytes.find(entry=>entry.slot===window.archive.slot&&entry.role==='flow-history');if(!original)return out(9,[action('outcome.error','missing-history-bytes',{code:'EVIDENCE_INSUFFICIENT',facts:{reason:'actual-history-byte-slot-required'}})]);
   return out(2,[action('tool.call','read-history',{path:'tools/history.ts',export:'inspect',args:[{total:window.total,returned:window.returned,complete:window.complete,archive:window.archive}],byteSlots:[window.archive.slot]})]);}
  if(stage===2){const observed=input.observations.find(row=>row.facts.stepId==='read-history');if(!observed)return out(2,[]);return out(3,[action('delivery.propose','deliver',{status:'succeeded',result:observed.facts.result,references:[observed.reference,observed.facts.result.firstReference]})]);}
  return out(stage,[]);
 }`);
 replace('tools/observe.ts',`export function observe(index){return {index,text:'x'.repeat(${payloadBytes})};}`);
 replace('tools/history.ts',`export async function inspect(window,bytes){
  const archive=JSON.parse(new TextDecoder().decode(bytes));if(archive.schema!=='hub-flow-history/1')throw new Error('Unexpected history schema');
  const observations=archive.observations,items=observations.map(row=>row.facts.result).sort((a,b)=>a.index-b.index);
  if(items.length!==${observationCount}||items.some((item,index)=>item.index!==index||item.text!=='x'.repeat(${payloadBytes})))throw new Error('History is incomplete or changed');
  const digest=await crypto.subtle.digest('SHA-256',bytes),archiveSha256=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
  return {historyCount:observations.length,payloadBytes:items.reduce((sum,item)=>sum+new TextEncoder().encode(item.text).length,0),firstIndex:items[0].index,lastIndex:items.at(-1).index,firstReference:observations[0].reference,archiveSha256,archiveSize:bytes.length,window};
 }`);
 const manifestFile=fixture.files.find(file=>file.path==='product-line.json')!,manifest=JSON.parse(Buffer.from(manifestFile.base64,'base64').toString());manifest.tools=[{manifest:'tools/transition.ts',imports:{}},{manifest:'tools/observe.ts',imports:{}},{manifest:'tools/history.ts',imports:{}}];manifest.hooks=[];replace('product-line.json',JSON.stringify(manifest));
 const descriptorFile=fixture.files.find(file=>file.path==='flows/execution.json')!,descriptor=JSON.parse(Buffer.from(descriptorFile.base64,'base64').toString());descriptor.initialState={stage:0};if(controlled)descriptor.historyMode='controlled';else delete descriptor.historyMode;replace('flows/execution.json',JSON.stringify(descriptor));
 fixture.files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);fixture.module.files=fixture.files.map(({path,sha256})=>({path,sha256}));fixture.module.digest=sha256(fixture.files.map(file=>`${file.sha256}  ${file.path}\n`).join(''));
 const installed=await h.raw('/v1/modules/install',{token:await h.login(),headers:{'x-scope-id':'scp_lab'},body:fixture});assert.equal(installed.status,201,JSON.stringify(installed.body));const asset=installed.body.data;await h.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.assetVersion,sha256:asset.assetSha256,state:'approved'},'bob');return {asset,flowId};
}

async function runByteHistory(t:any,controlled:boolean){
 const f=await meridianFlow(t),installed=await installByteHistoryModule(f.h,controlled),input={flowId:installed.flowId,methodPin:assetPin(installed.asset),resources:{},sources:{},controlledBytes:[],value:{synthetic:true}};
 await f.h.startWorker();const task=await f.h.request('/v1/tasks/submit',{scopeId:'scp_lab',capabilityPackId:'module-execute',idempotencyKey:'byte-history-'+controlled,input});
 const terminal=await until(async()=>{const status=await f.h.status(task.taskId);return ['delivered','failed','unknown','cancelled'].includes(status.phase)?status:false;},210_000),result=await f.h.request(`/v1/tasks/${task.taskId}/result`),rows=(await f.h.db.query('SELECT * FROM flow_steps WHERE task_id=$1 ORDER BY created_at,step_key',[task.taskId])).rows;
 t.diagnostic(JSON.stringify({phase:terminal.phase,error:result.error,steps:rows.length,observations:rows.filter(row=>row.step_id.startsWith('observation-')&&row.status==='succeeded').length}));
 assert.equal(f.provider.state.calls.length,0);assert.equal(f.provider.state.submissions,0);assert.ok(!rows.some(row=>row.intent));assert.ok(!(await f.h.db.query('SELECT 1 FROM resources WHERE frozen')).rowCount);return {...f,task,result,terminal,rows};
}

sandboxTest('Byte history window: fewer than 256 inline observations exceeding 512 KiB are archived and a real Tool reads their complete B history',{timeout:240_000},async t=>{
 const f=await runByteHistory(t,true);assert.equal(f.terminal.phase,'delivered',JSON.stringify(f.result.error));assert.equal(f.result.status,'succeeded');
 const observations=f.rows.filter(row=>row.step_id.startsWith('observation-'));assert.equal(observations.length,observationCount);assert.ok(observationCount<EXECUTION_TRANSITION_LIMITS.arrayItems);assert.ok(observations.every(row=>row.status==='succeeded'&&row.observation.facts.result.text.length===payloadBytes));
 const all=observations.map(row=>row.observation);assert.ok(Buffer.byteLength(canonicalJson(all))>EXECUTION_TRANSITION_LIMITS.metadataBytes,'The actual accumulated observation metadata must exceed 512 KiB while all results remain individually small');
 const history=f.rows.find(row=>row.step_id==='read-history');assert.ok(history);assert.equal(history.kind,'tool.call');assert.equal(history.status,'succeeded');assert.equal(history.action.byteSlots.length,1);
 const consumed=f.result.result;assert.equal(consumed.historyCount,observationCount);assert.equal(consumed.payloadBytes,observationCount*payloadBytes);assert.equal(consumed.firstIndex,0);assert.equal(consumed.lastIndex,observationCount-1);assert.equal(consumed.window.total,observationCount);assert.equal(consumed.window.complete,false);assert.ok(consumed.window.returned<observationCount);
 assert.equal(history.action.byteSlots[0],consumed.window.archive.slot);const original=(await f.h.db.query('SELECT args FROM operations WHERE operation_id=$1',[history.operation_id])).rows[0].args.reviewContent.controlledReferences;const reference=original.find((entry:any)=>entry.slot===history.action.byteSlots[0]);assert.ok(reference);assert.equal(reference.role,'flow-history');assert.deepEqual(reference.reference,consumed.window.archive.reference);assert.equal(consumed.archiveSha256,reference.reference.sha256);assert.equal(consumed.archiveSize,reference.reference.size);
 const response=await fetch(`${f.h.url}/v1/artifacts/${reference.reference.artifactId}/content`,{headers:{authorization:`Bearer ${await f.h.login()}`}});assert.equal(response.status,200);const bytes=Buffer.from(await response.arrayBuffer());assert.equal(sha256(bytes),reference.reference.sha256);assert.equal(bytes.length,reference.reference.size);const archive=JSON.parse(bytes.toString());assert.equal(archive.schema,'hub-flow-history/1');assert.deepEqual(archive.observations,all);assert.ok(archive.observations.some((row:any)=>row.reference.artifactId===consumed.firstReference.artifactId));
});

sandboxTest('Byte history window: an approved module without controlled history fails explicitly before cumulative metadata exceeds its contract',{timeout:240_000},async t=>{
 const f=await runByteHistory(t,false);assert.equal(f.terminal.phase,'failed');assert.equal(f.result.error.code,'RESULT_TOO_LARGE');assert.equal(f.result.error.details.cause.code,'RESULT_TOO_LARGE');assert.equal(f.result.error.details.cause.message,'Approved flow does not declare controlled history support');assert.equal(f.result.error.details.stepId,undefined,'A frame budget failure must not invent a rejected product action');assert.equal(f.result.error.details.kind,undefined);assert.ok(f.rows.some(row=>row.step_id.startsWith('observation-')&&row.status==='succeeded'));assert.ok(!f.rows.some(row=>row.step_id==='read-history'));
});
