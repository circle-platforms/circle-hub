import {REQUIRED_FILES} from '../../contracts/src/pack.ts';
// Real Hub transport and atomic commits; HTTP is added by the next approved step.
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

test('console and MCP edits participate in sync CAS; manifest-only sync cannot install or execute a personal workflow',async t=>{
 const hub=await createTestHub({repositoryPacks:false,packs:[],stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false});t.after(()=>hub.close());const owner=await hub.createUser('合成同步编辑者'),client=await connect(hub,owner.token);t.after(()=>client.close());
 const sync=hub.hub.knowledge.personalSync!,api=sync.transport,{openConsole}=await import('./support/console.ts'),browser=await openConsole(hub,owner.token);
 const written=await client.call('upload_file',{memory:{space:'personal',expected_version:null,title:'合成初始偏好',markdown:'合成 MCP 写入',client_key:'sync-native'}});assert.equal(written.isError,false,written.text);const memory=written.out.memory_write!;
 const state=await sync.state(owner.principal),client_id=randomUUID();await api.registerClient(owner.principal,{client_id,name:'合成同步客户端'});const session=await sync.openSession(owner.principal,{client_id,epoch:state.epoch,known_state:state.state_version,base_snapshot:state.snapshot});
 const page=await browser.get('/console/knowledge?view=memory&scope=personal'),csrf=/name="csrf" value="([^"]+)"/.exec(page.body)?.[1]??'';
 const changed=await browser.post('/console/knowledge/do/memory-write',{csrf,space:'personal',document:memory.document,expected_version:memory.version,markdown:'合成控制台更新',client_key:'sync-console'});assert.equal(changed.status,303,changed.body);
 await assert.rejects(sync.commit(owner.principal,session.session_id,{schema:'personal-sync-commit@1',epoch:state.epoch,operation_id:randomUUID(),expected_state:state.state_version,base_snapshot:state.snapshot,snapshot:state.snapshot}),{code:'SYNC_VERSION_CONFLICT'});
 const fresh=await sync.state(owner.principal);assert.notEqual(fresh.state_version,state.state_version);assert.equal(fresh.last_synced_at,null);
 const object=(kind:string,body:unknown)=>({schema:'personal-sync-object@1',kind,body}),make=(value:unknown)=>{const bytes=encodePersonalSyncObject(value);return {id:sha256Hex(bytes),bytes_base64:Buffer.from(bytes).toString('base64')};};
 const snapshot=await api.object(owner.principal,fresh.epoch,fresh.snapshot!);assert.equal(snapshot?.kind,'snapshot');const items=[];
 if(snapshot?.kind==='snapshot')for(const id of snapshot.body.pages){const page=await api.object(owner.principal,fresh.epoch,id);if(page?.kind==='inventory_page')items.push(...page.body.items);}
 const manifest=object('pack_manifest',{item_id:randomUUID(),parents:[],manifest:{schema:'pack@1',id:'synthetic-manifest-only',version:'1.0.0',kind:'workflow',title:'合成仅清单',description:'合成文件元数据，不含实现',files:[...REQUIRED_FILES.workflow].sort().map(path=>({path,sha256:'1'.repeat(64),size:1}))}}),manifestId=make(manifest).id;
 items.push({kind:'pack_manifest',item_id:(manifest.body as {item_id:string}).item_id,heads:[manifestId]});items.sort((a,b)=>(a.kind+':'+a.item_id)<(b.kind+':'+b.item_id)?-1:1);
 const inventory=object('inventory_page',{items}),candidate=object('snapshot',{parents:[fresh.snapshot!],pages:[make(inventory).id]});await api.upload(owner.principal,session.session_id,{schema:'personal-sync-upload@1',epoch:fresh.epoch,operation_id:randomUUID(),objects:[manifest,inventory,candidate].map(make)});
 const result=await sync.commit(owner.principal,session.session_id,{schema:'personal-sync-commit@1',epoch:fresh.epoch,operation_id:randomUUID(),expected_state:fresh.state_version,base_snapshot:fresh.snapshot,snapshot:make(candidate).id});assert.equal(result.projections!.find(p=>p.object===manifestId)?.installed,false);
 const listed=await client.call('list_task_packs',{});assert.doesNotMatch(listed.text,/synthetic-manifest-only/);const start=await client.call('start_run',{pack:'synthetic-manifest-only',pack_space:owner.user.id,inputs:{}});assert.equal(start.isError,true);assert.equal((await hub.hub.knowledge.memory.items(owner.principal,'personal')).length,1);
});

