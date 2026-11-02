// Step 3 uses the real Hub and its internal transport port. HTTP/CAS are added by the subsequent approved steps.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {createTestHub} from '../../hub/server/testing-real.ts';
import {encodePersonalSyncObject} from '../../contracts/src/sync-canonical.ts';
import {SyncObjectKindSchema} from '../../contracts/generated/vocabulary.ts';
import {sha256Hex} from '../../hub/records/api.ts';
import {connect} from './support/mcp.ts';

test('two clients resume one account transport without publishing staged memory or bypassing six-tool and purge boundaries',async t=>{
 const hub=await createTestHub({repositoryPacks:false,stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false});t.after(()=>hub.close());
 const owner=await hub.createUser('合成同步作者'),other=await hub.createUser('合成同步其他成员'),api=hub.records.personalSync!;
 const client=await connect(hub,owner.token),reader=await connect(hub,other.token);t.after(()=>client.close());t.after(()=>reader.close());
 const sdk=await hub.client(owner.token);t.after(()=>sdk.close());assert.equal((await sdk.listTools()).tools.length,6);
 const saved=await client.call('upload_file',{personal_entry:{kind:'observation',statement:'合成既有个人条目',path:'/notes'}});assert.equal(saved.isError,false,saved.text);
 const original=saved.out.personal_entry!;
 const principal=await hub.records.principals.authenticate('Bearer '+owner.token);assert.ok(principal);assert.equal(principal.id,owner.user.id);
 const initial=await api.state(principal),sessions=[];
 for(let n=0;n<2;n++){const client_id=randomUUID();await api.registerClient(principal,{client_id,name:'合成同步设备'+n});sessions.push(await api.openSession(principal,{client_id,epoch:initial.epoch,known_state:initial.state_version,base_snapshot:null}));}
 const bytes=encodePersonalSyncObject({schema:'personal-sync-object@1',kind:SyncObjectKindSchema.enum.memory_revision,body:{item_id:randomUUID(),parents:[],directory_id:randomUUID(),title:'合成尚未提交的记忆',markdown:'合成仅在同步暂存的偏好',state:'enabled'}}),id=sha256Hex(bytes);
 const batch={schema:'personal-sync-upload@1',epoch:initial.epoch,operation_id:randomUUID(),objects:[{id,bytes_base64:Buffer.from(bytes).toString('base64')}]};
 const receipt=await api.upload(principal,sessions[0].session_id,batch);assert.equal(receipt.counts.accepted,1);assert.deepEqual(await api.upload(principal,sessions[0].session_id,batch),receipt);
 assert.deepEqual(await api.missing(principal,sessions[1].session_id,{epoch:initial.epoch,objects:[id]}),{missing:[]});
 assert.deepEqual((await api.download(principal,sessions[1].session_id,{epoch:initial.epoch,objects:[id]})).objects,batch.objects);
 assert.equal((await api.state(principal)).state_version,initial.state_version);assert.equal((await api.state(principal)).last_synced_at,null);
 const memories=await client.call('get_nodes',{memory:{scope:'personal'}});assert.equal(memories.isError,false,memories.text);assert.ok(!memories.text.includes('合成仅在同步暂存'));
 assert.equal((await client.call('get_nodes',{reference:'src:'+id})).isError,true);
 assert.equal((await reader.call('get_nodes',{reference:original.reference})).isError,true);
 for(const by of [other.principal,hub.admin.principal]){
  const state=await api.state(by),client_id=randomUUID();await api.registerClient(by,{client_id,name:'合成隔离设备'});const own=await api.openSession(by,{client_id,epoch:state.epoch,known_state:null,base_snapshot:null});
  assert.deepEqual(await api.download(by,own.session_id,{epoch:state.epoch,objects:[id]}),{objects:[],missing:[id]});
  await assert.rejects(api.inventory(by,sessions[0].session_id,state.epoch),{code:'SOURCE_UNAVAILABLE'});
 }
 await hub.records.personalPayloads!.purge(principal,initial.epoch);
 await assert.rejects(api.download(principal,sessions[1].session_id,{epoch:initial.epoch,objects:[id]}),{code:'SYNC_MODE_LOCAL'});
 const read=await client.call('get_nodes',{reference:original.reference});assert.equal(read.isError,true);assert.ok(!read.text.includes('合成既有个人条目'));
 assert.equal((await api.state(principal)).used_bytes,0);
});
