import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {sha256} from '../../packages/contracts/src/index.ts';
import {setup,until,type Harness} from './harness.ts';
import {readonlySources} from '../fixtures/readonly-sources.ts';

async function prepare(h:Harness,origin:string){
  const grants=['assets.read','assets.register','assets.change','assets.approve','builds.read','docs.fetch','knowledge.read','knowledge.ingest','knowledge.submit','knowledge.publish','credentials.register','credentials.use','environment.read'];
  await h.db.query('UPDATE policies SET grants=grants || $1::jsonb WHERE principal_id=ANY($2::text[])',[JSON.stringify(grants),['prn_alice','prn_bob']]);
  await h.db.query("UPDATE policies SET grants=grants || '[\"assets.read\",\"assets.approve\"]'::jsonb WHERE principal_id='prn_admin'");
  await writeFile(`${h.scratch}/profiles.json`,JSON.stringify({profiles:{fixture:{origin,root:'/dav/',index:'/builds/',requestIntervalMs:0}}}),{mode:0o600});h.env.CIRCLE_SERVER_CONNECTOR_PROFILES=`${h.scratch}/profiles.json`;await h.stop();await h.startServer();
}
async function asset(h:Harness,packageId:string,version='1.0.0',assetId?:string,readers=['prn_alice','prn_bob']){
  const value=await h.request('/v1/assets',{assetId,scopeId:'scp_lab',kind:'connector-instance',name:'Synthetic product authority',version,declaration:{reads:['registered-source'],writes:[],credentials:[]},configuration:{packageId,runtimeProfileRef:'fixture'},readers});
  await h.request(`/v1/assets/${value.assetId}/lifecycle`,{version:value.version,sha256:value.sha256,state:'approved'},readers.includes('prn_bob')?'bob':'admin');return h.request(`/v1/assets/${value.assetId}/lifecycle`,{version:value.version,sha256:value.sha256,state:'running'});
}
async function call(h:Harness,name:string,args:unknown,username='alice'){
  const result=await h.request(`/v1/tools/${name}/call`,{args,idempotencyKey:randomBytes(12).toString('hex')},username);
  await until(async()=>{const jobs=(await h.db.query('SELECT status,error FROM knowledge_projection_jobs')).rows;assert.ok(!jobs.some(job=>job.status==='failed'),JSON.stringify(jobs));return jobs.every(job=>job.status==='succeeded');});return result;
}

test('Act R2.3 ingestion: a connector read automatically pins six product records and publishes only its current structural observations',async t=>{
  const stub=await readonlySources(t),h=await setup(t);stub.state.manualText='Synthetic source states a port procedure';await prepare(h,stub.origin);const docs=await asset(h,'documents');await h.startWorker();
  const read=await call(h,'docs.get',{file:'/dav/manual.txt'}),found=await h.request('/v1/knowledge/search?mode=exact&q=/dav/manual.txt');assert.equal(found.items.length,1,'A successful read must enter searchable product knowledge without a manual ingestion ceremony');
  const official=found.items[0];assert.equal(official.knowledgeCategory,'product');assert.equal(official.payload.predicate,'document-text');assert.equal(official.payload.value,stub.state.manualText);assert.equal(official.payload.origin,'script');assert.equal(official.state,'reviewed');
  const evidence=await h.request(`/v1/knowledge/records/${official.payload.evidenceIds[0]}`),source=await h.request(`/v1/knowledge/records/${evidence.payload.sourceRecordId}`);assert.equal(source.sha256,sha256(stub.state.manualText));assert.equal(source.payload.asset.assetId,docs.assetId);assert.ok(read.evidence.some((ref:any)=>ref.evidenceId===evidence.recordId));
  const snapshot=await h.request(`/v1/knowledge/records/${official.snapshotId}`),kinds=new Set([snapshot.kind,...snapshot.payload.records.map((record:any)=>record.kind)]);assert.deepEqual([...kinds].sort(),['Assessment','Claim','Entity','Evidence','KnowledgeSnapshot','SourceRevision']);
  const assessments=snapshot.payload.records.filter((record:any)=>record.kind==='Assessment');const assessment=await h.request(`/v1/knowledge/records/${assessments[0].recordId}`);assert.equal(assessment.payload.assessor,'script');assert.equal(assessment.payload.checks.semantic,'not-asserted');
  const counts=(await h.db.query('SELECT kind,count(*) AS n FROM knowledge_records GROUP BY kind ORDER BY kind')).rows;await call(h,'docs.get',{file:'/dav/manual.txt'});assert.deepEqual((await h.db.query('SELECT kind,count(*) AS n FROM knowledge_records GROUP BY kind ORDER BY kind')).rows,counts,'Unchanged reads reuse source projections and the snapshot');
  stub.state.manualText='Synthetic source changed its port procedure';await call(h,'docs.get',{file:'/dav/manual.txt'});const changed=await h.request('/v1/knowledge/search?mode=exact&q=/dav/manual.txt');assert.equal(changed.items.length,1);assert.equal(changed.items[0].payload.value,stub.state.manualText);assert.notEqual(changed.items[0].recordId,official.recordId);assert.notEqual(changed.items[0].snapshotId,official.snapshotId);
  assert.equal((await h.request(`/v1/knowledge/records/${official.recordId}`)).payload.value,'Synthetic source states a port procedure','Historical bytes and statements remain immutable');
  await h.stop();await h.startServer();assert.equal((await h.request('/v1/knowledge/search?mode=exact&q=/dav/manual.txt')).items[0].recordId,changed.items[0].recordId);
  await h.startWorker();stub.state.manualText='Synthetic source states a port procedure';await call(h,'docs.get',{file:'/dav/manual.txt'});assert.equal((await h.request('/v1/knowledge/search?mode=exact&q=/dav/manual.txt')).items[0].recordId,official.recordId,'Reobserving old bytes uses a new head generation and restores its original statement');
});

