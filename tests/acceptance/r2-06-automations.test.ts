import {sandboxTest} from './harness.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {writeFile,readFile} from 'node:fs/promises';
import {canonicalHash,sha256} from '../../packages/contracts/src/index.ts';
import {setup,type Harness,until} from './harness.ts';
import {readonlySources} from '../fixtures/readonly-sources.ts';
import {scriptModel} from '../fixtures/script-model.ts';
import {setTimeout as delay} from 'node:timers/promises';

const runtimeTest={skip:(!process.env.CIRCLE_BIN||!process.env.CIRCLE_COMMIT)&&'Set CIRCLE_BIN and CIRCLE_COMMIT to verify scheduled consolidation with real Circle'};
async function prepare(h:Harness,origin:string,runtime?:any){
  const grants=['assets.read','assets.register','assets.change','assets.approve','knowledge.read','knowledge.ingest','knowledge.submit','skillpacks.read','skillpacks.submit','skillpacks.run','automations.manage','automations.read','connectors.events'];
  await h.db.query('UPDATE policies SET grants=grants || $1::jsonb WHERE principal_id=ANY($2::text[])',[JSON.stringify(grants),['prn_alice','prn_bob']]);
  await h.db.query("UPDATE policies SET grants=grants || '[\"admin.manage\"]'::jsonb WHERE principal_id='prn_alice'");
  await h.db.query("UPDATE policies SET grants=grants || '[\"automations.read\"]'::jsonb WHERE principal_id='prn_outsider'");
  await writeFile(`${h.scratch}/profiles.json`,JSON.stringify({profiles:{fixture:{origin,root:'/dav/'}}}),{mode:0o600});h.env.CIRCLE_HUB_CONNECTOR_PROFILES=`${h.scratch}/profiles.json`;
  await writeFile(`${h.scratch}/runtime.json`,JSON.stringify(runtime??{circleBin:'synthetic-runtime-not-executed',circleCommit:'0'.repeat(40),circleVersion:'1.7.0',model:{kind:'scripted',base_url:`${origin}/v1`,model:'synthetic',protocol:'openai',api_key:randomBytes(20).toString('hex')}}),{mode:0o600});h.env.CIRCLE_RUNTIME_CONFIG=`${h.scratch}/runtime.json`;await h.stop();await h.startServer();
}
async function activate(h:Harness,asset:any){await h.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'approved'},'bob');return h.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'running'});}
async function pack(h:Harness,tools:string[]=[]){
  const bytes=await readFile(new URL('../../packs/common/skills/knowledge-consolidation/SKILL.md',import.meta.url));
  const script=await readFile(new URL('../../packs/common/skills/knowledge-consolidation/scripts/normalize.ts',import.meta.url));
  const body={manifest:{id:'knowledge-consolidation',version:'1.0.0',title:'Synthetic knowledge consolidation',owner:'synthetic-owner',tools,triggers:['manual','schedule','event'],inputs:{},outputs:['out/consolidation.json'],model:'scripted'},files:[{path:'SKILL.md',base64:bytes.toString('base64'),sha256:sha256(bytes)},{path:'scripts/normalize.ts',base64:script.toString('base64'),sha256:sha256(script)}],trial:{toolCalls:tools.map(name=>({name,argsSha256:sha256('{}'),ok:true})),outputs:[{path:'out/consolidation.json',sha256:sha256('{}')}]} };
  const response=await fetch(`${h.url}/v1/skillpacks`,{method:'POST',headers:{authorization:`Bearer ${await h.login()}`,'content-type':'application/json','x-scope-id':'scp_lab'},body:JSON.stringify(body)});assert.equal(response.status,201,JSON.stringify(await response.clone().json()));const submitted=(await response.json() as any).data;
  const approval=(await h.request(`/v1/tasks/${submitted.approvalTaskId}/approvals`))[0];await h.request(`/v1/tasks/${submitted.approvalTaskId}/approvals/${approval.approvalId}`,{inputRevisionId:approval.inputRevisionId,targetIdentity:approval.targetIdentity,actionDigest:approval.actionDigest,approve:true},'bob');return submitted;
}
async function bot(h:Harness,pack:any,trigger:any){return activate(h,await h.request('/v1/automations/bots',{scopeId:'scp_lab',version:'1.0.0',name:'Synthetic bot',skillPackId:pack.skillPackId,triggerAssetId:trigger.assetId,identityPrincipalId:'prn_alice',channel:'circle-events',inputs:{}}));}

