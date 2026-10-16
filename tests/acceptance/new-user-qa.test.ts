import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sha256} from '../../packages/contracts/src/index.ts';
import {setup,type Harness} from './harness.ts';

async function grants(h:Harness){
 await h.db.query("UPDATE policies SET grants=grants || $1::jsonb WHERE principal_id='prn_alice'",[JSON.stringify(['assets.read','assets.register','assets.change','skillpacks.read','skillpacks.submit','skillpacks.run','automations.manage'])]);
 await h.db.query("UPDATE policies SET grants=grants || '[\"assets.read\",\"assets.approve\",\"decisions.approve\"]'::jsonb WHERE principal_id='prn_bob'");
}
function submission(id:string,version:string,triggers:string[],calls:{name:string;argsSha256:string;ok:boolean}[]){
 const bytes=Buffer.from(`---\nname: ${id}\ndescription: Synthetic new-user check\n---\nRevision ${version}.\n`);
 return {manifest:{id,version,title:'Synthetic QA skill',owner:'synthetic',tools:[...new Set(calls.map(call=>call.name))],triggers,inputs:{},outputs:['out.txt'],model:'scripted'},files:[{path:'SKILL.md',base64:bytes.toString('base64'),sha256:sha256(bytes)}],trial:{toolCalls:calls,outputs:[]}};
}
async function push(h:Harness,body:ReturnType<typeof submission>){
 const response=await h.raw('/v1/skillpacks',{token:await h.login(),headers:{'x-scope-id':'scp_lab'},body});
 assert.equal(response.status,201,JSON.stringify(response.body));return response.body.data;
}
const call=(name:string)=>({name,argsSha256:sha256('{}'),ok:true});