test('Act R2.3 ingestion: program observations do not grant source access and command facts stay bound to an exact build',async t=>{
  const stub=await readonlySources(t),h=await setup(t);stub.state.expandedCommands=true;await prepare(h,stub.origin);const docs=await asset(h,'documents');await asset(h,'build-site');await h.startWorker();
  await call(h,'docs.get',{file:'/dav/manual.txt'},'bob');assert.equal((await h.request('/v1/knowledge/search?mode=exact&q=/dav/manual.txt',undefined,'bob')).items.length,1);assert.equal((await h.request('/v1/knowledge/search?mode=exact&q=/dav/manual.txt')).items.length,0);
  await asset(h,'documents','2.0.0',docs.assetId,['prn_alice','prn_admin']);assert.equal((await h.request('/v1/knowledge/search?mode=exact&q=/dav/manual.txt',undefined,'bob')).items.length,0,'A platform source ACL change hides its old derived records');
  await call(h,'buildsite.command_param',{build:'Rel_PHOTON_10_5_0_101',head:'service create port 443'});const commands=await h.request('/v1/knowledge/search?mode=exact&q=command:Rel_PHOTON_10_5_0_101:service%20create%20port');assert.equal(commands.items.length,1);assert.equal(commands.items[0].payload.conditions.build,'Rel_PHOTON_10_5_0_101');assert.equal(commands.items[0].payload.value.parameters[0].type,'U16');
  const versions=await call(h,'buildsite.versions',{versionLine:'10.5'});assert.equal(versions.result.builds.length,4);const releases=await h.request('/v1/knowledge/search?mode=exact&q=build:Rel_PHOTON_10_5_0_109');assert.equal(releases.items.length,1);assert.equal(releases.items[0].payload.value.formal,true);assert.ok(releases.items[0].payload.value.releasedOn);
});

test('Act R2.3 ingestion: shared and model source types cannot bypass consent by claiming to be product knowledge',async t=>{
  const h=await setup(t);await prepare(h,'http://127.0.0.1');const bytes=Buffer.from('Synthetic model footprint');
  for(const sourceType of ['shared-session','footprint'])await h.reject('/v1/knowledge/sources',{scopeId:'scp_lab',sourceId:'synthetic-footprint',revision:'1',path:'synthetic/footprint.txt',knowledgeCategory:'product',sourceType,parserVersion:'synthetic/1',contentBase64:bytes.toString('base64'),acl:{sourceReaders:['prn_alice'],platformReaders:['prn_alice']}},'INVALID_PAYLOAD');
  const source=await h.request('/v1/knowledge/sources',{scopeId:'scp_lab',sourceId:'synthetic-footprint',revision:'1',path:'synthetic/footprint.txt',knowledgeCategory:'consolidated',sourceType:'footprint',parserVersion:'synthetic/1',contentBase64:bytes.toString('base64'),acl:{sourceReaders:['prn_alice'],platformReaders:['prn_alice']},sharing:{allowed:true,teamPromotion:false}});
  const evidence=await h.request('/v1/knowledge/evidence',{sourceRecordId:source.recordId,start:0,end:bytes.length}),claim=await h.request('/v1/knowledge/claims',{scopeId:'scp_lab',subject:'synthetic-model-footprint',predicate:'proposed',value:true,evidenceIds:[evidence.recordId],origin:'model'});
  const snapshot=await h.request('/v1/knowledge/snapshots',{scopeId:'scp_lab',knowledgeCategory:'consolidated',expectedSnapshotId:null});assert.ok(!snapshot.payload.records.some((record:any)=>record.recordId===claim.recordId));assert.equal(claim.state,'candidate');assert.equal(claim.visibility,'personal');
});

