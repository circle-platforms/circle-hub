import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {EnterpriseTypesV1} from '../../packages/object-types/src/enterprise-v1.ts';
import {setup,type Harness} from './harness.ts';

async function authorize(h:Harness){
  await h.db.query("UPDATE policies SET grants=grants||$1::jsonb WHERE principal_id='prn_admin'",[JSON.stringify(['objects.manage','objects.ingest','objects.read'])]);
  await h.db.query("UPDATE policies SET grants=grants||$1::jsonb WHERE principal_id=ANY($2::text[])",[JSON.stringify(['objects.read']),['prn_alice','prn_bob','prn_limited','prn_outsider']]);
  await h.request('/v1/admin/object-types',EnterpriseTypesV1,'admin');
}
const acl=(readers=['prn_admin','prn_alice'])=>({sourceReaders:readers,platformReaders:readers});
function observation(key:string,source='tracker-a',sourceType='issue',externalId='42'){
  const attributes={title:'Synthetic observed issue',state:'resolved',resolution:'fixed'};
  return {scopeId:'scp_lab',observationKey:key,source:{system:source,objectType:sourceType,externalId,revision:'rev-one',
    contentBase64:Buffer.from(JSON.stringify(attributes)).toString('base64')},type:{packageId:'enterprise-basics',version:'1.0.0',typeId:'defect'},attributes,acl:acl()};
}
const observe=(h:Harness,input:any)=>h.request('/v1/admin/objects/observe',input,'admin');

test('S2 objects preserve compound source identities, immutable observations, original SHA and registered type versions',async t=>{
  const h=await setup(t);await authorize(h);
  const input=observation('capture-one'),first=await observe(h,input);
  const repeat=await observe(h,input);assert.equal(repeat.entity.entityId,first.entity.entityId);assert.equal(repeat.observation.entityRevisionId,first.observation.entityRevisionId);assert.equal(repeat.deduplicated,true);
  await h.reject('/v1/admin/objects/observe',{...input,attributes:{...input.attributes,title:'Changed without a new observation key'}},'IDEMPOTENCY_MISMATCH','admin');
  const other=await observe(h,observation('capture-one','tracker-b'));
  const requirement=await observe(h,{...observation('capture-one','tracker-b','story'),type:{...input.type,typeId:'requirement'},attributes:{title:'Synthetic requirement',state:'open'}});
  assert.equal(new Set([first.entity.entityId,other.entity.entityId,requirement.entity.entityId]).size,3);
  const revisedAttributes={...input.attributes,state:'verified'};
  const next=await observe(h,{...input,observationKey:'capture-two',source:{...input.source,revision:'rev-two',contentBase64:Buffer.from(JSON.stringify(revisedAttributes)).toString('base64')},attributes:revisedAttributes});
  assert.equal(next.entity.entityId,first.entity.entityId);assert.notEqual(next.observation.entityRevisionId,first.observation.entityRevisionId);
  const current=await h.request(`/v1/objects/${first.entity.entityId}`);assert.equal(current.attributes.state,'verified');
  const history=await h.request(`/v1/objects/${first.entity.entityId}/observations`);assert.equal(history.length,2);
  assert.equal(history[1].attributes.state,'resolved');assert.equal(history[0].source.revision,'rev-two');
  const raw=Buffer.from(input.source.contentBase64,'base64'),digest=createHash('sha256').update(raw).digest('hex');
  assert.equal(first.observation.raw.sha256,digest);
  const response=await fetch(`${h.url}/v1/sources/${first.observation.raw.sourceRevisionId}/content`,{headers:{authorization:`Bearer ${await h.login()}`}});
  assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),raw);
  const custom={id:'custom-vocabulary',version:'1.0.0',types:[{id:'widget',attributes:{label:'string'},required:['label']}]};
  await h.request('/v1/admin/object-types',custom,'admin');
  const widget=await observe(h,{...observation('widget-one','inventory-a','widget','7'),type:{packageId:custom.id,version:custom.version,typeId:'widget'},attributes:{label:'Synthetic widget'}});
  assert.equal(widget.entity.type.typeId,'widget');
  const packs=await h.request('/v1/object-types');assert.equal(packs.length,2);
  assert.ok(packs.some((pack:any)=>pack.id===custom.id&&/^[a-f0-9]{64}$/.test(pack.sha256)));
});