test('rendered personal forms cannot restore purged text after resuming a new epoch',async t=>{
 const hub=await createTestHub({repositoryPacks:false,stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false});t.after(()=>hub.close());const owner=await hub.createUser('合成旧表单作者'),{openConsole}=await import('./support/console.ts'),browser=await openConsole(hub,owner.token),api=hub.records.personalSync!;
 const hidden=(body:string,name:string)=>new RegExp('name="'+name+'" value="([^"]+)"').exec(body)?.[1]??'';
 const knowledge=await browser.get('/console/knowledge/space?space='+owner.user.id+'&edit=1'),memory=await browser.get('/console/knowledge?view=memory&scope=personal&edit=1');assert.equal(knowledge.status,200,knowledge.body);assert.equal(memory.status,200,memory.body);
 const state=await api.state(owner.principal);assert.equal(hidden(knowledge.body,'personal_epoch'),state.epoch);assert.equal(hidden(memory.body,'personal_epoch'),state.epoch);
 await hub.records.personalPayloads!.purge(owner.principal,state.epoch);const local=await api.state(owner.principal);await api.resume(owner.principal,local.epoch,local.state_version);
 for(const [url,body] of [['entry',{space:owner.user.id,path:'/old',kind:'observation',statement:'合成不得恢复旧文',reason:'synthetic'}],['memory-write',{space:'personal',title:'合成不得恢复旧记忆',markdown:'合成旧文',expected_version:'',client_key:'stale'}]] as const){
  const result=await browser.post('/console/knowledge/do/'+url,{csrf:hidden(knowledge.body,'csrf'),personal_epoch:state.epoch,...body});assert.equal(result.status,400,result.body);assert.doesNotMatch(result.body,/内部错误/);
 }
 assert.equal((await hub.hub.knowledge.memory.items(owner.principal,'personal')).length,0);assert.equal((await hub.hub.knowledge.spaces!.search(owner.principal,'合成不得恢复','personal')).matches.length,0);
});