test('Act R2.3 ingestion: mirror and environment projections retain source evidence without widening personal credential visibility',async t=>{
  const stub=await readonlySources(t),h=await setup(t);await prepare(h,stub.origin);const mirror=await asset(h,'query-mirror');
  const credential=await h.request(`/v1/assets/${mirror.assetId}/credentials`,{version:'1.0.0',value:stub.secret});
  const revised=await h.request('/v1/assets',{assetId:mirror.assetId,scopeId:'scp_lab',kind:'connector-instance',name:'Synthetic credentialed mirror',version:'2.0.0',declaration:{reads:['registered-source'],writes:[],credentials:[credential.assetId]},configuration:{packageId:'query-mirror',runtimeProfileRef:'fixture'},readers:['prn_alice','prn_bob']});
  await h.request(`/v1/assets/${mirror.assetId}/lifecycle`,{version:revised.version,sha256:revised.sha256,state:'approved'},'bob');await h.request(`/v1/assets/${mirror.assetId}/lifecycle`,{version:revised.version,sha256:revised.sha256,state:'running'});await asset(h,'environment-view');await h.startWorker();
  const read=await call(h,'zentao.bug_detail',{ids:[51]}),found=await h.request('/v1/knowledge/search?mode=exact&q=issue:51');assert.equal(found.items.length,1);assert.deepEqual(found.items[0].payload.value,read.result.items[0]);assert.equal(found.items[0].sourceType,'query-mirror');
  const quote=await h.request(`/v1/knowledge/records/${found.items[0].payload.evidenceIds[0]}`);assert.ok(read.evidence.some((ref:any)=>ref.evidenceId===quote.recordId&&ref.sha256===quote.sha256));assert.equal((await h.request('/v1/knowledge/search?mode=exact&q=issue:51',undefined,'bob')).items.length,0);
  await call(h,'zentao.bug_search',{});assert.equal((await h.request('/v1/knowledge/search?mode=exact&q=issue:51')).items.length,2);
  stub.state.mirrorIds=[];assert.equal((await call(h,'zentao.bug_search',{})).result.items.length,0);const current=await h.request('/v1/knowledge/search?mode=exact&q=issue:51');assert.equal(current.items.length,1,'An empty revision must remove the prior list observation while retaining the independent detail');assert.equal(current.items[0].payload.conditions.projectionKind,'detail');
  await h.request(`/v1/assets/${credential.assetId}/lifecycle`,{version:credential.version,sha256:credential.sha256,state:'disabled'});assert.equal((await h.request('/v1/knowledge/search?mode=exact&q=issue:51')).items.length,0,'Disabled source credentials revoke derived access');
  const environment=await call(h,'env.inventory',{}),inventory=await h.request('/v1/knowledge/search?mode=prefix&q=environment:');assert.equal(inventory.items.length,1);assert.deepEqual(inventory.items[0].payload.value,environment.result);assert.equal(inventory.items[0].sourceType,'environment-view');
});

test('Act R2.3 ingestion: the async migration rebuilds existing product snapshot membership without losing reviewed records',async t=>{
  const stub=await readonlySources(t),h=await setup(t);await prepare(h,stub.origin);await asset(h,'documents');await asset(h,'environment-view');const worker=await h.startWorker();
  await call(h,'docs.get',{file:'/dav/manual.txt'});const original=(await h.request('/v1/knowledge/search?mode=exact&q=/dav/manual.txt')).items[0];
  await h.stop(worker);await h.stop();
  // Recreate the pre-outbox schema around a sealed source/claim/snapshot closure.
  await h.db.query('DROP TABLE knowledge_projection_members,knowledge_projection_jobs,knowledge_active_statements,knowledge_indexed_sources');await h.db.query('ALTER TABLE knowledge_source_heads DROP COLUMN generation');await h.db.query('DELETE FROM schema_migrations WHERE version=19');
  await h.startServer();assert.ok(Number((await h.db.query('SELECT count(*) AS n FROM knowledge_active_statements WHERE claim_id=$1',[original.recordId])).rows[0].n)>0);
  await h.startWorker();await call(h,'env.inventory',{});const preserved=await h.request('/v1/knowledge/search?mode=exact&q=/dav/manual.txt');assert.equal(preserved.items.length,1);assert.equal(preserved.items[0].recordId,original.recordId);
});
