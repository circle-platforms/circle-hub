import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha256} from '../../packages/contracts/src/index.ts';
import {FlowDefinition} from '../../packages/execution/src/flow-contracts.ts';
import {APV_MODULE_FLOW,frozenApvModule,apvModuleFlow,terminalFlowState,apvDeviceCommand,apvHostCommand} from '../fixtures/apv-module-flow.ts';

const enabled=process.env.CIRCLE_HUB_APV_MODULE_ACCEPTANCE==='1';
const nativeImplementation='5df9fdc0eccc88834f59c9295b94879f752e1582c8a84b03292c8cd14cbc0ebc',nativeTree='f566a87eaa80c35833581cb263b164aac1ef0c94c5685905e4a8dafd54fa6f21';
async function frozenNativeTree(){const files:{path:string;sha256:string}[]=[];async function walk(folder:string,prefix=''){for(const entry of await readdir(folder,{withFileTypes:true})){const path=prefix+entry.name;if(entry.isDirectory())await walk(join(folder,entry.name),path+'/');else files.push({path,sha256:sha256(await readFile(join(folder,entry.name)))});}}await walk(fileURLToPath(new URL('../../packs/apv/execution/',import.meta.url)));files.sort((a,b)=>a.path<b.path?-1:1);return sha256(files.map(file=>`${file.sha256}  ${file.path}\n`).join(''));}