test('New-user QA: an unknown capability pack is refused before the upload is stored',async t=>{
 const h=await setup(t),token=await h.login();
 const uploaded=await fetch(`${h.url}/v1/sources`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/octet-stream','x-scope-id':'scp_lab','x-file-name':'note.txt','x-capability-pack-id':'not-a-real-pack'},body:Buffer.from('synthetic bytes')});
 const failure=await uploaded.json() as any;
 assert.equal(uploaded.status,404);assert.equal(failure.error.code,'TARGET_NOT_FOUND');assert.match(failure.error.message,/not-a-real-pack/);assert.match(failure.error.message,/GET \/v1\/packs/);
 const retired=await h.raw('/v1/sources',{token,headers:{'x-capability-pack-id':'lbx-healthcheck'},body:{scopeId:'scp_lab',fileName:'retired.txt',contentBase64:Buffer.from('synthetic').toString('base64')}});
 assert.equal(retired.status,400);assert.equal(retired.body.error.code,'UNSUPPORTED_VERSION');
 assert.equal(Number((await h.db.query('SELECT count(*) AS n FROM sources')).rows[0].n),0);
 const unknown=await h.reject('/v1/tasks/submit',{scopeId:'scp_lab',title:'Missing pack',capabilityPackId:'not-a-real-pack',input:{},idempotencyKey:'qa-missing-pack'},'TARGET_NOT_FOUND');
 assert.match(unknown.message,/not-a-real-pack/);
 await h.reject('/v1/tasks/submit',{scopeId:'scp_lab',title:'Retired health',capabilityPackId:'lbx-healthcheck',input:{},idempotencyKey:'qa-retired-health'},'UNSUPPORTED_VERSION');
 await h.reject('/v1/tasks/submit',{scopeId:'scp_lab',title:'Retired execute',capabilityPackId:'apv-case-execute',input:{},idempotencyKey:'qa-retired-execute'},'UNSUPPORTED_VERSION');
 const admitted=await h.submit();assert.equal(admitted.phase,'admitted');assert.equal(admitted.phaseLabel,'accepted, not started');
 const viewed=await h.status(admitted.taskId);assert.equal(viewed.phaseLabel,viewed.phase==='admitted'?'accepted, not started':viewed.phase==='running'?'running':viewed.phaseLabel);
 const packs=await h.request('/v1/packs');
 const titles=Object.fromEntries(packs.map((pack:any)=>[pack.capabilityPackId,pack]));
 assert.equal(titles['mindmap-compile'].title,'Compile a mind map into a case workbook');assert.equal(titles['mindmap-compile'].titleZh,'脑图用例结构编译');
 assert.equal(titles['defect-review'].title,'Review a synthetic record and write back');assert.equal(titles['synthetic-resource-check'].title,'Check a synthetic resource against a rule');
 assert.equal(titles['module-execute'].title,'Run an approved product module');assert.equal(titles['module-execute'].titleZh,'已批准的产品模块执行');
});

test('New-user QA: skill names, empty trials, trigger wording and runtime configuration',async t=>{
 const h=await setup(t);await grants(h);
 const empty=await push(h,submission('qa-empty', '1.0.0', ['manual'], []));
 assert.ok(empty.warnings.some((warning:string)=>warning.includes('0 tool calls')));
 const replay=await push(h,submission('qa-empty', '1.0.0', ['manual'], []));
 assert.equal(replay.skillPackId,empty.skillPackId);assert.equal(replay.warnings,undefined);
 const longer=await push(h,submission('qa-shorter', '1.0.0', ['manual'], [call('docs.search')]));
 assert.equal(longer.warnings,undefined);
 const shorter=await push(h,submission('qa-shorter', '1.0.1', ['manual'], []));
 assert.ok(shorter.warnings.some((warning:string)=>/records 0 tool calls/.test(warning)&&/previous submission recorded 1/.test(warning)));
 const waiting=await h.reject('/v1/skillpacks/qa-empty/runs',{inputs:{},idempotencyKey:'qa-name-waiting'},'APPROVAL_REQUIRED');
 assert.match(waiting.message,/qa-empty/);assert.match(waiting.message,/skp_/);
 const malformed=await h.reject('/v1/skillpacks/skp_/runs',{inputs:{},idempotencyKey:'qa-malformed-id'},'INVALID_PAYLOAD');
 assert.match(malformed.message,/skp_/);assert.match(malformed.message,/32 hex/);assert.equal(malformed.details.issues,undefined);
 await h.reject('/v1/skillpacks/bad_name/runs',{inputs:{},idempotencyKey:'qa-bad-name'},'INVALID_PAYLOAD');
 await h.reject('/v1/skillpacks/missing-skill/runs',{inputs:{},idempotencyKey:'qa-missing-name'},'TARGET_NOT_FOUND');
 const asset=await h.request(`/v1/assets/${empty.assetId}`);
 await h.request(`/v1/assets/${empty.assetId}/lifecycle`,{version:empty.assetVersion,sha256:asset.sha256,state:'approved'},'bob');
 const listed=(await h.request('/v1/skillpacks')).find((pack:any)=>pack.skillPackId===empty.skillPackId);
 assert.equal(listed.status,'registered');assert.equal(listed.registration,'registered');assert.equal(listed.lifecycle,'approved');assert.equal(listed.statusLabel,'approved');
 const runtime=await h.reject('/v1/skillpacks/qa-empty/runs',{inputs:{},idempotencyKey:'qa-by-name'},'RUNTIME_NOT_CONFIGURED');
 assert.match(runtime.message,/CIRCLE_RUNTIME_CONFIG/);assert.match(runtime.message,/docs\/quickstart.md/);
 const scheduled=await push(h,submission('qa-schedule', '1.0.0', ['schedule'], []));
 const scheduledAsset=await h.request(`/v1/assets/${scheduled.assetId}`);
 await h.request(`/v1/assets/${scheduled.assetId}/lifecycle`,{version:scheduled.assetVersion,sha256:scheduledAsset.sha256,state:'approved'},'bob');
 const trigger=await h.reject(`/v1/skillpacks/${scheduled.skillPackId}/runs`,{inputs:{},idempotencyKey:'qa-manual-trigger'},'FORBIDDEN_ACTION');
 assert.match(trigger.message,/manual/);assert.match(trigger.message,/schedule/);assert.match(trigger.message,new RegExp(scheduled.skillPackId));
 const first=await push(h,submission('qa-duplicate', '1.0.0', ['manual'], []));
 const firstAsset=await h.request(`/v1/assets/${first.assetId}`);
 await h.request(`/v1/assets/${first.assetId}/lifecycle`,{version:first.assetVersion,sha256:firstAsset.sha256,state:'approved'},'bob');
 const second=await push(h,submission('qa-duplicate', '1.0.1', ['manual'], []));
 const secondAsset=await h.request(`/v1/assets/${second.assetId}`);
 await h.request(`/v1/assets/${second.assetId}/lifecycle`,{version:second.assetVersion,sha256:secondAsset.sha256,state:'approved'},'bob');
 const ambiguous=await h.reject('/v1/skillpacks/qa-duplicate/runs',{inputs:{},idempotencyKey:'qa-ambiguous-name'},'INVALID_PAYLOAD');
 assert.match(ambiguous.message,new RegExp(first.skillPackId));assert.match(ambiguous.message,new RegExp(second.skillPackId));
 const schedule=await h.request('/v1/automations/triggers',{scopeId:'scp_lab',version:'1.0.0',name:'QA schedule',kind:'schedule',intervalMs:60_000,startsAt:new Date().toISOString()});
 const bot=await h.reject('/v1/automations/bots',{scopeId:'scp_lab',version:'1.0.0',name:'QA bot',skillPackId:empty.skillPackId,triggerAssetId:schedule.assetId,identityPrincipalId:'prn_alice',channel:'circle-events',inputs:{}},'FORBIDDEN_ACTION');
 assert.match(bot.message,/schedule/);assert.match(bot.message,/manual/);assert.match(bot.message,new RegExp(empty.skillPackId));assert.match(bot.message,/qa-empty/);
});
