// Additive v1 capabilities over real HTTP on a temporary PostgreSQL: discovery, error detail, purge confirmation and
// recorded client provenance. Synthetic accounts and names only; no deployed Hub is touched.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createTestHub} from './testing-real.ts';
import {openConsole,requestHttp} from '../../tests/acceptance/support/console.ts';
import {KnowledgeSyncDiscovery,PersonalSyncError,PERSONAL_SYNC_HTTP_ROUTES,PERSONAL_SYNC_LIMITS,personalSyncErrorDetail} from '../../contracts/src/sync.ts';
import {SpaceEntryBody} from '../../contracts/src/spaces.ts';
import {TOOLS} from '../../contracts/src/tools.ts';
import {knowledgeSyncDiscovery,SYNC_DISCOVERY_PATH,SYNC_V1_BASE} from './sync-discovery.ts';
const options={repositoryPacks:false,stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false};
const hidden=(text:string,name:string)=>new RegExp('name="'+name+'" value="([^"]+)"').exec(text)?.[1]??'';
type Hub=Awaited<ReturnType<typeof createTestHub>>;
const http=async(hub:Hub,token:string|undefined,path:string,body?:unknown)=>{
 const reply=await requestHttp(hub.port,SYNC_V1_BASE+path,{method:body===undefined?'GET':'POST',headers:{...(token?{authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 return {...reply,json:reply.body?JSON.parse(reply.body):null};
};

test('the discovery document names the sync base, capabilities, OAuth resource, local tools and MCP tools without authentication',async t=>{
 const hub=await createTestHub(options);t.after(()=>hub.close());const issuer='http://127.0.0.1:'+hub.port;
 const reply=await requestHttp(hub.port,SYNC_DISCOVERY_PATH);assert.equal(reply.status,200,reply.body);assert.equal(reply.headers['cache-control'],'max-age=60');
 const served=KnowledgeSyncDiscovery.parse(JSON.parse(reply.body));assert.deepEqual(served,knowledgeSyncDiscovery(issuer));
 const fixture=readFileSync(new URL('../../contracts/test-fixtures/sync/v1-capabilities/discovery.json',import.meta.url),'utf8');
 assert.deepEqual(served,JSON.parse(fixture.replaceAll('https://192.0.2.10',issuer)),'only the origin differs from the shared vector');
 assert.ok(Object.values(PERSONAL_SYNC_HTTP_ROUTES).every(route=>route.path.startsWith(new URL(served.sync.versions[0].base_url).pathname+'/')));
 const metadata=JSON.parse((await requestHttp(hub.port,new URL(served.authorization.resource_metadata).pathname)).body);assert.equal(metadata.resource,served.authorization.resource);
 for(const use of Object.values(served.mcp!.capabilities)){const tool=TOOLS.find(t=>t.name===use.tool);assert.ok(tool,use.tool);assert.ok(use.argument in (tool.input as unknown as {shape:object}).shape);}
 assert.equal((await requestHttp(hub.port,SYNC_DISCOVERY_PATH,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,405);
});

test('sync errors carry the registered detail; the 401 stays a plain Bearer challenge',async t=>{
 const hub=await createTestHub(options);t.after(()=>hub.close());const owner=await hub.createUser('合成错误说明');
 const unauthenticated=await http(hub,undefined,'/state');assert.equal(unauthenticated.status,401);assert.equal(unauthenticated.headers['www-authenticate'],'Bearer');assert.deepEqual(unauthenticated.json,{code:'SOURCE_UNAVAILABLE'});
 const invalid=await http(hub,owner.token,'/clients',{client_id:'not-a-uuid',name:'合成设备'});assert.equal(invalid.status,422);
 assert.deepEqual(PersonalSyncError.parse(invalid.json),{code:'SYNC_OBJECT_INVALID',detail:personalSyncErrorDetail('SYNC_OBJECT_INVALID')});
 const other=await hub.createUser('合成错误说明他人'),foreign=await http(hub,other.token,'/operations/'+randomUUID()+'?epoch='+randomUUID());assert.equal(foreign.status,404);assert.equal(foreign.json.detail,personalSyncErrorDetail('SOURCE_UNAVAILABLE'));
});

test('a Bearer token alone never purges: the owner confirms the exact request in the console and the retry replays it',async t=>{
 let clock=Date.parse('2026-11-03T08:00:00.000Z');
 const hub=await createTestHub({...options,now:()=>new Date(clock)});t.after(()=>hub.close());const owner=await hub.createUser('合成清除确认'),other=await hub.createUser('合成清除旁人');
 const token=await hub.records.principals.issueToken(hub.admin.principal,owner.user.id,'合成管理员命名的令牌');
 const saved=await hub.hub.knowledge.spaces!.write(owner.principal,{kind:'observation',statement:'合成清除前的条目',path:'/notes'});assert.ok(saved.root);
 const state=(await http(hub,token.token,'/state')).json,check=(await http(hub,token.token,'/mode/check',{mode:'local'})).json;
 const request={epoch:state.epoch,expected_state:check.expected_state,operation_id:randomUUID(),mode:'local',check:check.check,confirm_purge:true};
 const refused=await http(hub,token.token,'/mode',request);assert.equal(refused.status,403,refused.body);
 const body=PersonalSyncError.parse(refused.json);assert.equal(body.code,'SYNC_PURGE_CONFIRMATION_REQUIRED');assert.equal(body.detail,personalSyncErrorDetail('SYNC_PURGE_CONFIRMATION_REQUIRED'));
 assert.equal(body.confirmation!.url,'http://127.0.0.1:'+hub.port+'/console/knowledge?scope=personal&sync=settings');assert.equal(Date.parse(body.confirmation!.expires_at),clock+PERSONAL_SYNC_LIMITS.purgeConfirmationSeconds*1000);
 assert.equal((await http(hub,token.token,'/state')).json.mode,'hub','nothing was purged');
 assert.equal((await http(hub,token.token,'/mode',request)).status,403);const pending=await hub.records.personalSync!.purgeRequests(owner.principal);assert.equal(pending.length,1,'a repeated request reuses its pending confirmation');
 assert.equal(pending[0].body.token,token.id);assert.deepEqual(await hub.records.personalSync!.purgeRequests(other.principal),[]);
 await assert.rejects(hub.records.personalSync!.confirmPurge(other.principal,pending[0].digest),{code:'SOURCE_UNAVAILABLE'});
 const browser=await openConsole(hub,owner.token),settings=await browser.get('/console/knowledge?scope=personal&sync=settings');assert.equal(settings.status,200);
 assert.match(settings.body,/data-sync-purge-requests/);assert.match(settings.body,/合成管理员命名的令牌 请求清除 Hub 副本/);assert.match(settings.body,/管理员命名的令牌/);
 const confirmed=await browser.post('/console/knowledge/do/sync-confirm-purge',{csrf:hidden(settings.body,'csrf'),epoch:state.epoch,record:pending[0].digest,confirm_purge:'true'});assert.equal(confirmed.status,303,confirmed.body);
 const replay=await http(hub,token.token,'/mode',request);assert.equal(replay.status,200,replay.body);assert.equal(replay.json.state.mode,'local');assert.equal(replay.json.state.used_bytes,0);
 assert.deepEqual((await http(hub,token.token,'/operations/'+request.operation_id+'?epoch='+state.epoch)).json,replay.json);
 const audits=await hub.records.store.findMany<{confirmation?:string}>({kind:'action',key:'personal.sync.mode.by',values:[owner.user.id]});assert.ok(audits.some(row=>row.body.confirmation===pending[0].digest));
 // A fresh epoch: a confirmation expires after its window and a stale request is refused, not performed.
 const local=(await http(hub,token.token,'/state')).json,resumed=await http(hub,token.token,'/mode',{epoch:local.epoch,expected_state:local.state_version,operation_id:randomUUID(),mode:'hub',check:null,confirm_purge:false});assert.equal(resumed.status,200,resumed.body);
 const next=(await http(hub,token.token,'/state')).json,nextCheck=(await http(hub,token.token,'/mode/check',{mode:'local'})).json;
 assert.equal((await http(hub,token.token,'/mode',{epoch:next.epoch,expected_state:nextCheck.expected_state,operation_id:randomUUID(),mode:'local',check:nextCheck.check,confirm_purge:true})).status,403);
 const waiting=await hub.records.personalSync!.purgeRequests(owner.principal);assert.equal(waiting.length,1);
 clock+=PERSONAL_SYNC_LIMITS.purgeConfirmationSeconds*1000+1;assert.deepEqual(await hub.records.personalSync!.purgeRequests(owner.principal),[]);
 await assert.rejects(hub.records.personalSync!.confirmPurge(owner.principal,waiting[0].digest),{code:'SOURCE_UNAVAILABLE'});assert.equal((await http(hub,token.token,'/state')).json.mode,'hub');
});

test('entry versions keep the clientInfo declared in their own Mcp-Session-Id; anything unbound shows 客户端',async t=>{
 const hub=await createTestHub(options);t.after(()=>hub.close());const owner=await hub.createUser('合成客户端声明');
 const session=await hub.client(owner.token,{sessionId:'synthetic-circle-session'});t.after(()=>session.close());
 const issued=(session.client.transport as unknown as {sessionId?:string}).sessionId;assert.match(issued??'',/^[0-9a-f-]{36}$/,'the Hub issues an Mcp-Session-Id at initialize');
 const written=await session.call('upload_file',{personal_entry:{kind:'observation',statement:'合成带客户端声明的条目',path:'/notes'}});assert.equal(written.isError,false,JSON.stringify(written));
 // The same token in another client: its own initialize, its own session, its own name.
 const rpc=async(body:unknown,headers:Record<string,string>={})=>requestHttp(hub.port,'/mcp',{method:'POST',headers:{authorization:'Bearer '+owner.token,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18',...headers},body:JSON.stringify(body)});
 const init=await rpc({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'synthetic-second-client',version:'9.9'}}});assert.equal(init.status,200,init.body);
 const second=String(init.headers['mcp-session-id']);assert.match(second,/^[0-9a-f-]{36}$/);assert.notEqual(second,issued);
 const call=(path:string,statement:string,headers:Record<string,string>={})=>rpc({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'upload_file',arguments:{personal_entry:{kind:'observation',statement,path}}}},headers);
 assert.equal((await call('/second','合成第二个客户端的条目',{'mcp-session-id':second})).status,200);
 assert.equal((await call('/unbound','合成未带会话的条目')).status,200);
 assert.equal((await call('/forged','合成伪造会话的条目',{'mcp-session-id':randomUUID()})).status,200);
 const view=await hub.hub.knowledge.spaces!.current(owner.user.id);assert.ok(view);
 const body=async(path:string)=>SpaceEntryBody.parse((await hub.records.store.get(view.body.entries.find(e=>e.path===path)!.record))!.body);
 assert.deepEqual((await body('/notes')).client,{name:'hub-test-real',version:'0.0.0'});assert.equal((await body('/notes')).session,'synthetic-circle-session');
 assert.deepEqual((await body('/second')).client,{name:'synthetic-second-client',version:'9.9'},'one token, two clients: no mislabel');
 assert.equal((await body('/unbound')).client,undefined);assert.equal((await body('/forged')).client,undefined);
 const line=(await hub.records.callLog.query(owner.principal,{tool:'initialize'})).items.find(l=>l.session==='synthetic-circle-session');assert.ok(line);
 const token=(await hub.records.principals.identify!('Bearer '+owner.token))!.token_id;
 const declaration=(await hub.records.store.find<{call:string;client:unknown;mcp_session:string;session:string}>({kind:'action',key:'mcp.client.session',value:owner.user.id+'/'+token+'/'+issued,limit:5})).items.find(r=>r.schema==='mcp-client-declaration@1');
 assert.equal(declaration?.body.call,line.digest);assert.equal(declaration?.body.session,'synthetic-circle-session');assert.deepEqual(declaration?.body.client,{name:'hub-test-real',version:'0.0.0'});assert.equal(declaration?.provenance,'declared');
 const browser=await openConsole(hub,owner.token),page=(path:string)=>browser.get('/console/knowledge/space?'+new URLSearchParams({space:owner.user.id,root:view.root,path,entry:view.body.entries.find(e=>e.path===path)!.entry}));
 const shown=await page('/notes');assert.equal(shown.status,200);assert.match(shown.body,/写入来源/);assert.match(shown.body,/hub-test-real 0\.0\.0/);assert.match(shown.body,/MCP initialize clientInfo/);assert.doesNotMatch(shown.body,/自报|Circle 客户端/);
 for(const path of ['/unbound','/forged']){const plain=await page(path);assert.equal(plain.status,200);assert.match(plain.body,/>客户端</);assert.doesNotMatch(plain.body,/hub-test-real|synthetic-second-client/);}
});
