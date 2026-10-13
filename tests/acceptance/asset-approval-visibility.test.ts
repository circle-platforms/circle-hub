import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setup} from './harness.ts';
import {externalTree,functionContract} from '../fixtures/command-source.ts';

async function environment(t:any){
  const h=await setup(t);await h.db.query("UPDATE policies SET grants=grants || '[\"assets.read\",\"assets.register\",\"assets.change\",\"credentials.register\",\"knowledge.read\"]'::jsonb WHERE principal_id='prn_alice'");
  await h.db.query("UPDATE policies SET grants=grants || '[\"assets.approve\",\"knowledge.read\"]'::jsonb WHERE principal_id=ANY($1::text[])",[['prn_bob','prn_limited','prn_outsider']]);
  const register=async()=>{const files=[];for(const [path,role,bytes] of [['commands.xml','command-tree',externalTree],['functions.json','function-contract',functionContract()]] as [string,string,Buffer][]){const original=await h.request('/v1/sources',{scopeId:'scp_lab',fileName:path,contentBase64:bytes.toString('base64')});files.push({path,role,sourceRevisionId:original.sourceRevisionId,sha256:original.sha256});}return h.request('/v1/source-artifacts',{scopeId:'scp_lab',name:'Synthetic pending source',version:'1.0.0',files,metadata:{buildName:'SYNTHETIC-BUILD-7'}});};
  return {h,register};
}

test('Asset approval visibility: same-scope approvers discover and approve a source without registration readers or a general asset read grant',async t=>{
  const {h,register}=await environment(t),source=await register();assert.equal(source.lifecycle,'draft');assert.equal(source.provenance.semanticQuality,'not-asserted');
  const page=await h.request('/v1/assets?kind=knowledge-source&lifecycle=draft',undefined,'bob');assert.equal(page.total,1);assert.equal(page.items[0].assetId,source.assetId);
  const view=await h.request(`/v1/source-artifacts/${source.assetId}`,undefined,'bob');assert.equal(view.sha256,source.sha256);assert.deepEqual(view.files,source.files);assert.equal((await h.request(`/v1/assets/${source.assetId}`,undefined,'bob')).ownerPrincipalId,'prn_alice');
  await h.reject(`/v1/assets/${source.assetId}/lifecycle`,{version:source.version,sha256:source.sha256,state:'approved'},'SELF_APPROVAL');
  const approved=await h.request(`/v1/assets/${source.assetId}/lifecycle`,{version:source.version,sha256:source.sha256,state:'approved'},'bob');assert.equal(approved.lifecycle,'approved');assert.match(approved.sourceArtifactId,/^sar_/);assert.equal((await h.request('/v1/assets?lifecycle=draft',undefined,'bob')).total,0);
  const owner=await h.request(`/v1/assets/${source.assetId}`);assert.deepEqual(owner.configuration.files.map((file:any)=>file.sha256),source.files.map((file:any)=>file.sha256));
});

test('Asset approval visibility: tenant scope live permission and private credentials still bound approval metadata',async t=>{
  const {h,register}=await environment(t),source=await register();
  for(const actor of ['limited','outsider']){assert.equal((await h.request('/v1/assets?lifecycle=draft',undefined,actor)).total,0);await h.reject(`/v1/source-artifacts/${source.assetId}`,undefined,'ASSET_NOT_VISIBLE',actor);await h.reject(`/v1/assets/${source.assetId}/lifecycle`,{version:source.version,sha256:source.sha256,state:'approved'},'ASSET_NOT_VISIBLE',actor);}
  await h.setRole('prn_admin',null);await h.setRole('prn_admin',null,'scp_second');assert.equal((await h.request('/v1/assets',undefined,'admin')).total,0);await h.reject(`/v1/assets/${source.assetId}`,undefined,'ASSET_NOT_VISIBLE','admin');
  const parent=await h.request('/v1/assets',{scopeId:'scp_lab',kind:'connector-instance',name:'Synthetic credential parent',version:'1.0.0',declaration:{reads:[],writes:[],credentials:[]},configuration:{}}),credential=await h.request(`/v1/assets/${parent.assetId}/credentials`,{version:'1.0.0',value:'synthetic-private-value'});await h.reject(`/v1/assets/${credential.assetId}`,undefined,'ASSET_NOT_VISIBLE','bob');assert.ok(!(await h.request('/v1/assets',undefined,'bob')).items.some((item:any)=>item.assetId===credential.assetId));
  await h.setRole('prn_bob','member');await h.reject(`/v1/assets/${source.assetId}`,undefined,'ASSET_NOT_VISIBLE','bob');assert.equal((await h.request('/v1/assets',undefined,'bob')).total,0);
});

test('Asset approval visibility: reviewing metadata does not grant original bytes or execution access and stale versions cannot be approved',async t=>{
  const {h,register}=await environment(t),source=await register();await h.db.query("UPDATE policies SET grants=grants || '[\"assets.read\"]'::jsonb WHERE principal_id='prn_bob'");
  await h.request(`/v1/assets/${source.assetId}`,undefined,'bob');await h.reject(`/v1/sources/${source.files[0].sourceRevisionId}/content`,undefined,'SOURCE_FORBIDDEN','bob');await h.reject(`/v1/knowledge/records/${source.files[0].sourceRecordId}`,undefined,'SOURCE_FORBIDDEN','bob');
  const definition=await h.request(`/v1/assets/${source.assetId}`),files=source.files.map((file:any)=>({path:file.path,role:file.role,sourceRevisionId:file.sourceRevisionId,sha256:file.sha256}));const changed=await h.request('/v1/assets',{assetId:source.assetId,scopeId:'scp_lab',kind:'knowledge-source',name:'Synthetic pending source',version:'1.0.1',declaration:definition.declaration,configuration:{schema:'external-source-artifact/1',files,metadata:{buildName:'SYNTHETIC-BUILD-8'}}});
  await h.reject(`/v1/assets/${source.assetId}/lifecycle`,{version:source.version,sha256:source.sha256,state:'approved'},'APPROVAL_STALE','bob');const approved=await h.request(`/v1/assets/${source.assetId}/lifecycle`,{version:changed.version,sha256:changed.sha256,state:'approved'},'bob');assert.equal(approved.version,'1.0.1');
  await h.reject(`/v1/assets/${source.assetId}`,undefined,'ASSET_NOT_VISIBLE','bob');await h.reject(`/v1/sources/${source.files[0].sourceRevisionId}/content`,undefined,'SOURCE_FORBIDDEN','bob');
  await h.reject('/v1/assets?lifecycle=waiting-review',undefined,'INVALID_PAYLOAD');
});