test('A3 APV module: an opt-in immutable external product flow executes through governed generic steps and real product Hooks', {skip:enabled?false:'Set CIRCLE_HUB_APV_MODULE_ACCEPTANCE=1 with an independently versioned CIRCLE_PACKS_CATALOG and CIRCLE_PACKS_REF to run the external APV module acceptance'}, async t=>{
 // An explicitly selected broken repository/ref/catalog/module is a failure,
 // even on a host whose process-isolation capability is unavailable.
 const frozen=await frozenApvModule();t.diagnostic(`External APV module ${frozen.module.version}, ref ${frozen.requestedRef}, resolved ${frozen.commit}, digest ${frozen.module.digest}`);assert.equal(frozen.module.version,'1.3.0');
 const descriptors=frozen.manifest.flows.map((path:string)=>({path,value:JSON.parse(Buffer.from(frozen.files.find(file=>file.path===path)!.base64,'base64').toString())}));
 const descriptor=descriptors.find((entry:any)=>entry.path==='flows/apv-case-execute-v2.json');assert.ok(descriptor,'The entire external module must declare its v2 execution flow');assert.equal(descriptor.value.id,APV_MODULE_FLOW,'The new product flow must not select the native legacy capability');FlowDefinition.parse(descriptor.value);
 const {sandboxHost,until}=await import('./harness.ts');if(!sandboxHost.available){t.skip(sandboxHost.reason);return;}
 assert.equal(await frozenNativeTree(),nativeTree);
 const f=await apvModuleFlow(t,frozen),{h,provider}=f;assert.equal((await h.request('/v1/packs')).find((pack:any)=>pack.capabilityPackId==='apv-case-execute').implementationSha256,nativeImplementation);
 await h.reject('/v1/tasks/submit',{scopeId:'scp_hidden',capabilityPackId:'module-execute',idempotencyKey:'apv-module-wrong-scope',input:f.input},'FORBIDDEN_SCOPE');
 await h.reject('/v1/tasks/submit',{scopeId:'scp_lab',capabilityPackId:'module-execute',idempotencyKey:'apv-module-other-tenant',input:f.input},'SOURCE_NOT_APPROVED','outsider');
 await h.startWorker();const task=await f.submit();await until(()=>terminalFlowState(h,task.taskId),30_000);
 const delivered=await h.request(`/v1/tasks/${task.taskId}/result`);assert.equal(delivered.status,'succeeded');assert.equal(provider.state.submissions,1);assert.deepEqual(provider.state.workbook,f.workbook);assert.equal(sha256(provider.state.workbook),sha256(f.workbook));assert.ok(provider.state.releases>=1);
 const submit=provider.state.calls.find(row=>row.name==='case_submit')!;assert.ok(submit);assert.equal(submit.args.xlsx_b64,f.workbook.toString('base64'));assert.ok(submit.meta['hub/byteBindings'].some((binding:any)=>binding.parameter==='xlsx_b64'&&binding.sha256===sha256(f.workbook)&&binding.size===f.workbook.length));
 const steps=(await h.db.query('SELECT * FROM flow_steps WHERE task_id=$1 ORDER BY created_at,step_key',[task.taskId])).rows,operations=(await h.request(`/v1/tasks/${task.taskId}/operations`));assert.ok(operations.length);assert.ok(operations.every((operation:any)=>operation.name==='flow.invoke'),'The test must not invoke a native APV worker handler');
 const submitStep=steps.find(step=>step.kind==='provider.call'&&step.action.tool==='case_submit');assert.ok(submitStep?.intent&&submitStep.terminal);assert.equal(submitStep.action.byteArgs.xlsx_b64,'workbook');assert.ok(!Object.hasOwn(submitStep.action.args,'xlsx_b64'),'The product action must reference the controlled byte slot instead of inline base64');
 const result=delivered.result;assert.equal(result.sourceSha256,sha256(f.workbook));assert.ok(Array.isArray(result.cases)&&result.cases.length===1);assert.equal(result.cases[0].autoid,'301');assert.equal(result.cases[0].verdict,'pass');
 assert.ok(result.cases[0].steps.some((step:any)=>step.object==='APV_0'&&step.commands.includes(apvDeviceCommand)&&step.status==='observed'));assert.ok(result.cases[0].steps.some((step:any)=>step.object==='test_env'&&step.data===apvHostCommand&&step.status==='observed'));assert.equal(result.cases[0].checkPoints.length,2);assert.ok(result.cases[0].checkPoints.every((check:any)=>check.status==='passed'));assert.deepEqual(result.unmapped,[]);assert.equal(result.remoteStoppingVerified,false);
 t.diagnostic(`Generic APV chain delivered: ${provider.state.submissions} case_submit, ${f.workbook.length} original bytes, one device step, one host step, two checkpoints, zero unmapped; Hook completeness is verified separately`);
 for(const point of ['verify.deviceCommand','verify.hostCommand','verify.workbook']){
  const checks=steps.filter(step=>step.kind==='hook.verify'&&step.action.event===point);assert.ok(checks.length,`The real APV product must invoke ${point}`);for(const check of checks){assert.equal(check.status,'succeeded');assert.ok(check.evidence_ref);const reference=check.evidence_ref,content=await fetch(`${h.url}${reference.downloadPath}`,{headers:{authorization:`Bearer ${await h.login()}`}});assert.equal(content.status,200);assert.equal(sha256(Buffer.from(await content.arrayBuffer())),reference.sha256);assert.ok(check.observation.facts.result.decisions.length,`${point} must execute approved handlers, not a zero-rule placeholder`);assert.ok(check.observation.facts.result.decisions.every((decision:any)=>decision.result.decision==='pass'));}
 }
 const events=(await h.request(`/v1/tasks/${task.taskId}/events?after=0`)).events;for(const point of ['verify.deviceCommand','verify.hostCommand','verify.workbook'])assert.ok(events.some((event:any)=>event.kind==='hook.verification'&&(event.payload.point===point||event.payload.hookPoint===point)),point);
 assert.ok(steps.some(step=>step.kind==='tool.call'&&step.action.path==='tools/results.ts'&&step.status==='succeeded'));assert.ok(!JSON.stringify(delivered).includes(provider.state.secret));assert.ok(!(await h.db.query('SELECT 1 FROM resources WHERE frozen')).rowCount);assert.equal(await frozenNativeTree(),nativeTree);
});