test('Act R2.6: scheduled occurrences are durable unique and owner scoped across a server restart',async t=>{
  const stub=await readonlySources(t),h=await setup(t);await prepare(h,stub.origin);const skill=await pack(h),trigger=await activate(h,await h.request('/v1/automations/triggers',{scopeId:'scp_lab',version:'1.0.0',name:'Synthetic schedule',kind:'schedule',intervalMs:60_000,startsAt:new Date(Date.now()-1000).toISOString()}));
  const active=await bot(h,skill,trigger);const runs=await until(async()=>{const runs=await h.request(`/v1/automations/bots/${active.assetId}/runs`);return runs.length===1?runs:false;});
  await h.stop();await h.startServer();assert.equal((await h.request(`/v1/automations/bots/${active.assetId}/runs`))[0].taskId,runs[0].taskId);
  await h.reject(`/v1/automations/bots/${active.assetId}/runs`,undefined,'SOURCE_FORBIDDEN','outsider');
  await h.reject('/v1/automations/bots',{scopeId:'scp_lab',version:'1.0.0',name:'Spoof',skillPackId:skill.skillPackId,triggerAssetId:trigger.assetId,identityPrincipalId:'prn_bob',channel:'circle-events',inputs:{}},'FORBIDDEN_ACTION');
});

test('Act R2.6: connector event ids deduplicate and event triggers keep the same skill and Circle channel',async t=>{
  const stub=await readonlySources(t),h=await setup(t);await prepare(h,stub.origin);const skill=await pack(h),source=await activate(h,await h.request('/v1/assets',{scopeId:'scp_lab',kind:'connector-instance',name:'Synthetic event source',version:'1.0.0',declaration:{reads:['source-records'],writes:[],credentials:[]},configuration:{packageId:'fixture-reader'},readers:['prn_alice','prn_bob']}));
  const trigger=await activate(h,await h.request('/v1/automations/triggers',{scopeId:'scp_lab',version:'1.0.0',name:'Synthetic event trigger',kind:'event',sourceAssetId:source.assetId,eventName:'source.changed'})),active=await bot(h,skill,trigger);
  const event={externalId:'synthetic-event-1',name:'source.changed',payload:{revision:'r1'}};
  const first=await h.request(`/v1/connectors/${source.assetId}/events`,event),same=await h.request(`/v1/connectors/${source.assetId}/events`,event);assert.equal(first.eventId,same.eventId);assert.equal(same.deduplicated,true);
  await h.reject(`/v1/connectors/${source.assetId}/events`,{...event,payload:{revision:'changed'}},'IDEMPOTENCY_MISMATCH');
  const runs=await until(async()=>{const runs=await h.request(`/v1/automations/bots/${active.assetId}/runs`);return runs.length===1?runs:false;});
  await h.stop();await h.startServer();await h.request(`/v1/connectors/${source.assetId}/events`,event);assert.equal((await h.request(`/v1/automations/bots/${active.assetId}/runs`)).length,1);assert.equal((await h.request(`/v1/tasks/${runs[0].taskId}/status`)).input.skillPackId,skill.skillPackId);
});

test('Act R2.6 regression: late schedule activation coalesces missed occurrences and rejects sub-minute intervals',async t=>{
  const stub=await readonlySources(t),h=await setup(t);await prepare(h,stub.origin);const skill=await pack(h);
  const startsAt=new Date(Date.now()-30*60_000).toISOString(),input={scopeId:'scp_lab',version:'1.0.0',name:'Synthetic delayed schedule',kind:'schedule',intervalMs:60_000,startsAt};
  const trigger=await activate(h,await h.request('/v1/automations/triggers',input)),active=await bot(h,skill,trigger);
  await until(async()=>{const runs=await h.request(`/v1/automations/bots/${active.assetId}/runs`);return runs.length>0;});await delay(350);
  const runs=await h.request(`/v1/automations/bots/${active.assetId}/runs`);assert.equal(runs.length,1,'A late approval must not flood C with historical runs');
  const task=await h.status(runs[0].taskId),occurrence=task.input.inputs.trigger;
  assert.equal(occurrence.skippedOccurrences,30);assert.equal(occurrence.firstDueAt,startsAt);assert.equal(Date.parse(occurrence.dueAt),Date.parse(startsAt)+30*60_000);
  const events=(await h.request(`/v1/tasks/${task.taskId}/events?after=0`)).events;
  assert.equal(events.find((event:any)=>event.kind==='bot.started').payload.trigger.skippedOccurrences,30);
  const position=(await h.db.query('SELECT next_due_at FROM automation_positions WHERE bot_id=$1',[active.assetId])).rows[0];assert.ok(position.next_due_at.getTime()>Date.now());
  await h.stop();await h.startServer();await delay(150);assert.equal((await h.request(`/v1/automations/bots/${active.assetId}/runs`)).length,1);
  for(const intervalMs of [0,100,59_999])await h.reject('/v1/automations/triggers',{...input,intervalMs},'INVALID_PAYLOAD');
});

