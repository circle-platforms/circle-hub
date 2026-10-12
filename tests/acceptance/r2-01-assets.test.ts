import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {setup,type Harness} from './harness.ts';

async function grants(h:Harness){
  await h.db.query("UPDATE policies SET grants=grants||$1::jsonb WHERE principal_id=ANY($2::text[])",[JSON.stringify(['assets.read','assets.register','assets.change','assets.check','credentials.register','credentials.use']),['prn_alice','prn_bob']]);
  await h.db.query("UPDATE policies SET grants=grants||$1::jsonb WHERE principal_id='prn_bob'",[JSON.stringify(['assets.approve'])]);
  await h.db.query("UPDATE policies SET grants=grants||$1::jsonb WHERE principal_id=ANY($2::text[])",[JSON.stringify(['assets.read']),['prn_limited','prn_outsider']]);
}
const registration={scopeId:'scp_lab',kind:'connector-instance',name:'Synthetic read source',version:'1.0.0',
  declaration:{reads:['source-records'],writes:[],credentials:[]},configuration:{packageId:'fixture-reader',runtimeProfileRef:'profile_synthetic'},readers:['prn_alice','prn_bob']};

test('R2 Act 1: register assets and write-only personal credentials without exposing values in metadata audit or logs',async t=>{
  const h=await setup(t);await grants(h);let logs='';h.server!.stdout!.on('data',data=>{logs+=data.toString();});h.server!.stderr!.on('data',data=>{logs+=data.toString();});
  const asset=await h.request('/v1/assets',registration);assert.equal(asset.kind,'connector-instance');assert.equal(asset.ownerPrincipalId,'prn_alice');assert.equal(asset.lifecycle,'draft');assert.match(asset.sha256,/^[a-f0-9]{64}$/);
  const value=randomBytes(48).toString('base64url');
  const credential=await h.request(`/v1/assets/${asset.assetId}/credentials`,{version:'1.0.0',value});
  assert.equal(credential.kind,'credential-reference');assert.equal(credential.ownerPrincipalId,'prn_alice');assert.equal(credential.configuration.connectorAssetId,asset.assetId);
  const view=await h.request(`/v1/assets/${credential.assetId}`);
  const list=await h.request('/v1/assets');assert.equal(list.items.length,2);
  const audit=await h.request('/v1/admin/audit',undefined,'admin');
  for(const output of [credential,view,list,audit])assert.equal(JSON.stringify(output).includes(value),false);
  assert.equal(logs.includes(value),false);
  const files=await readdir(`${h.scratch}/objects/private-credentials`);
  assert.ok(files.some(file=>file.endsWith('.sealed')));
  for(const file of files)assert.equal((await readFile(`${h.scratch}/objects/private-credentials/${file}`,'utf8')).includes(value),false);
  const health=await h.request(`/v1/assets/${credential.assetId}/health`,{});assert.equal(health.health.result,'available');assert.ok(health.health.checkedAt);
  assert.equal(JSON.stringify(health).includes(value),false);
  const forbidden=await h.raw(`/v1/assets/${credential.assetId}`,{token:await h.login('bob')});assert.equal(forbidden.status,404);assert.equal(forbidden.body.error.code,'ASSET_NOT_VISIBLE');
  await h.reject(`/v1/assets/${asset.assetId}/credentials`,{version:'2.0.0',value,ownerPrincipalId:'prn_bob'},'FORBIDDEN_ACTION');
  await h.reject('/v1/assets',{...registration,configuration:{token:value}},'INVALID_PAYLOAD');
  assert.equal(logs.includes(value),false);
});

test('R2 Act 1: asset lifecycle approvals bind the version digest and scope and cannot be self approved',async t=>{
  const h=await setup(t);await grants(h);
  const first=await h.request('/v1/assets',registration);
  await h.reject(`/v1/assets/${first.assetId}/lifecycle`,{version:first.version,sha256:first.sha256,state:'approved',principalId:'prn_bob'},'SELF_APPROVAL');
  await h.reject(`/v1/assets/${first.assetId}/lifecycle`,{version:first.version,sha256:'0'.repeat(64),state:'approved'},'APPROVAL_STALE','bob');
  const approved=await h.request(`/v1/assets/${first.assetId}/lifecycle`,{version:first.version,sha256:first.sha256,state:'approved'},'bob');assert.equal(approved.lifecycle,'approved');
  const running=await h.request(`/v1/assets/${first.assetId}/lifecycle`,{version:first.version,sha256:first.sha256,state:'running'});assert.equal(running.lifecycle,'running');
  const second=await h.request('/v1/assets',{...registration,assetId:first.assetId,version:'2.0.0',declaration:{...registration.declaration,reads:['source-records','extra-records']}});
  assert.equal(second.lifecycle,'draft');assert.notEqual(second.sha256,first.sha256);
  await h.reject(`/v1/assets/${first.assetId}/lifecycle`,{version:second.version,sha256:first.sha256,state:'running'},'APPROVAL_STALE');
  await h.reject(`/v1/assets/${first.assetId}/lifecycle`,{version:second.version,sha256:second.sha256,state:'running'},'APPROVAL_REQUIRED');
  await h.reject('/v1/assets',{...registration,assetId:first.assetId,version:first.version,name:'Mutated published version'},'IDEMPOTENCY_MISMATCH');
  const disabled=await h.request(`/v1/assets/${first.assetId}/lifecycle`,{version:second.version,sha256:second.sha256,state:'disabled'});assert.equal(disabled.lifecycle,'disabled');
  const hidden=await h.raw(`/v1/assets/${first.assetId}`,{token:await h.login('outsider')});assert.equal(hidden.status,404);assert.equal(hidden.body.error.code,'ASSET_NOT_VISIBLE');
});

test('R2 Act 1: asset queries filter before pagination and health reports missing handlers honestly',async t=>{
  const h=await setup(t);await grants(h);
  const visible=await h.request('/v1/assets',registration);
  const pending=await h.request('/v1/assets',{...registration,name:'Owner-only synthetic asset',readers:['prn_alice']});
  const list=await h.request('/v1/assets?limit=1',undefined,'bob');assert.equal(list.total,2);assert.equal(list.items.length,1);assert.ok(list.nextCursor);
  const next=await h.request(`/v1/assets?limit=1&after=${list.nextCursor}`,undefined,'bob');assert.deepEqual(new Set([...list.items,...next.items].map((item:any)=>item.assetId)),new Set([visible.assetId,pending.assetId]));assert.equal(next.nextCursor,null);
  await h.request(`/v1/assets/${pending.assetId}/lifecycle`,{version:pending.version,sha256:pending.sha256,state:'approved'},'bob');assert.equal((await h.request('/v1/assets',undefined,'bob')).total,1);
  const health=await h.request(`/v1/assets/${visible.assetId}/health`,{});assert.equal(health.health.result,'unknown');assert.equal(health.health.reason,'checker-not-registered');
  for(const limit of ['0','101','1.5',''])await h.reject(`/v1/assets?limit=${limit}`,undefined,'INVALID_PAYLOAD');
  await h.db.query("UPDATE policies SET grants=grants-'assets.read' WHERE principal_id='prn_bob'");
  assert.equal((await h.request('/v1/assets',undefined,'bob')).items[0].assetId,visible.assetId);
  await h.db.query("UPDATE policies SET grants=grants-'assets.approve' WHERE principal_id='prn_bob'");
  await h.reject('/v1/assets',undefined,'FORBIDDEN_ACTION','bob');
  await h.reject('/v1/assets',undefined,'FORBIDDEN_ACTION','lab-east-01');
});
