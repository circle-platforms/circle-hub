// Real HTTP, password sessions, OAuth-bound tokens and scoped synthetic data; no deployed Hub is touched.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createTestHub} from './testing-real.ts';
import {openConsole,requestHttp} from '../../tests/acceptance/support/console.ts';
import {encodePersonalSyncObject} from '../../contracts/src/sync-canonical.ts';
import {sha256Hex} from '../records/api.ts';
const options={repositoryPacks:false,stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false};
const hidden=(text:string,name:string)=>new RegExp('name="'+name+'" value="([^"]+)"').exec(text)?.[1]??'';
const http=async(hub:Awaited<ReturnType<typeof createTestHub>>,token:string|undefined,path:string,body?:unknown,headers:Record<string,string>={})=>{
 const reply=await requestHttp(hub.port,'/api/sync/v1'+path,{method:body===undefined?'GET':'POST',headers:{...(token?{authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'content-type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {...reply,json:JSON.parse(reply.body)};
};

test('sync accepts only live access Bearers, including OAuth, and rejects cookies and console credentials before JSON',async t=>{
 const hub=await createTestHub(options);t.after(()=>hub.close());const owner=await hub.createUser('合成同步认证'),api=hub.records.principals,browser=await openConsole(hub,owner.token);
 const page=await browser.get('/api/sync/v1/state');assert.equal(page.status,401);assert.equal(page.headers.location,undefined);
 const password=await api.verifyPassword(owner.user.name,(await import('./testing.ts')).testConsoleCredentials(owner.token).password);assert.ok(password);const session=await api.openConsoleSession(owner.user.id,password.revision);assert.ok(session);
 for(const token of [undefined,'synthetic-invalid',session.token])assert.equal((await http(hub,token,'/state')).status,401);
 const malformed=await requestHttp(hub.port,'/api/sync/v1/clients',{method:'POST',headers:{'content-type':'application/json'},body:'{private malformed synthetic'});assert.equal(malformed.status,401);assert.doesNotMatch(malformed.body,/private malformed/);
 const client=await api.registerClient('synthetic-oauth',['http://127.0.0.1/callback']),oauth=await api.issueToken(owner.principal,owner.user.id,'synthetic-oauth',client.id);
 assert.equal((await http(hub,oauth.token,'/state')).status,200);const oauthAudits=await hub.records.store.findMany<{token:string;authenticated_client:string}>({kind:'action',key:'personal.sync.http.by',values:[owner.user.id]});assert.ok(oauthAudits.some(row=>row.body.token===oauth.id&&row.body.authenticated_client===client.id));await api.revokeToken(owner.principal,oauth.id);assert.equal((await http(hub,oauth.token,'/state')).status,401);
 assert.equal((await http(hub,owner.token,'/state',undefined,{origin:'https://example.invalid'})).status,403);assert.equal((await http(hub,owner.token,'/state',undefined,{host:'192.0.2.1'})).status,403);
 const success=await http(hub,owner.token,'/state');assert.equal(success.headers['cache-control'],'no-store');assert.equal(success.headers['access-control-allow-origin'],undefined);
 await api.setDisabled(hub.admin.principal,owner.user.id,true);assert.equal((await http(hub,owner.token,'/state')).status,401);
});

test('real HTTP batches, frozen inventories, CAS and operations stay scoped and audit no content',async t=>{
 const hub=await createTestHub(options);t.after(()=>hub.close());const owner=await hub.createUser('合成同步传输'),other=await hub.createUser('合成隔离成员'),client_id=randomUUID();
 const state=(await http(hub,owner.token,'/state')).json;assert.equal((await http(hub,owner.token,'/clients',{client_id,name:'合成不可进入审计的设备名称'})).status,200);
 const session=(await http(hub,owner.token,'/sessions',{client_id,epoch:state.epoch,known_state:state.state_version,base_snapshot:state.snapshot})).json;
 const bytes=encodePersonalSyncObject({schema:'personal-sync-object@1',kind:'bytes',body:{bytes_base64:Buffer.from('synthetic private transport body').toString('base64')}}),object={id:sha256Hex(bytes),bytes_base64:Buffer.from(bytes).toString('base64')},operation_id=randomUUID(),upload={schema:'personal-sync-upload@1',epoch:state.epoch,operation_id,objects:[object]};
 const received=await http(hub,owner.token,'/sessions/'+session.session_id+'/upload',upload);assert.equal(received.status,200,received.body);assert.equal(received.json.counts.accepted,1);assert.deepEqual((await http(hub,owner.token,'/sessions/'+session.session_id+'/upload',upload)).json,received.json);
 assert.deepEqual((await http(hub,owner.token,'/operations/'+operation_id+'?epoch='+state.epoch)).json,received.json);
 assert.deepEqual((await http(hub,owner.token,'/sessions/'+session.session_id+'/download',{epoch:state.epoch,objects:[object.id]})).json.objects,[object]);
 const inventory=await http(hub,owner.token,'/sessions/'+session.session_id+'/inventory?epoch='+state.epoch);assert.equal(inventory.status,200);assert.ok(!inventory.json.objects.some((o:{id:string})=>o.id===object.id));
 const foreign=await http(hub,other.token,'/sessions/'+session.session_id+'/upload',upload),absent=await http(hub,other.token,'/sessions/'+randomUUID()+'/upload',upload);assert.equal(foreign.status,404);assert.deepEqual(foreign.json,absent.json);
 const native=await hub.hub.knowledge.spaces!.write(owner.principal,{kind:'observation',statement:'合成必须保密的知识标题',path:'/private'});assert.ok(native.root);
 const commit=await http(hub,owner.token,'/sessions/'+session.session_id+'/commit',{schema:'personal-sync-commit@1',epoch:state.epoch,operation_id:randomUUID(),expected_state:state.state_version,base_snapshot:state.snapshot,snapshot:session.state.snapshot??inventory.json.snapshot});assert.equal(commit.status,409,commit.body);assert.ok(commit.json.state?.snapshot);
 const audits=(await hub.records.store.findMany({kind:'action',key:'personal.sync.http.by',values:[owner.user.id]})).map(r=>r.body),text=JSON.stringify(audits);assert.ok(audits.length>=16);assert.doesNotMatch(text,/不可进入审计|synthetic private transport body|合成必须保密|private\//);assert.ok(!text.includes(owner.token));assert.match(text,/authenticated_client/);
 const malformed=await requestHttp(hub.port,'/api/sync/v1/clients',{method:'POST',headers:{authorization:'Bearer '+owner.token,'content-type':'application/json'},body:'{"client_id":"'+randomUUID()+'","name":"x","name":"y"}'});assert.equal(malformed.status,422);
});

test('console mode checks require CSRF, bind staged changes, preserve team copies and receipts never purge a new epoch',async t=>{
 const hub=await createTestHub(options);t.after(()=>hub.close());const owner=await hub.createUser('合成同步切换'),browser=await openConsole(hub,owner.token),memory=hub.hub.knowledge.memory;
 const saved=await memory.write(owner.principal,{space:'personal',title:'合成清除标题',markdown:'synthetic private preference',expected_version:null,client_key:'mode-note'});
 await memory.write(hub.admin.principal,{space:'team',title:'合成团队保留',markdown:'synthetic team preference',expected_version:null,client_key:'team-note'});
 const api=hub.records.personalSync!,initial=await api.state(owner.principal),page=await browser.get('/console/knowledge?scope=personal&sync=local');assert.equal(page.status,200,page.body);assert.match(page.body,/本机副本不受影响/);assert.match(page.body,/恢复清除前的备份/);
 const fields={csrf:hidden(page.body,'csrf'),epoch:hidden(page.body,'epoch'),expected_state:hidden(page.body,'expected_state'),operation_id:hidden(page.body,'operation_id'),check:hidden(page.body,'check'),mode:'local',confirm_purge:'true'};
 const denied=await browser.post('/console/knowledge/do/sync-mode',{...fields,csrf:'synthetic-invalid'});assert.equal(denied.status,403);assert.equal((await api.state(owner.principal)).mode,'hub');
 const changed=await browser.post('/console/knowledge/do/sync-mode',fields);assert.equal(changed.status,303,changed.body);assert.equal((await api.state(owner.principal)).mode,'local');await assert.rejects(memory.read(owner.principal,saved.document));assert.equal((await memory.items(owner.principal,'team')).length,1);
 assert.equal((await http(hub,owner.token,'/operations/'+fields.operation_id+'?epoch='+initial.epoch)).status,200);
 const local=await browser.get('/console/knowledge?scope=personal');assert.match(local.body,/仅保存在本机/);assert.match(local.body,/sync-resume/);
 const resume={csrf:hidden(local.body,'csrf'),epoch:hidden(local.body,'epoch'),expected_state:hidden(local.body,'expected_state'),operation_id:hidden(local.body,'operation_id')};assert.equal((await browser.post('/console/knowledge/do/sync-resume',resume)).status,303);
 const fresh=await api.state(owner.principal);assert.notEqual(fresh.epoch,initial.epoch);assert.equal(fresh.mode,'hub');await memory.write(owner.principal,{space:'personal',title:'合成新代次',markdown:'synthetic fresh note',expected_version:null,client_key:'fresh'});
 assert.equal((await browser.post('/console/knowledge/do/sync-mode',fields)).status,303);assert.equal((await memory.items(owner.principal,'personal')).length,1,'a replay returns its old receipt without purging current data');
 const admin=await openConsole(hub,hub.admin.token),detail=await admin.get('/console/team/'+owner.user.id);assert.match(detail.body,/同步方式/);assert.match(detail.body,/上次同步/);assert.doesNotMatch(detail.body,/合成新代次|synthetic fresh note/);
});

test('rate limits bind the account across tokens and device IDs and reset after a minute',async t=>{
 let now=new Date('2026-11-03T00:00:00Z');const hub=await createTestHub({...options,now:()=>now,limits:{syncRequestsPerMinute:2}});t.after(()=>hub.close());
 const owner=await hub.createUser('合成限流成员'),token=await hub.issueToken(owner.principal),other=await hub.createUser('合成独立限流');
 assert.equal((await http(hub,owner.token,'/clients',{client_id:randomUUID(),name:'synthetic one'})).status,200);
 assert.equal((await http(hub,token,'/clients',{client_id:randomUUID(),name:'synthetic two'})).status,200);
 const blocked=await http(hub,token,'/clients',{client_id:randomUUID(),name:'synthetic three'});assert.equal(blocked.status,429);assert.equal(blocked.json.code,'SYNC_RATE_LIMITED');assert.equal(blocked.headers['retry-after'],'60');
 assert.equal((await http(hub,other.token,'/state')).status,200);
 now=new Date(now.getTime()+60_001);assert.equal((await http(hub,token,'/state')).status,200);
});

test('two in-flight writes cap each account before reading bodies and release admission on disconnect',async t=>{
 const {request}=await import('node:http');const opened:import('node:http').ClientRequest[]=[];const hub=await createTestHub(options);t.after(async()=>{for(const req of opened)req.destroy();await hub.close();});const owner=await hub.createUser('合成并发写入');
 const waiting=()=>new Promise<void>((resolve,reject)=>{
  const req=request({host:'127.0.0.1',port:hub.port,path:'/api/sync/v1/clients',method:'POST',headers:{authorization:'Bearer '+owner.token,'content-type':'application/json','content-length':'1000'}},res=>{res.resume();reject(new Error('unfinished request returned '+res.statusCode));});
  opened.push(req);req.on('error',()=>{});req.flushHeaders();req.write('{');
  // Wait for the audit and admission to reach the body's data listener, without guessing a fixed delay.
  const check=async()=>{const audits=await hub.records.store.findMany<{phase:string}>({kind:'action',key:'personal.sync.http.by',values:[owner.user.id]});if(audits.filter(r=>r.body.phase==='started').length>=opened.length)resolve();else setTimeout(()=>{void check().catch(reject);},5);};void check().catch(reject);
 });
 await waiting();await waiting();
 const blocked=await http(hub,owner.token,'/clients',{client_id:randomUUID(),name:'synthetic blocked'});assert.equal(blocked.status,429,blocked.body);
 for(const req of opened)req.destroy();
 // Waiting for both aborted audits proves release rather than merely waiting for the rate window.
 for(let n=0;n<200;n++){const rows=await hub.records.store.findMany<{status:number}>({kind:'action',key:'personal.sync.http.by',values:[owner.user.id]});if(rows.filter(r=>r.body.status===499).length===2)break;await new Promise(r=>setTimeout(r,5));}
 assert.equal((await http(hub,owner.token,'/clients',{client_id:randomUUID(),name:'synthetic released'})).status,200);
});

test('disconnects during the pre-body state read release both write slots', {timeout:10000}, async t=>{
 const {createServer,request}=await import('node:http'),{handlePersonalSync,SyncAdmission}=await import('./personal-sync.ts'),{BodyBudget}=await import('./http.ts');
 const hub=await createTestHub(options);t.after(()=>hub.close());const owner=await hub.createUser('合成读取前断连');
 const ready=Promise.withResolvers<void>(),resume=Promise.withResolvers<void>(),finished=Promise.withResolvers<void>(),aborted=Promise.withResolvers<void>();
 let entered=0,completed=0,disconnected=0;
 const original=hub.records.personalSync!.state.bind(hub.records.personalSync);
 t.mock.method(hub.records.personalSync!,'state',async(...args:Parameters<typeof original>)=>{if(++entered<=2){if(entered===2)ready.resolve();await resume.promise;}return original(...args);});
 const admission=new SyncAdmission(),budget=new BodyBudget(1024*1024);
 const server=createServer((req,res)=>{
  req.once('aborted',()=>{if(++disconnected===2)aborted.resolve();});
  void handlePersonalSync(req,res,new URL(req.url!,'http://127.0.0.1'),{deps:hub.deps,admission,budget,origins:new Set(),log:()=>{},issuer:()=>'http://127.0.0.1'}).then(()=>{if(++completed===3)finished.resolve();},finished.reject);
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as import('node:net').AddressInfo).port;
 const pending:import('node:http').ClientRequest[]=[];
 t.after(async()=>{resume.resolve();for(const req of pending)req.destroy();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 for(let n=0;n<2;n++){
  const req=request({host:'127.0.0.1',port,path:'/api/sync/v1/clients',method:'POST',headers:{authorization:'Bearer '+owner.token,'content-type':'application/json','content-length':'1000'}},res=>res.resume());
  req.on('error',()=>{});req.flushHeaders();req.write('{');pending.push(req);
 }
 await ready.promise;
 const send=()=>requestHttp(port,'/api/sync/v1/clients',{method:'POST',headers:{authorization:'Bearer '+owner.token,'content-type':'application/json'},body:JSON.stringify({client_id:randomUUID(),name:'synthetic released slot'})});
 assert.equal((await send()).status,429);
 for(const req of pending)req.destroy();await aborted.promise;resume.resolve();await finished.promise;
 const audits=await hub.records.store.findMany<{status:number}>({kind:'action',key:'personal.sync.http.by',values:[owner.user.id]});
 assert.equal(audits.filter(row=>row.body.status===499).length,2);
 assert.equal((await send()).status,200,'already-aborted requests must not retain either admitted slot');
});

test('strict wire limits, query validation and refusal audits expose no request text',async t=>{
 const hub=await createTestHub({...options,limits:{maxRequestBytes:2048}});t.after(()=>hub.close());const owner=await hub.createUser('合成请求上限');
 const large=await http(hub,owner.token,'/clients',{client_id:randomUUID(),name:'synthetic-private-'+ 'z'.repeat(3000)});assert.equal(large.status,413,large.body);assert.equal(large.json.code,'SYNC_BATCH_LIMIT');
 for(const path of ['/state?owner='+owner.user.id,'/state?x=1&x=2','/operations/synthetic?epoch=bad'])assert.equal((await http(hub,owner.token,path)).status,422);
 const encoding=await http(hub,owner.token,'/clients',{}, {'content-encoding':'gzip'});assert.equal(encoding.status,415);
 const state=await requestHttp(hub.port,'/api/sync/v1/state',{method:'POST',headers:{authorization:'Bearer '+owner.token}});assert.equal(state.status,405);
 const rows=await hub.records.store.findMany<{status:number;phase:string}>({kind:'action',key:'personal.sync.http.by',values:[owner.user.id]});assert.ok(rows.some(r=>r.body.phase==='finished'&&r.body.status===413));assert.doesNotMatch(JSON.stringify(rows.map(r=>r.body)),/synthetic-private-/);assert.equal((await http(hub,owner.token,'/state')).status,200);
});

test('audit start failures prevent writes and finish failures leave recoverable operation receipts',async t=>{
 const hub=await createTestHub(options);t.after(()=>hub.close());const owner=await hub.createUser('合成审计故障'),api=hub.records.personalSync!,client_id=randomUUID();
 const {Database,createPool}=await import('../records/db.ts'),db=new Database(createPool(hub.records.database));t.after(()=>db.end());
 await db.query("CREATE FUNCTION synthetic_sync_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.schema='personal-sync-http-audit@1' AND NEW.body::jsonb->>'phase'='started' THEN RAISE EXCEPTION 'synthetic secret detail';END IF;RETURN NEW;END$$");await db.query('CREATE TRIGGER synthetic_sync_audit_failure BEFORE INSERT ON records FOR EACH ROW EXECUTE FUNCTION synthetic_sync_audit_failure()');
 const refused=await http(hub,owner.token,'/clients',{client_id,name:'synthetic audit device'});assert.equal(refused.status,503);assert.doesNotMatch(refused.body,/synthetic secret detail/);
 await db.query('DROP TRIGGER synthetic_sync_audit_failure ON records');const state=await api.state(owner.principal);await assert.rejects(api.openSession(owner.principal,{client_id,epoch:state.epoch,known_state:null,base_snapshot:null}),{code:'SOURCE_UNAVAILABLE'});
 await http(hub,owner.token,'/clients',{client_id,name:'synthetic audit device'});const session=(await http(hub,owner.token,'/sessions',{client_id,epoch:state.epoch,known_state:null,base_snapshot:null})).json;
 await db.query("CREATE OR REPLACE FUNCTION synthetic_sync_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.schema='personal-sync-http-audit@1' AND NEW.body::jsonb->>'phase'='finished' THEN RAISE EXCEPTION 'synthetic secret detail';END IF;RETURN NEW;END$$");await db.query('CREATE TRIGGER synthetic_sync_audit_failure BEFORE INSERT ON records FOR EACH ROW EXECUTE FUNCTION synthetic_sync_audit_failure()');
 const bytes=encodePersonalSyncObject({schema:'personal-sync-object@1',kind:'bytes',body:{bytes_base64:Buffer.from('synthetic recoverable audit batch').toString('base64')}}),operation_id=randomUUID(),request={schema:'personal-sync-upload@1',epoch:state.epoch,operation_id,objects:[{id:sha256Hex(bytes),bytes_base64:Buffer.from(bytes).toString('base64')}]};
 assert.equal((await http(hub,owner.token,'/sessions/'+session.session_id+'/upload',request)).status,503);
 await db.query('DROP TRIGGER synthetic_sync_audit_failure ON records');const replay=await http(hub,owner.token,'/operations/'+operation_id+'?epoch='+state.epoch);assert.equal(replay.status,200,replay.body);assert.equal(replay.json.counts.accepted,1);
 assert.deepEqual((await http(hub,owner.token,'/sessions/'+session.session_id+'/upload',request)).json,replay.json);assert.doesNotMatch(JSON.stringify(hub.logs),/synthetic secret detail/);
});

test('the shared HTTP body budget bounds sync responses and records the actual refusal',async t=>{
 const hub=await createTestHub(options);t.after(()=>hub.close());const owner=await hub.createUser('合成全局预算');
 const {createApp}=await import('./app.ts'),app=createApp(hub.deps,{maxInflightBodyBytes:1});t.after(()=>app.close());const listener=await app.listen(),port=Number(new URL(listener.url).port);
 const response=await requestHttp(port,'/api/sync/v1/state',{headers:{authorization:'Bearer '+owner.token}});assert.equal(response.status,503,response.body);assert.equal(response.headers['retry-after'],'1');
 const rows=await hub.records.store.findMany<{phase:string;status:number;code:string}>({kind:'action',key:'personal.sync.http.by',values:[owner.user.id]});assert.ok(rows.some(row=>row.body.phase==='finished'&&row.body.status===503&&row.body.code==='SOURCE_RETRYABLE'));assert.ok(!rows.some(row=>row.body.status===200));
});

test('knowledge service refusals preserve the registered code without exposing its private detail',async t=>{
 const hub=await createTestHub(options);t.after(()=>hub.close());const owner=await hub.createUser('合成知识拒收'),{KnowledgeError}=await import('../knowledge/api.ts');
 t.mock.method(hub.deps.knowledge.personalSync!,'state',async()=>{throw new KnowledgeError('synthetic private failure text',{code:'MEMORY_DOCUMENT_LIMIT',detail:{private:'synthetic secret detail'}});});
 const reply=await http(hub,owner.token,'/state');assert.equal(reply.status,422,reply.body);assert.equal(reply.json.code,'MEMORY_DOCUMENT_LIMIT');assert.doesNotMatch(reply.body,/private|secret|failure/);
});

test('a normal commit receipt cannot cross a purge boundary while a mode receipt can',async t=>{
 const hub=await createTestHub(options);t.after(()=>hub.close());const owner=await hub.createUser('合成回执清除竞争'),api=hub.records.personalSync!;
 await hub.hub.knowledge.memory.write(owner.principal,{space:'personal',title:'合成回执私人标题',markdown:'synthetic private receipt memory',expected_version:null,client_key:'receipt-race'});
 const state=(await http(hub,owner.token,'/state')).json,client_id=randomUUID();await http(hub,owner.token,'/clients',{client_id,name:'synthetic receipt client'});const session=(await http(hub,owner.token,'/sessions',{client_id,epoch:state.epoch,known_state:state.state_version,base_snapshot:state.snapshot})).json,operation_id=randomUUID();
 const committed=await http(hub,owner.token,'/sessions/'+session.session_id+'/commit',{schema:'personal-sync-commit@1',epoch:state.epoch,expected_state:state.state_version,operation_id,base_snapshot:state.snapshot,snapshot:state.snapshot});assert.equal(committed.status,200,committed.body);
 const original=api.result.bind(api);t.mock.method(api,'result',async(...args:Parameters<typeof api.result>)=>{const result=await original(...args);assert.ok(result);await hub.records.personalPayloads!.purge(owner.principal,state.epoch);return result;});
 const reply=await http(hub,owner.token,'/operations/'+operation_id+'?epoch='+state.epoch);assert.equal(reply.status,409,reply.body);assert.equal(reply.json.code,'SYNC_MODE_LOCAL');assert.equal(reply.json.projections,undefined);assert.equal(reply.json.state,undefined);
});

test('revocation during a download prevents delivery after the read completes',async t=>{
 const hub=await createTestHub(options);t.after(()=>hub.close());const owner=await hub.createUser('合成下载撤销'),api=hub.records.personalSync!,client_id=randomUUID(),state=(await http(hub,owner.token,'/state')).json;
 await http(hub,owner.token,'/clients',{client_id,name:'synthetic revoked download'});const session=(await http(hub,owner.token,'/sessions',{client_id,epoch:state.epoch,known_state:null,base_snapshot:null})).json;
 const original=api.download.bind(api);t.mock.method(api,'download',async(...args:Parameters<typeof api.download>)=>{const result=await original(...args);await hub.records.principals.revokeTokenValue(owner.token);return result;});
 const reply=await http(hub,owner.token,'/sessions/'+session.session_id+'/download',{epoch:state.epoch,objects:[]});assert.equal(reply.status,401,reply.body);assert.equal(reply.json.objects,undefined);
});

test('unknown routes, wrong methods and excess requests consume account admission without growing the audit log',async t=>{
 const hub=await createTestHub({...options,limits:{syncRequestsPerMinute:2}});t.after(()=>hub.close());const owner=await hub.createUser('合成拒收限流'),admitted=await hub.createUser('合成准入审计');
 const audits=(id:string)=>hub.records.store.findMany({kind:'action',key:'personal.sync.http.by',values:[id]});
 assert.equal((await http(hub,owner.token,'/unknown')).status,404);
 assert.equal((await http(hub,owner.token,'/state',{})).status,405);
 assert.equal((await audits(owner.user.id)).length,0,'route/method refusals cannot append immutable audits');
 for(let n=0;n<40;n++)assert.equal((await http(hub,owner.token,n%2?'/state':'/another-unknown')).status,429);
 assert.equal((await audits(owner.user.id)).length,0);
 for(let n=0;n<2;n++)assert.equal((await http(hub,admitted.token,'/state')).status,200);
 const accepted=await audits(admitted.user.id);assert.equal(accepted.length,4,'each admitted valid request still has its started/finished metadata');
 for(let n=0;n<40;n++)assert.equal((await http(hub,admitted.token,n%2?'/state':'/unknown',n%3?undefined:{})).status,429);
 assert.equal((await audits(admitted.user.id)).length,4,'denials after admission is exhausted cannot append audits');
});