test('Act R2.6 regression: a rejected event admission records its failure and does not poison the cursor',async t=>{
  const stub=await readonlySources(t),h=await setup(t);await prepare(h,stub.origin);const skill=await pack(h);
  const source=await activate(h,await h.request('/v1/assets',{scopeId:'scp_lab',kind:'connector-instance',name:'Synthetic failing event source',version:'1.0.0',declaration:{reads:['source-records'],writes:[],credentials:[]},configuration:{packageId:'fixture-reader'},readers:['prn_alice','prn_bob']}));
  const trigger=await activate(h,await h.request('/v1/automations/triggers',{scopeId:'scp_lab',version:'1.0.0',name:'Synthetic isolated event trigger',kind:'event',sourceAssetId:source.assetId,eventName:'source.changed'})),active=await bot(h,skill,trigger);
  await h.request(`/v1/assets/${skill.assetId}/lifecycle`,{version:skill.assetVersion,sha256:(await h.request(`/v1/assets/${skill.assetId}`)).sha256,state:'disabled'});
  const failed=await h.request(`/v1/connectors/${source.assetId}/events`,{externalId:'denied-event',name:'source.changed',payload:{revision:'r1'}});
  const failures=await until(async()=>{const runs=await h.request(`/v1/automations/bots/${active.assetId}/runs`);return runs.length===1?runs:false;},2000);
  assert.equal(failures[0].status,'failed');assert.equal(failures[0].taskId,null);assert.equal(failures[0].error.code,'APPROVAL_STALE');assert.equal(failures[0].occurrenceKey,`event:${failed.eventId}`);
  const notice=(await h.request('/v1/notifications')).items.find((item:any)=>item.kind==='bot.admission-failed');assert.equal(notice.taskId,null);assert.equal(notice.payload.botAssetId,active.assetId);assert.equal(notice.payload.reason.code,'APPROVAL_STALE');assert.ok(!(await h.request('/v1/notifications',undefined,'bob')).items.some((item:any)=>item.kind==='bot.admission-failed'));
  const cursor=(await h.db.query('SELECT event_cursor FROM automation_positions WHERE bot_id=$1',[active.assetId])).rows[0].event_cursor;
  assert.equal(String(cursor),String((await h.db.query('SELECT id FROM automation_events WHERE event_id=$1',[failed.eventId])).rows[0].id));
  // Restore the fixture's bound registration to exercise the next occurrence.
  await h.db.query("UPDATE asset_versions SET lifecycle='approved' WHERE asset_id=$1 AND version=$2",[skill.assetId,skill.assetVersion]);
  await h.request(`/v1/connectors/${source.assetId}/events`,{externalId:'accepted-after-denial',name:'source.changed',payload:{revision:'r2'}});
  const runs=await until(async()=>{const runs=await h.request(`/v1/automations/bots/${active.assetId}/runs`);return runs.length===2?runs:false;});assert.equal(runs[1].status,'admitted');assert.ok(runs[1].taskId);
  assert.equal(Number((await h.db.query("SELECT count(*) AS n FROM tasks WHERE capability_pack_id='skill-run'")).rows[0].n),1);
  await h.stop();await h.startServer();await delay(150);assert.equal((await h.request(`/v1/automations/bots/${active.assetId}/runs`)).length,2);
});

