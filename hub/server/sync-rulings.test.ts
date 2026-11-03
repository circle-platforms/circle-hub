// Owner rulings 1 and 2 on issue 141 over real HTTP on a temporary PostgreSQL: single-item sharing from 仅保存在本机
// and the never_synced fact a client needs for its first-connection notice. Synthetic accounts and texts only.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createTestHub} from './testing-real.ts';
import {requestHttp} from '../../tests/acceptance/support/console.ts';
import {KnowledgeSyncDiscovery,PersonalSyncShareResult,PersonalSyncState,PERSONAL_SYNC_CAPABILITIES} from '../../contracts/src/sync.ts';
import {encodePersonalSyncObject,personalSyncObjectId} from '../../contracts/src/sync-canonical.ts';
import {KnowledgeShareBody} from '../../contracts/src/sharing.ts';
import {sha256Hex} from '../records/api.ts';
import {SYNC_DISCOVERY_PATH,SYNC_V1_BASE} from './sync-discovery.ts';
const options={repositoryPacks:false,stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false};
type Hub=Awaited<ReturnType<typeof createTestHub>>;
const http=async(hub:Hub,token:string,path:string,body?:unknown)=>{
 const reply=await requestHttp(hub.port,SYNC_V1_BASE+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 return {...reply,json:reply.body?JSON.parse(reply.body):null};
};
const object=(kind:string,body:unknown)=>({schema:'personal-sync-object@1',kind,body});
const wire=(value:unknown)=>({id:personalSyncObjectId(value),bytes_base64:Buffer.from(encodePersonalSyncObject(value)).toString('base64')});
/** One local entry grounded on one local original: the entry, its quotation and the source with its chunk. */
function localItem(text:string,quote:string,statement:string,item=randomUUID()){
 const raw=Buffer.from(text),chunk=object('bytes',{bytes_base64:raw.toString('base64')}),quotation=object('bytes',{bytes_base64:Buffer.from(quote).toString('base64')}),directory=randomUUID();
 const source=object('source_revision',{item_id:randomUUID(),parents:[],directory_id:directory,name:'synthetic-local.txt',media_type:'text/plain',raw_sha256:sha256Hex(raw),size:raw.length,chunks:[personalSyncObjectId(chunk)]});
 const entry=object('entry_revision',{item_id:item,parents:[],directory_id:directory,content:{kind:'observation',statement,data:{},applicability:null},grounds:[{source:personalSyncObjectId(source),parser:'text@1',selector:'l/2',quotation:personalSyncObjectId(quotation)}]});
 return {item,raw,entry,objects:[entry,quotation,source,chunk].map(wire)};
}
async function goLocal(hub:Hub,principal:Parameters<NonNullable<Hub['records']['personalSync']>['state']>[0]){
 const sync=hub.records.personalSync!,state=await sync.state(principal),check=await sync.modeCheck(principal,{mode:'local'});
 await sync.changeMode(principal,{epoch:state.epoch,operation_id:randomUUID(),mode:'local',expected_state:check.expected_state,check:check.check,confirm_purge:true});
 return sync.state(principal);
}

test('discovery advertises share-single-item and first-sync-notice beside the earlier capabilities',async t=>{
 const hub=await createTestHub(options);t.after(()=>hub.close());
 const served=KnowledgeSyncDiscovery.parse(JSON.parse((await requestHttp(hub.port,SYNC_DISCOVERY_PATH)).body));
 assert.deepEqual(served.sync.versions[0].capabilities,['error-detail','first-sync-notice','purge-confirmation','share-single-item']);
 assert.deepEqual(Object.values(PERSONAL_SYNC_CAPABILITIES).sort(),served.sync.versions[0].capabilities);
});

test('never_synced stays true until a client of the account first writes through the sync API, in any epoch',async t=>{
 const hub=await createTestHub(options);t.after(()=>hub.close());const owner=await hub.createUser('合成首次连接');
 const first=PersonalSyncState.parse((await http(hub,owner.token,'/state')).json);assert.equal(first.mode,'hub','the default stays 同步到服务器');assert.equal(first.never_synced,true);
 // A native console edit is not a client sync: the notice is still due.
 await hub.hub.knowledge.spaces!.write(owner.principal,{kind:'observation',statement:'合成控制台条目',path:'/notes'});
 assert.equal((await http(hub,owner.token,'/state')).json.never_synced,true);
 const client_id=randomUUID();assert.equal((await http(hub,owner.token,'/clients',{client_id,name:'合成设备'})).status,200);
 const state=(await http(hub,owner.token,'/state')).json,session=(await http(hub,owner.token,'/sessions',{client_id,epoch:state.epoch,known_state:state.state_version,base_snapshot:state.snapshot})).json;
 assert.equal((await http(hub,owner.token,'/sessions/'+session.session_id+'/abort',{epoch:state.epoch,operation_id:randomUUID()})).status,200);
 assert.equal((await http(hub,owner.token,'/state')).json.never_synced,false);
 const local=await goLocal(hub,owner.principal);assert.equal(local.never_synced,false,'a later epoch keeps the history');
 const other=await hub.createUser('合成首次连接他人');assert.equal((await http(hub,other.token,'/state')).json.never_synced,true,'per account');
});

test('a team-marked entry is shared alone from 仅保存在本机: verified like normal sharing, recorded, nothing personal kept',async t=>{
 const hub=await createTestHub(options);t.after(()=>hub.close());const owner=await hub.createUser('合成单条分享'),reader=await hub.createUser('合成单条读者');
 const local=await goLocal(hub,owner.principal);assert.equal(local.mode,'local');
 const item=localItem('合成原文第一行\n合成每次保留两份\n','每次保留两份','合成规则：每次保留两份');
 const request={schema:'personal-sync-share@1',epoch:local.epoch,operation_id:randomUUID(),team_mark:true,item:item.objects[0].id,path:'/本机/规则',team_path:'/团队规则',objects:item.objects};
 const reply=await http(hub,owner.token,'/share',request);assert.equal(reply.status,200,reply.body);
 const result=PersonalSyncShareResult.parse(reply.json);assert.equal(result.status,'merged');assert.equal(result.item_id,item.item);assert.match(result.reference!,/^tree:[0-9a-f]{64}\/团队规则@[0-9a-f]{64}$/);
 const team=await hub.hub.knowledge.spaces!.current('team'),row=team!.body.entries.find(row=>row.path==='/团队规则')!;
 const view=await hub.hub.knowledge.spaces!.entry(reader.principal,team!.root,row.path,row.entry);assert.equal(view?.body.by,owner.user.id);assert.equal(view?.body.content.statement,'合成规则：每次保留两份');
 const source=await hub.hub.knowledge.spaces!.source(reader.principal,sha256Hex(item.raw));assert.deepEqual(Buffer.from(source!.bytes!),item.raw,'the team copy of the original is readable by another member');
 const receipt=KnowledgeShareBody.parse((await hub.records.store.get(result.record))!.body);
 assert.equal(receipt.single_item?.team_mark,true);assert.equal(receipt.single_item?.item_id,item.item);assert.deepEqual(receipt.single_item?.sources,[sha256Hex(item.raw)]);assert.equal(receipt.source,undefined);
 assert.equal(await hub.hub.knowledge.spaces!.current(owner.user.id),null,'no personal copy appears on the Hub');
 const after=PersonalSyncState.parse((await http(hub,owner.token,'/state')).json);assert.equal(after.mode,'local');assert.equal(after.used_bytes,0);
 // The identical request replays the receipt; the same key with other content is refused.
 assert.deepEqual((await http(hub,owner.token,'/share',request)).json,reply.json);
 assert.equal((await http(hub,owner.token,'/share',{...request,team_path:'/别处'})).json.code,'IDEMPOTENCY_MISMATCH');
 // A newer revision of the same item replaces only the account's own earlier team entry.
 const revised=localItem('合成原文第一行\n合成每次保留三份\n','每次保留三份','合成规则：每次保留三份',item.item);
 const next=PersonalSyncShareResult.parse((await http(hub,owner.token,'/share',{...request,operation_id:randomUUID(),item:revised.objects[0].id,objects:revised.objects})).json);assert.equal(next.status,'merged');
 const rows=(await hub.hub.knowledge.spaces!.current('team'))!.body.entries.filter(row=>row.path==='/团队规则');assert.deepEqual(rows.map(row=>row.status).sort(),['superseded','verified']);
});

test('single-item sharing refuses what normal sharing refuses and anything beyond the item and its sources',async t=>{
 const hub=await createTestHub(options);t.after(()=>hub.close());const owner=await hub.createUser('合成单条拒收');const local=await goLocal(hub,owner.principal);
 const send=(item:ReturnType<typeof localItem>,extra:Record<string,unknown>={})=>http(hub,owner.token,'/share',{schema:'personal-sync-share@1',epoch:local.epoch,operation_id:randomUUID(),team_mark:true,item:item.objects[0].id,path:'/本机',objects:item.objects,...extra});
 const wrong=await send(localItem('合成第一行\n合成第二行\n','不在原文里的话','合成错误引文'));assert.equal(wrong.status,200);assert.equal(wrong.json.status,'rejected');assert.equal(wrong.json.code,'SHARE_QUOTE_MISMATCH');
 const secret=await send(localItem('合成第一行\npassword=Synthetic-Secret-123456\n','password=Synthetic-Secret-123456','合成带凭据的规则'));assert.equal(secret.json.code,'SHARE_CREDENTIALS');
 const ok=localItem('合成第一行\n合成独立一条\n','合成独立一条','合成独立规则');
 assert.equal((await send(ok,{team_mark:false})).json.code,'SYNC_OBJECT_INVALID','the team mark is required');
 const stray=wire(object('bytes',{bytes_base64:Buffer.from('合成多余对象').toString('base64')}));
 assert.equal((await send({...ok,objects:[...ok.objects,stray]})).json.code,'SYNC_OBJECT_INVALID','only the item and its own sources');
 assert.equal((await send({...ok,objects:ok.objects.slice(0,3)})).json.code,'SYNC_OBJECT_MISSING');
 assert.equal((await send(ok,{epoch:randomUUID()})).json.code,'SYNC_EPOCH_CHANGED');
 assert.equal((await hub.hub.knowledge.spaces!.current('team'))?.body.entries.length??0,0,'nothing reached the team');
 const recorded=await hub.records.store.findMany({kind:'knowledge_share',key:'knowledge.share.by',values:[owner.user.id]});assert.equal(recorded.length,2,'each checked refusal is recorded');
});