test('S2 objects filter both source and platform rights before counts and relation traversal and guard original bytes',async t=>{
  const h=await setup(t);await authorize(h);
  const visible=await observe(h,observation('visible-one'));
  const hiddenInput={...observation('hidden-one','tracker-a','issue','99'),attributes:{title:'Private synthetic title',state:'open'},acl:acl(['prn_admin'])};
  hiddenInput.source.contentBase64=Buffer.from(JSON.stringify(hiddenInput.attributes)).toString('base64');
  const hidden=await observe(h,hiddenInput);
  const platformDenied=await observe(h,{...observation('platform-denied','tracker-a','issue','100'),acl:{sourceReaders:['prn_admin','prn_alice'],platformReaders:['prn_admin']}});
  const changeInput={...observation('change-one','vcs-a','change','c1'),type:{packageId:'enterprise-basics',version:'1.0.0',typeId:'change'},attributes:{title:'Synthetic mainline change',branch:'main',merged:true}};
  changeInput.source.contentBase64=Buffer.from(JSON.stringify(changeInput.attributes)).toString('base64');
  const change=await observe(h,changeInput);
  const relation=(key:string,to:string)=>({scopeId:'scp_lab',observationKey:key,type:'fixed-by',fromEntityId:visible.entity.entityId,toEntityId:to,
    source:{system:'vcs-a',objectType:'reference',externalId:key,revision:'rel-one',contentBase64:Buffer.from(JSON.stringify({reference:key})).toString('base64')},acl:acl()});
  const edge=await h.request('/v1/admin/objects/relations',relation('link-visible',change.entity.entityId),'admin');
  await h.request('/v1/admin/objects/relations',relation('link-hidden',hidden.entity.entityId),'admin');
  const list=await h.request('/v1/objects?typeId=defect&limit=1');assert.equal(list.total,1);assert.deepEqual(list.items.map((item:any)=>item.entityId),[visible.entity.entityId]);
  const edges=await h.request(`/v1/objects/${visible.entity.entityId}/relations?limit=1`);assert.equal(edges.total,1);assert.equal(edges.items[0].relationId,edge.relationId);
  assert.equal(edges.items[0].toEntityId,change.entity.entityId);
  assert.equal((await h.request('/v1/objects?typeId=defect',undefined,'bob')).total,0);
  const token=await h.login();
  const absent=await h.raw('/v1/objects/ent_missing',{token});assert.equal(absent.status,404);assert.equal(absent.body.error.code,'OBJECT_NOT_VISIBLE');
  for(const entity of [hidden.entity,platformDenied.entity]){
    for(const suffix of ['', '/observations','/relations']){
      const denied=await h.raw(`/v1/objects/${entity.entityId}${suffix}`,{token});assert.equal(denied.status,404);assert.deepEqual(denied.body.error,absent.body.error);
    }
  }
  assert.equal((await h.raw(`/v1/sources/${hidden.observation.raw.sourceRevisionId}/content`,{token})).body.error.code,'OBJECT_NOT_VISIBLE');
  for(const name of ['limited','outsider']){
    const denied=await h.raw(`/v1/objects/${visible.entity.entityId}`,{token:await h.login(name)});assert.equal(denied.status,404);assert.deepEqual(denied.body.error,absent.body.error);
    assert.equal((await h.request('/v1/objects',undefined,name)).total,0);
  }
  await observe(h,{...observation('visible-revoked'),acl:acl(['prn_admin'])});
  assert.equal((await h.raw(`/v1/objects/${visible.entity.entityId}`,{token})).body.error.code,'OBJECT_NOT_VISIBLE');
  const revokedRaw=await h.raw(`/v1/sources/${visible.observation.raw.sourceRevisionId}/content`,{token});
  assert.equal(revokedRaw.status,404);assert.equal(revokedRaw.body.error.code,'OBJECT_NOT_VISIBLE');
  const publicInput={...hiddenInput,observationKey:'public-revision',source:{...hiddenInput.source,revision:'public-two'},
    attributes:{title:'New public synthetic title',state:'open'},acl:acl()};
  publicInput.source.contentBase64=Buffer.from(JSON.stringify(publicInput.attributes)).toString('base64');
  await observe(h,publicInput);
  const publicHistory=await h.request(`/v1/objects/${hidden.entity.entityId}/observations`);
  assert.equal(publicHistory.length,1,'A public head must not expose an older restricted observation');
  assert.equal(publicHistory[0].attributes.title,publicInput.attributes.title);
  const oldPrivateRaw=await h.raw(`/v1/sources/${hidden.observation.raw.sourceRevisionId}/content`,{token});
  assert.equal(oldPrivateRaw.status,404);assert.equal(oldPrivateRaw.body.error.code,'OBJECT_NOT_VISIBLE');
});

test('S2 object writes validate declared schemas and sealed packages and reader policy changes take effect immediately',async t=>{
  const h=await setup(t);await authorize(h);
  const input=observation('typed-one');
  const same=await h.request('/v1/admin/object-types',EnterpriseTypesV1,'admin');assert.equal(same.deduplicated,true);
  await h.reject('/v1/admin/object-types',{...EnterpriseTypesV1,types:[...EnterpriseTypesV1.types,{id:'extra',attributes:{},required:[]}]},'IDEMPOTENCY_MISMATCH','admin');
  const sources=()=>h.db.query('SELECT count(*)::integer AS count FROM sources');
  const before=(await sources()).rows[0].count;
  await h.reject('/v1/admin/objects/observe',{...input,attributes:{title:4,state:'open'}},'INVALID_PAYLOAD','admin');
  await h.reject('/v1/admin/objects/observe',{...input,attributes:{state:'open'}},'INVALID_PAYLOAD','admin');
  await h.reject('/v1/admin/objects/observe',{...input,attributes:{...input.attributes,undeclared:'value'}},'INVALID_PAYLOAD','admin');
  await h.reject('/v1/admin/objects/observe',{...input,type:{...input.type,version:'99.0.0'}},'TARGET_NOT_FOUND','admin');
  await h.reject('/v1/admin/objects/observe',{...input,source:{...input.source,sha256:'0'.repeat(64)}},'SOURCE_HASH_MISMATCH','admin');
  assert.equal((await sources()).rows[0].count,before);
  await h.reject('/v1/admin/objects/observe',input,'FORBIDDEN_ACTION');
  const entity=await observe(h,input),token=await h.login();
  assert.equal((await h.raw(`/v1/objects/${entity.entity.entityId}`,{token})).status,200);
  for(const limit of ['0','101','1.5',''])assert.equal((await h.raw(`/v1/objects?limit=${limit}`,{token})).body.error.code,'INVALID_PAYLOAD');
  await h.db.query("UPDATE policies SET grants=grants-'objects.read' WHERE principal_id='prn_alice'");
  assert.equal((await h.raw('/v1/objects',{token})).body.error.code,'FORBIDDEN_ACTION');
  assert.equal((await h.raw(`/v1/objects/${entity.entity.entityId}`,{token})).body.error.code,'FORBIDDEN_ACTION');
});