sandboxTest('Act R2.6: scheduled real Circle consolidates opted-in fragments as deduplicated personal candidates with tool evidence',runtimeTest,async t=>{
  const stub=await readonlySources(t),model=await scriptModel(t),h=await setup(t);await prepare(h,stub.origin,{circleBin:process.env.CIRCLE_BIN,circleCommit:process.env.CIRCLE_COMMIT,circleVersion:'1.7.0',model:{kind:'scripted',base_url:model.url,model:'scripted-fixture',protocol:'openai',api_key:model.key}});
  await activate(h,await h.request('/v1/assets',{scopeId:'scp_lab',kind:'connector-instance',name:'Synthetic shared knowledge',version:'1.0.0',declaration:{reads:['knowledge'],writes:['knowledge-candidates'],credentials:[]},configuration:{packageId:'knowledge'},readers:['prn_alice','prn_bob']}));
  const fragment={id:'fragment-1',kind:'correction',subject:'synthetic-feature',predicate:'command-choice',value:'preferred',quote:'Synthetic corrected procedure',toolReturn:{name:'synthetic.read',result:{observed:true}}},raw=Buffer.from(JSON.stringify({fragments:[fragment]}));
  const source=await h.request('/v1/knowledge/sources',{scopeId:'scp_lab',sourceId:'synthetic-session',revision:'r1',path:'synthetic/session.json',knowledgeCategory:'consolidated',sourceType:'shared-session',parserVersion:'fixture/1',contentBase64:raw.toString('base64'),sha256:sha256(raw),acl:{sourceReaders:['prn_alice'],platformReaders:['prn_alice']},sharing:{allowed:true,teamPromotion:false}});
  const evidence=await h.request('/v1/knowledge/evidence',{sourceRecordId:source.recordId,start:0,end:raw.length});
  const unshared=Buffer.from(JSON.stringify({fragments:[{...fragment,id:'unshared',subject:'must-not-consolidate'}]}));await h.request('/v1/sources',{scopeId:'scp_lab',fileName:'unshared.json',contentBase64:unshared.toString('base64')});
  model.state.sequence=[{name:'skill',args:{name:'knowledge-consolidation'}},{name:'hub_tool_knowledge_shared_fragments',args:{}},{name:'write_file',args:{file_path:'fragments.json',content:JSON.stringify({fragments:[{...fragment,sharingAllowed:true,sourceRecordId:source.recordId,evidence:[{evidenceId:evidence.recordId,sha256:evidence.sha256}]}]})}},{name:'execute',args:{command:'node .circle/skills/knowledge-consolidation/scripts/normalize.ts fragments.json out/consolidation.json'}},{name:'hub_tool_knowledge_claim_submit',args:{claim:{subject:fragment.subject,predicate:fragment.predicate,value:fragment.value},evidence:[{evidenceId:evidence.recordId,sha256:evidence.sha256}]}}];
  const skill=await pack(h,['knowledge.shared_fragments','knowledge.claim_submit']),trigger=await activate(h,await h.request('/v1/automations/triggers',{scopeId:'scp_lab',version:'1.0.0',name:'Synthetic consolidation schedule',kind:'schedule',intervalMs:60_000,startsAt:new Date(Date.now()-1000).toISOString()})),active=await bot(h,skill,trigger);await h.startWorker();
  const runs=await until(async()=>{const runs=await h.request(`/v1/automations/bots/${active.assetId}/runs`);return runs.length===1?runs:false;});await h.phase(runs[0].taskId,'delivered');
  const learned=await h.request('/v1/knowledge/search?mode=exact&q=synthetic-feature&includeCandidates=true');assert.equal(learned.items.length,1,JSON.stringify({operations:(await h.db.query('SELECT name,status,result FROM operations')).rows,events:(await h.request(`/v1/tasks/${runs[0].taskId}/events?after=0`)).events.filter((e:any)=>e.kind==='runtime.tool_result')}));assert.equal(learned.items[0].visibility,'personal');assert.equal(learned.items[0].state,'candidate');
  assert.equal((await h.request('/v1/knowledge/search?mode=exact&q=synthetic-feature&includeCandidates=true',undefined,'bob')).items.length,0);assert.equal((await h.request('/v1/knowledge/search?mode=exact&q=must-not-consolidate&includeCandidates=true')).items.length,0);
  const selected=(await h.db.query("SELECT count(*) AS n FROM knowledge_records WHERE kind='Claim' AND payload->>'subject'=$1",[fragment.subject])).rows[0];assert.equal(Number(selected.n),1);
  const channel=await until(async()=>{const events=await h.request(`/v1/tasks/${runs[0].taskId}/events?after=0`);return events.events.some((event:any)=>event.kind==='bot.output')?events:false;});assert.equal(channel.events.find((event:any)=>event.kind==='bot.output').payload.channel,'circle-events');
});

