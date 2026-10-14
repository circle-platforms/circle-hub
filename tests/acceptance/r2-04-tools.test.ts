import assert from 'node:assert/strict';
import {test} from 'node:test';
import {writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {sha256} from '../../packages/contracts/src/index.ts';
import {setup,type Harness} from './harness.ts';
import {readonlySources} from '../fixtures/readonly-sources.ts';

async function prepare(h:Harness,origin:string){
  const grants=['assets.read','assets.register','assets.change','credentials.register','credentials.use','builds.read','environment.read','knowledge.read','knowledge.submit'];
  await h.db.query('UPDATE policies SET grants=grants || $2::jsonb WHERE principal_id=$1',['prn_alice',JSON.stringify(grants)]);
  await h.db.query("UPDATE policies SET grants=grants || '[\"assets.read\",\"assets.approve\",\"knowledge.read\"]'::jsonb WHERE principal_id='prn_bob'");
  const profiles=`${h.scratch}/connector-profiles.json`;await writeFile(profiles,JSON.stringify({profiles:{synthetic:{origin,root:'/dav/',index:'/builds/'}}}),{mode:0o600});
  h.env.CIRCLE_HUB_CONNECTOR_PROFILES=profiles;await h.stop();await h.startServer();
}
async function asset(h:Harness,packageId:string,alias?:string){
  const item=await h.request('/v1/assets',{scopeId:'scp_lab',kind:'connector-instance',name:'Synthetic read source',version:'1.0.0',
    declaration:{reads:['registered-source'],writes:packageId==='knowledge'?['knowledge-candidates']:[],credentials:[]},configuration:{packageId,runtimeProfileRef:'synthetic',...(alias?{alias}:{})},readers:['prn_alice']});
  await h.request(`/v1/assets/${item.assetId}/lifecycle`,{version:item.version,sha256:item.sha256,state:'approved'},'bob');
  return h.request(`/v1/assets/${item.assetId}/lifecycle`,{version:item.version,sha256:item.sha256,state:'running'});
}
const call=(h:Harness,name:string,args:unknown={},key=randomBytes(12).toString('hex'))=>h.request(`/v1/tools/${name}/call`,{args,idempotencyKey:key});

test('Act R2.4: caller-filtered tool schemas aliases and ETags react to permission and lifecycle changes',async t=>{
  const stub=await readonlySources(t),h=await setup(t);await prepare(h,stub.origin);const source=await asset(h,'build-site');
  const token=await h.login(),first=await fetch(`${h.url}/v1/tools`,{headers:{authorization:`Bearer ${token}`}});
  assert.equal(first.status,200);const etag=first.headers.get('etag');assert.ok(etag);const tools=(await first.json() as any).data;
  for(const tool of tools){assert.match(tool.name,/^[a-z0-9._]+$/);assert.equal(tool.inputSchema.type,'object');assert.equal(tool.assetId,source.assetId);assert.equal(tool.assetVersion,'1.0.0');assert.equal(tool.effect,'read');assert.equal(tool.mode,'sync');}
  for(const name of ['buildsite.versions','buildsite.command_heads','buildsite.command_param','buildsite.command_check'])assert.ok(tools.some((x:any)=>x.name===name));
  assert.equal((await fetch(`${h.url}/v1/tools`,{headers:{authorization:`Bearer ${token}`,'if-none-match':etag!}})).status,304);
  assert.deepEqual(await h.request('/v1/tools',undefined,'bob'),[]);assert.deepEqual(await h.request('/v1/tools',undefined,'outsider'),[]);
  await h.reject('/v1/tools/buildsite.versions/call',{args:{},idempotencyKey:'forbidden-key'},'SOURCE_FORBIDDEN','bob');
  await h.reject('/v1/tools/hidden.tool/call',{args:{},idempotencyKey:'missing-key'},'SOURCE_FORBIDDEN','bob');
  await asset(h,'build-site','buildsite_second');
  await h.reject('/v1/assets',{scopeId:'scp_lab',kind:'connector-instance',name:'Duplicate',version:'1.0.0',declaration:{reads:[],writes:[],credentials:[]},configuration:{packageId:'build-site',runtimeProfileRef:'synthetic'}},'TOOL_NAME_CONFLICT');
  await h.request(`/v1/assets/${source.assetId}/lifecycle`,{version:source.version,sha256:source.sha256,state:'disabled'});
  const changed=await fetch(`${h.url}/v1/tools`,{headers:{authorization:`Bearer ${token}`,'if-none-match':etag!}});assert.equal(changed.status,200);assert.notEqual(changed.headers.get('etag'),etag);
  const alias=(await h.request('/v1/assets')).items.find((item:any)=>item.configuration.alias==='buildsite_second');await h.request(`/v1/assets/${alias.assetId}/lifecycle`,{version:alias.version,sha256:alias.sha256,state:'disabled'});assert.deepEqual(await h.request('/v1/tools'),[]);
});

test('Act R2.4: read tools execute on a fenced worker and persist input/output originals before returning',async t=>{
  const stub=await readonlySources(t),h=await setup(t);stub.state.expandedCommands=true;await prepare(h,stub.origin);await asset(h,'build-site');await h.startWorker();
  const versions=await call(h,'buildsite.versions',{versionLine:'10.5'});assert.equal(versions.result.builds.length,4);assert.ok(versions.evidence.length>0);
  const heads=await call(h,'buildsite.command_heads',{build:'Rel_PHOTON_10_5_0_101',prefix:'service'});assert.ok(heads.result.heads.length>=30);
  const parameter=await call(h,'buildsite.command_param',{build:'Rel_PHOTON_10_5_0_101',head:'service create port 443'});assert.equal(parameter.result.head,'service create port');assert.equal(parameter.result.parameters[0].type,'U16');
  const key='stable-command-check',input={build:'Rel_PHOTON_10_5_0_101',commands:['SERVICE CREATE PORT 443','service create port 65536','service create address 999.1.1.1','service create name "Example Value"','service create mode wrong','feature absent']};
  const checked=await call(h,'buildsite.command_check',input,key);assert.deepEqual(checked.result.commands.map((x:any)=>x.status),['hit','hit','hit','hit','hit','missing']);
  assert.equal(checked.result.commands[0].violations.length,0);assert.equal(checked.result.commands[1].violations[0].code,'OUT_OF_RANGE');assert.equal(checked.result.commands[2].violations[0].code,'TYPE_MISMATCH');assert.equal(checked.result.commands[4].violations[0].code,'ENUM_MISMATCH');
  const count=Number((await h.db.query('SELECT count(*) AS n FROM operations')).rows[0].n),again=await call(h,'buildsite.command_check',input,key);assert.deepEqual(again,checked);assert.equal(Number((await h.db.query('SELECT count(*) AS n FROM operations')).rows[0].n),count);
  await h.reject('/v1/tools/buildsite.command_check/call',{args:{...input,commands:['changed']},idempotencyKey:key},'IDEMPOTENCY_MISMATCH');
  const missing=await call(h,'buildsite.command_check',{build:'Rel_PHOTON_10_5_0_109',commands:['feature.enable']});assert.equal(missing.result.commands[0].status,'missing');
  stub.state.headCount=140;stub.state.changedBuild='Rel_PHOTON_10_5_0_101';const tooLarge=await h.reject('/v1/tools/buildsite.command_heads/call',{args:{build:'Rel_PHOTON_10_5_0_101',prefix:'service'},idempotencyKey:'oversized-heads'},'RESULT_TOO_LARGE');assert.equal(tooLarge.details.outcome,'result_too_large');assert.equal(tooLarge.details.limit,128);
  for(const ref of checked.evidence){const response=await fetch(`${h.url}/v1/knowledge/records/${ref.evidenceId}/content`,{headers:{authorization:`Bearer ${await h.login()}`}});assert.equal(response.status,200);assert.equal(sha256(Buffer.from(await response.arrayBuffer())),ref.sha256);}
  await h.stop();await h.startServer();assert.deepEqual(await call(h,'buildsite.command_check',input,key),checked);
});

test('Act R2.4: manuals expose line and command-section evidence and mirror calls inject private credentials',async t=>{
  const stub=await readonlySources(t),h=await setup(t);stub.state.manualText='# Synthetic manual\n**service create port**\nSet a synthetic port.\n**service create name**\nSet a synthetic label.';await prepare(h,stub.origin);await asset(h,'documents');const mirror=await asset(h,'query-mirror');
  const credential=await h.request(`/v1/assets/${mirror.assetId}/credentials`,{version:'1.0.0',value:stub.secret});
  const revised=await h.request('/v1/assets',{assetId:mirror.assetId,scopeId:'scp_lab',kind:'connector-instance',name:'Synthetic mirror',version:'2.0.0',declaration:{reads:['registered-source'],writes:[],credentials:[credential.assetId]},configuration:{packageId:'query-mirror',runtimeProfileRef:'synthetic'},readers:['prn_alice','prn_bob']});
  await h.request(`/v1/assets/${mirror.assetId}/lifecycle`,{version:revised.version,sha256:revised.sha256,state:'approved'},'bob');await h.request(`/v1/assets/${mirror.assetId}/lifecycle`,{version:revised.version,sha256:revised.sha256,state:'running'});await h.startWorker();
  const hits=await call(h,'docs.search',{query:'service create port'});assert.equal(hits.result.hits[0].line,2);
  const section=await call(h,'docs.section',{file:'/dav/manual.txt',anchor:'service create port'});assert.ok(section.result.lines[0].text.startsWith('**service create port**'));assert.ok(section.result.lines.length<=80);
  const detail=await call(h,'zentao.bug_detail',{ids:[51]});assert.equal(detail.result.items[0].id,'51');assert.ok(stub.requests.filter(r=>r.path.startsWith('/plmquery/')).every(r=>r.authorization===stub.secret));
  const products=await call(h,'zentao.products');assert.deepEqual(products.result.items,[{id:7,name:'Synthetic product'}]);
  const hint=await h.reject('/v1/tools/zentao.bug_search/call',{args:{keyword:'port'},idempotencyKey:'missing-product-filter'},'INVALID_PAYLOAD');assert.ok(hint.details.issues.some((issue:any)=>issue.message.includes('product')));
  const dump=JSON.stringify((await h.db.query('SELECT result,args FROM operations')).rows);assert.ok(!dump.includes(stub.secret));
  await asset(h,'environment-view');const environment=await call(h,'env.inventory',{});assert.equal(environment.result[0].id,'lab-a');assert.ok(environment.evidence.length>0);
  await h.reject('/v1/tools/buildsite.command_param/call',{args:{},idempotencyKey:'bad-schema'},'SOURCE_FORBIDDEN');
});

test('Act R2.4: candidate submission is a durable task with one result and replayable events',async t=>{
  const stub=await readonlySources(t),h=await setup(t);stub.state.manualText='# Synthetic manual\n**service create port**\nSet a synthetic port.';await prepare(h,stub.origin);await asset(h,'documents');await asset(h,'knowledge');await h.startWorker();
  const docs=await call(h,'docs.search',{query:'service create port'});
  const accepted=await call(h,'knowledge.claim_submit',{claim:{subject:'synthetic-port',predicate:'command-presence',value:true},evidence:docs.evidence});assert.ok(accepted.taskId);assert.ok(accepted.phase);
  const task=await h.phase(accepted.taskId,'delivered'),result=await h.request(`/v1/tasks/${task.taskId}/result`);assert.equal(result.result.state,'candidate');assert.equal(result.result.knowledgeCategory,'consolidated');
  await h.reject(`/v1/tasks/${task.taskId}/status`,undefined,'FORBIDDEN_SCOPE','bob');await h.reject(`/v1/tasks/${task.taskId}/events?after=0`,undefined,'FORBIDDEN_SCOPE','bob');
  assert.ok(!(await h.request('/v1/tasks',undefined,'bob')).some((item:any)=>item.taskId===task.taskId));
  const page=await h.request(`/v1/tasks/${task.taskId}/events?after=0`);assert.ok(page.events.some((e:any)=>e.kind==='task.delivered'));const last=page.after;
  await h.stop();await h.startServer();assert.equal((await h.request(`/v1/tasks/${task.taskId}/events?after=${last}`)).events.length,0);
  const stored=await h.request(`/v1/knowledge/records/${result.result.recordId}`);assert.equal(stored.visibility,'personal');assert.equal(stored.state,'candidate');
});