test('a personal run keeps its independently held original after purge without widening reader rights',async t=>{
 const hub=await createTestHub({repositoryPacks:false,stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false});t.after(()=>hub.close());const owner=await hub.createUser('合成运行原件作者'),other=await hub.createUser('合成无关原件成员'),client=await connect(hub,owner.token);t.after(()=>client.close());
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{writePack,workflowPack}=await import('../../hub/runs/packs/testing/builder.ts');const directory=await mkdtemp(join(tmpdir(),'synthetic-run-originals-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const pack=workflowPack({id:'synthetic-run-original',product:{catalogs:[]}});pack.files['knowledge.json']={schema:'knowledge@1',requires:[]};const written=await writePack(join(directory,'review'),pack);assert.ok((await hub.hub.registry.personal!.publish(owner.principal,written.dir)).ok);
 const bytes=Buffer.from(JSON.stringify({items:[{id:'a',fields:{title:'合成运行独立持有'}}]})),source=await hub.hub.knowledge.spaces!.importFile(owner.principal,bytes,'application/json','synthetic-run.json','/private'),initial=await hub.records.personalSync!.state(owner.principal);
 assert.equal(await hub.records.artifacts.mayDeclareUpload(owner.principal,source.digest),false);const run=await client.call('start_run',{pack:pack.id,pack_space:owner.user.id,inputs:{target:{reference:'src:'+source.body.sha256,artifact:source.digest}}});assert.equal(run.isError,false,run.text);
 const stored=(await hub.records.store.find<{sources:Array<{artifact?:string;upload_declaration?:{by:string}}>}>({kind:'run',key:'runs.id',value:run.out.run!.run,limit:1})).items[0];assert.equal(stored.body.sources.find(s=>s.artifact===source.digest)?.upload_declaration,undefined);
 await hub.records.personalPayloads!.purge(owner.principal,initial.epoch);assert.equal(await hub.hub.knowledge.spaces!.current(owner.user.id),null);const retained=await hub.records.artifacts.sourceForRun(owner.principal,source.body.sha256,run.out.run!.run,{record:source.digest});assert.deepEqual(Buffer.from(retained?.bytes??[]),bytes);assert.equal(await hub.records.artifacts.sourceForRun(hub.admin.principal,source.body.sha256,run.out.run!.run,{record:source.digest}),null);assert.equal(await hub.hub.runs.getRun(hub.admin.principal,run.out.run!.run),null);assert.equal(await hub.records.artifacts.sourceForRun(other.principal,source.body.sha256,run.out.run!.run,{record:source.digest}),null);assert.equal(await hub.records.artifacts.mayDeclareUpload(owner.principal,source.digest),false);
});

test('HTTP sync commits personal memory for six-tool readers and mode receipts survive purge and a fresh epoch',async t=>{
 const hub=await createTestHub({repositoryPacks:false,stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false});t.after(()=>hub.close());const owner=await hub.createUser('合成 HTTP 同步作者'),other=await hub.createUser('合成 HTTP 同步隔离');
 const {requestHttp}=await import('./support/console.ts');const call=async(token:string,path:string,body?:unknown)=>{const reply=await requestHttp(hub.port,'/api/sync/v1'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {...reply,json:JSON.parse(reply.body)};};
 const initial=(await call(owner.token,'/state')).json,sessions=[];
 for(let n=0;n<2;n++){const client_id=randomUUID();assert.equal((await call(owner.token,'/clients',{client_id,name:'synthetic HTTP client '+n})).status,200);const session=await call(owner.token,'/sessions',{client_id,epoch:initial.epoch,known_state:initial.state_version,base_snapshot:initial.snapshot});assert.equal(session.status,200,session.body);sessions.push(session.json);}
 const object=(kind:string,body:unknown)=>({schema:'personal-sync-object@1',kind,body}),encoded=(value:unknown)=>{const bytes=encodePersonalSyncObject(value);return {id:sha256Hex(bytes),bytes_base64:Buffer.from(bytes).toString('base64')};},directory=randomUUID(),item=randomUUID();
 const root=object('directory_revision',{item_id:directory,parents:[],parent_directory:null,name:''}),memo=object('memory_revision',{item_id:item,parents:[],directory_id:directory,title:'合成 HTTP 偏好',markdown:'synthetic HTTP preference',state:'enabled'}),rows=[{kind:'directory_revision',item_id:directory,heads:[encoded(root).id]},{kind:'memory_revision',item_id:item,heads:[encoded(memo).id]}];
 const page=object('inventory_page',{items:rows}),snapshot=object('snapshot',{parents:initial.snapshot?[initial.snapshot]:[],pages:[encoded(page).id]}),objects=[root,memo,page,snapshot].map(encoded);
 const upload=await call(owner.token,'/sessions/'+sessions[0].session_id+'/upload',{schema:'personal-sync-upload@1',epoch:initial.epoch,operation_id:randomUUID(),objects});assert.equal(upload.status,200,upload.body);
 const request={schema:'personal-sync-commit@1',epoch:initial.epoch,operation_id:randomUUID(),expected_state:initial.state_version,base_snapshot:initial.snapshot,snapshot:encoded(snapshot).id};const committed=await call(owner.token,'/sessions/'+sessions[0].session_id+'/commit',request);assert.equal(committed.status,200,committed.body);assert.ok(committed.json.state.last_synced_at);
 assert.equal((await call(owner.token,'/sessions/'+sessions[1].session_id+'/commit',{...request,operation_id:randomUUID()})).status,409);assert.deepEqual((await call(owner.token,'/operations/'+request.operation_id+'?epoch='+initial.epoch)).json,committed.json);
 const reader=await connect(hub,owner.token);t.after(()=>reader.close());const memories=await reader.call('get_nodes',{memory:{scope:'personal'}});assert.equal(memories.isError,false,memories.text);assert.match(memories.text,/合成 HTTP 偏好/);
 const foreign=await call(other.token,'/operations/'+request.operation_id+'?epoch='+initial.epoch),absent=await call(other.token,'/operations/'+randomUUID()+'?epoch='+initial.epoch);assert.equal(foreign.status,404);assert.deepEqual(foreign.json,absent.json);
 const check=(await call(owner.token,'/mode/check',{mode:'local'})).json,purge={epoch:initial.epoch,expected_state:check.expected_state,operation_id:randomUUID(),mode:'local',check:check.check,confirm_purge:true};const local=await call(owner.token,'/mode',purge);assert.equal(local.status,200,local.body);assert.equal(local.json.state.mode,'local');assert.equal(local.json.state.used_bytes,0);
 assert.equal((await call(owner.token,'/sessions/'+sessions[0].session_id+'/download',{epoch:initial.epoch,objects:[encoded(memo).id]})).status,409);
 const resumed=await call(owner.token,'/mode',{epoch:initial.epoch,expected_state:local.json.state.state_version,operation_id:randomUUID(),mode:'hub',check:null,confirm_purge:false});assert.equal(resumed.status,200,resumed.body);assert.notEqual(resumed.json.state.epoch,initial.epoch);assert.deepEqual((await call(owner.token,'/operations/'+purge.operation_id+'?epoch='+initial.epoch)).json,local.json);assert.equal((await hub.hub.knowledge.memory.items(owner.principal,'personal')).length,0);
});