sandboxTest('Act R2.6 regression: bot reads of a changing source retain evidence without creating recursive observed events',runtimeTest,async t=>{
  const stub=await readonlySources(t),model=await scriptModel(t),h=await setup(t);stub.state.dynamicDocuments=true;
  await prepare(h,stub.origin,{circleBin:process.env.CIRCLE_BIN,circleCommit:process.env.CIRCLE_COMMIT,circleVersion:'1.7.0',model:{kind:'scripted',base_url:model.url,model:'scripted-fixture',protocol:'openai',api_key:model.key}});
  const source=await activate(h,await h.request('/v1/assets',{scopeId:'scp_lab',kind:'connector-instance',name:'Synthetic dynamic document source',version:'1.0.0',declaration:{reads:['registered-source'],writes:[],credentials:[]},configuration:{packageId:'documents',runtimeProfileRef:'fixture'},readers:['prn_alice','prn_bob']}));
  const bytes=Buffer.from('---\nname: dynamic-source-reader\ndescription: Read one synthetic source and write a receipt.\n---\nUse docs.get for /dav/manual.txt once, then write out/reader.json.');
  const submission={manifest:{id:'dynamic-source-reader',version:'1.0.0',title:'Synthetic source reader',owner:'synthetic-owner',tools:['docs.get'],triggers:['manual','schedule','event'],inputs:{},outputs:['out/reader.json'],model:'scripted'},files:[{path:'SKILL.md',base64:bytes.toString('base64'),sha256:sha256(bytes)}],trial:{toolCalls:[{name:'docs.get',argsSha256:canonicalHash({file:'/dav/manual.txt'}),ok:true}],outputs:[{path:'out/reader.json',sha256:sha256('{"done":true}')}]} };
  const response=await fetch(`${h.url}/v1/skillpacks`,{method:'POST',headers:{authorization:`Bearer ${await h.login()}`,'content-type':'application/json','x-scope-id':'scp_lab'},body:JSON.stringify(submission)});assert.equal(response.status,201);const skill=(await response.json() as any).data;
  const approval=(await h.request(`/v1/tasks/${skill.approvalTaskId}/approvals`))[0];await h.request(`/v1/tasks/${skill.approvalTaskId}/approvals/${approval.approvalId}`,{inputRevisionId:approval.inputRevisionId,targetIdentity:approval.targetIdentity,actionDigest:approval.actionDigest,approve:true},'bob');
  const trigger=await activate(h,await h.request('/v1/automations/triggers',{scopeId:'scp_lab',version:'1.0.0',name:'Synthetic source event trigger',kind:'event',sourceAssetId:source.assetId,eventName:'source.changed'})),active=await bot(h,skill,trigger);
  model.state.sequence=[{name:'skill',args:{name:'dynamic-source-reader'}},{name:'hub_tool_docs_get',args:{file:'/dav/manual.txt'}},{name:'write_file',args:{file_path:'out/reader.json',content:'{"done":true}'}}];
  await h.request(`/v1/connectors/${source.assetId}/events`,{externalId:'external-source-change',name:'source.changed',payload:{revision:'external-1'}});await h.startWorker();
  const first=await until(async()=>{const runs=await h.request(`/v1/automations/bots/${active.assetId}/runs`);return runs.length?runs[0]:false;});await h.phase(first.taskId,'delivered');await delay(250);
  assert.equal((await h.request(`/v1/automations/bots/${active.assetId}/runs`)).length,1,'Bot-origin source reads must not trigger another bot run');
  const observed=await until(async()=>{const found=await h.request('/v1/knowledge/search?mode=exact&q=/dav/manual.txt');return found.items.length===1?found:false;});assert.equal(observed.items.length,1,'Suppressing an observed event must preserve the source evidence and product observation');
  await h.request('/v1/tools/docs.get/call',{args:{file:'/dav/manual.txt'},idempotencyKey:'ordinary-read-new-source'});
  const second=await until(async()=>{const runs=await h.request(`/v1/automations/bots/${active.assetId}/runs`);return runs.length===2?runs[1]:false;});await h.phase(second.taskId,'delivered');await delay(250);
  assert.equal((await h.request(`/v1/automations/bots/${active.assetId}/runs`)).length,2);assert.equal(Number((await h.db.query('SELECT count(*) AS n FROM automation_events WHERE source_asset_id=$1',[source.assetId])).rows[0].n),2,'Only the external event and ordinary read create triggers');assert.ok(stub.state.documentReads>=3);
});
