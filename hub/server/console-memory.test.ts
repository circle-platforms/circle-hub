// Real HTTP and MCP boundaries over synthetic accounts and temporary storage only.
import { credentialDetectorsFor } from '../testing/records.ts';
import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createTestHub} from './testing-real.ts';
import {startPostgres,type TemporaryPostgres} from '../testing/postgres.ts';
import {openConsole} from '../../tests/acceptance/support/console.ts';
import {connect} from '../../tests/acceptance/support/mcp.ts';
import {recordReaderFor} from './readers.ts';
import {recordReader} from '../runs/engine/readers.ts';

let postgres:TemporaryPostgres;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
const csrf=(text:string)=>/name="csrf" value="([^"]+)"/.exec(text)?.[1]??'';
const url=(document?:string,extra:Record<string,string>={})=>'/console/knowledge?'+new URLSearchParams({view:'memory',scope:'personal',...(document?{document}:{}),...extra});
async function world(){
 const hub=await createTestHub({postgres,repositoryPacks:false,stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false});
 const owner=await hub.createUser('合成记忆作者'),reader=await hub.createUser('合成记忆读者');
 const client=await connect(hub,owner.token),other=await connect(hub,reader.token),admin=await connect(hub,hub.admin.token);
 return {hub,owner,reader,client,other,admin,memory:hub.hub.knowledge.memory,close:async()=>{await client.close();await other.close();await admin.close();await hub.close();}};
}
test('memory MCP modes return versioned text without evidence identities or administrator access to private content',async t=>{
 const w=await world();t.after(w.close);
 const catalog=await w.hub.client(w.owner.token);const tools=await catalog.listTools();assert.equal(tools.tools.length,6);await catalog.close();
 const saved=await w.client.call('upload_file',{memory:{title:'合成私有偏好',markdown:'先核对合成事实，再列缺失信息。',expected_version:null,client_key:'mcp-create'}});
 assert.equal(saved.isError,false,saved.text);const doc=saved.out.memory_write!;assert.ok(doc);assert.equal(saved.out.reference,undefined);assert.equal(saved.out.artifact,undefined);
 const listed=await w.client.call('get_nodes',{memory:{scope:'personal',for_session:true}});assert.equal(listed.out.memory_page?.items[0].document,doc.document);
 const read=await w.client.call('get_nodes',{memory:{document:doc.document,version:doc.version,for_session:true}});assert.equal(read.out.memory_document?.markdown,'先核对合成事实，再列缺失信息。');assert.match(read.text,/不作为运行输入或依据/);
 for(const denied of [w.other,w.admin]){
  const hidden=await denied.call('get_nodes',{memory:{document:doc.document}}),missing=await denied.call('get_nodes',{memory:{document:'f'.repeat(64)}});assert.equal(hidden.isError,true);assert.deepEqual(hidden.out.errors,missing.out.errors);
 }
 for(const client of [w.client,w.admin])for(const digest of [doc.document,doc.version])assert.equal((await client.call('get_nodes',{reference:'rec:'+digest})).isError,true);
 const logs=await w.hub.records.callLog.query(w.hub.admin.principal,{});assert.ok(!JSON.stringify(logs).includes('先核对合成事实'));assert.ok(!JSON.stringify(logs).includes('合成私有偏好'));
});
test('password console forms edit escaped text, manage independent grants and remove revoked shared memories',async t=>{
 const w=await world();t.after(w.close);const own=await openConsole(w.hub,w.owner.token),other=await openConsole(w.hub,w.reader.token),admin=await openConsole(w.hub,w.hub.admin.token);
 const home=await own.get(url(undefined,{edit:'1'}));assert.equal(home.status,200,home.body);assert.match(home.body,/保存记忆/);
 const saved=await own.post('/console/knowledge/do/memory-write',{csrf:csrf(home.body),space:'personal',title:'合成控制台记忆',path:'/preferences',markdown:'<script>合成纯文本</script>',expected_version:'',client_key:'console-create',enabled:'true'});
 assert.equal(saved.status,303,saved.body);const target=String(saved.headers.location),document=new URL(target,'http://127.0.0.1').searchParams.get('document')!;
 const detail=await own.get(target);assert.match(detail.body,/&lt;script&gt;合成纯文本&lt;\/script&gt;/);assert.doesNotMatch(detail.body,/<script>合成纯文本/);assert.match(detail.body,/版本记录/);
 assert.equal((await admin.get(target)).status,404);
 const grantPage=await own.get(url());assert.match(grantPage.body,/action="\/console\/knowledge\/do\/memory-grant"/);
 const preview=await own.post('/console/knowledge/do/memory-grant',{csrf:csrf(grantPage.body),path:'/preferences',audience:'member',member:w.reader.user.name,preview_grant:'1'});assert.equal(preview.status,303);
 const checked=await own.get(String(preview.headers.location));assert.match(checked.body,new RegExp('name="member"[^>]*value="'+w.reader.user.name+'"'));assert.equal((checked.body.match(/name="member"/g)??[]).length,1);
 assert.equal((await w.memory.grants(w.owner.principal)).length,0);
 const granted=await own.post('/console/knowledge/do/memory-grant',{csrf:csrf(grantPage.body),path:'/preferences',audience:'member',member:w.reader.user.name});assert.equal(granted.status,303,granted.body);
 const shared=await other.get(url(undefined,{scope:'shared'}));assert.match(shared.body,/来自 合成记忆作者/);assert.match(shared.body,/合成控制台记忆/);assert.doesNotMatch(shared.body,/memory-write/);
 assert.doesNotMatch((await other.get(url(document))).body,/版本记录|memory-write/);
 const denied=await other.post('/console/knowledge/do/memory-write',{csrf:csrf(shared.body),space:'personal',document,expected_version:(await w.memory.read(w.owner.principal,document)).version,markdown:'不能改别人的偏好',client_key:'foreign-edit'});assert.equal(denied.status,404,denied.body);
 const revoked=await own.post('/console/knowledge/do/memory-revoke',{csrf:csrf(grantPage.body),path:'/preferences',audience:'member',member_id:w.reader.user.id});assert.equal(revoked.status,303,revoked.body);
 assert.doesNotMatch((await other.get(url(undefined,{scope:'shared'}))).body,/合成控制台记忆/);assert.equal((await other.get(url(document))).status,404);
 const origin=await own.send('/console/knowledge/do/memory-write',{method:'POST',headers:{origin:'http://192.0.2.1','content-type':'application/x-www-form-urlencoded'},body:'csrf='+csrf(grantPage.body)});assert.equal(origin.status,403);
});
test('a refused console memory write preserves a safe draft, remains uncommitted and can be corrected',async t=>{
 const w=await world();t.after(w.close);const own=await openConsole(w.hub,w.owner.token),home=await own.get(url(undefined,{edit:'1'}));
 const limit=w.hub.records.memoryIndex!.limits.documentBytes;w.hub.records.memoryIndex!.limits.documentBytes=8;
 const response=await own.post('/console/knowledge/do/memory-write',{csrf:csrf(home.body),space:'personal',title:'合成恢复标题',path:'/draft',markdown:'<script>合成可恢复正文</script>',expected_version:'',client_key:'synthetic-refused-key',enabled:'true'});
 assert.equal(response.status,400,response.body);assert.match(response.body,/name="markdown"/);assert.match(response.body,/&lt;script&gt;合成可恢复正文&lt;\/script&gt;/);assert.doesNotMatch(response.body,/<script>合成可恢复正文/);
 assert.equal((await w.memory.items(w.owner.principal,'personal')).length,0);
 const key=/name="client_key" value="([^"]+)"/.exec(response.body)![1];assert.notEqual(key,'synthetic-refused-key');w.hub.records.memoryIndex!.limits.documentBytes=limit;
 const saved=await own.post('/console/knowledge/do/memory-write',{csrf:csrf(response.body),space:'personal',title:'合成恢复标题',path:'/draft',markdown:'合成修正正文',expected_version:'',client_key:key,enabled:'true'});assert.equal(saved.status,303,saved.body);assert.equal((await w.memory.items(w.owner.principal,'personal')).length,1);
});

test('knowledge format failures preserve draft fields and scanner refusals do not echo suspect memory content',async t=>{ credentialDetectorsFor(t);
 const w=await world();t.after(w.close);const own=await openConsole(w.hub,w.owner.token),home=await own.get('/console/knowledge/space?'+new URLSearchParams({space:w.owner.user.id,edit:'1'}));
 const values={csrf:csrf(home.body),space:w.owner.user.id,path:'/draft',kind:'observation',statement:'合成保留陈述',data:'{invalid',applicability:'null',reason:'合成修正'};
 const refused=await own.post('/console/knowledge/do/entry',values);assert.equal(refused.status,400,refused.body);assert.match(refused.body,/合成保留陈述/);assert.match(refused.body,/\{invalid/);assert.match(refused.body,/aria-describedby="editor-data-error"/);
 const saved=await own.post('/console/knowledge/do/entry',{...values,csrf:csrf(refused.body),data:'{}'});assert.equal(saved.status,303,saved.body);
 const secret='DB_PASSWORD='+['Synth3tic','!2948'].join('');
 const blocked=await own.post('/console/knowledge/do/memory-write',{csrf:csrf(home.body),space:'personal',title:'合成安全标题',markdown:secret,path:'/',expected_version:'',client_key:'synthetic-secret-refusal'});
 assert.equal(blocked.status,400,blocked.body);assert.ok(!blocked.body.includes(secret));assert.match(blocked.body,/未回填/);assert.match(blocked.body,/合成安全标题/);
});

test('memory sharing previews write nothing and confirmation rechecks capacity instead of trusting a green page',async t=>{
 const w=await world();t.after(w.close);const own=await openConsole(w.hub,w.owner.token);
 const saved=await w.memory.write(w.owner.principal,{title:'合成共享偏好',markdown:'只陈述合成事实。',expected_version:null,client_key:'share-source'});
 const before=await w.hub.records.store.watermark!();const preview=await own.get(url(saved.document,{share:'1',client_key:'share-confirm'}));
 assert.equal(preview.status,200,preview.body);assert.match(preview.body,/新写入一篇/);assert.equal(await w.hub.records.store.watermark!(),before);
 w.hub.records.memoryIndex!.limits.spaceBytes=0;
 const refused=await own.post('/console/knowledge/do/memory-share',{csrf:csrf(preview.body),document:saved.document,version:saved.version,client_key:'share-confirm'});assert.equal(refused.status,303,refused.body);
 const receipt=await own.get(String(refused.headers.location));assert.match(receipt.body,/MEMORY_SPACE_LIMIT/);assert.match(receipt.body,/已拒收/);assert.equal((await w.memory.items(w.owner.principal,'team')).length,0);
 const retry=await w.client.call('upload_file',{memory_share:{document:saved.document,version:saved.version,client_key:'share-confirm'}});assert.equal(retry.out.errors[0]?.code,'MEMORY_SPACE_LIMIT',retry.text);
 assert.equal((await w.hub.records.store.find({kind:'memory_share',key:'memory.share.by',value:w.owner.user.id})).items.length,1,'a cached refusal retains its cause and appends no second share receipt');
});

test('memory refusal audits and unchanged receipts are absent through every generic record reader',async t=>{ credentialDetectorsFor(t);
 const w=await world();t.after(w.close);const store=w.hub.records.store;
 const refused=await w.client.call('upload_file',{memory:{title:'合成拒收',markdown:'合成说明\nDB_PASSWORD='+['Synth3tic','!2498'].join(''),expected_version:null,client_key:'private-audit'}});assert.equal(refused.out.errors[0]?.code,'MEMORY_CREDENTIALS_DETECTED');
 const saved=await w.memory.write(w.owner.principal,{title:'合成回执',markdown:'合成说明',expected_version:null,client_key:'private-receipt'});
 const unchanged=await w.memory.write(w.owner.principal,{document:saved.document,expected_version:saved.version,markdown:'合成说明',client_key:'unchanged-receipt'});assert.equal(unchanged.unchanged,true);
 const audits=(await store.list({kind:'action',limit:100})).items.filter(record=>record.schema==='memory-refusal@1'||record.schema==='memory-unchanged@1');assert.equal(audits.length,2);
 for(const principal of [w.owner.principal,w.hub.admin.principal])for(const audit of audits){
  const identity={user:principal.id,role:principal.role};
  assert.equal(await recordReader(store).read(audit.digest,identity),null);
  assert.equal(await recordReaderFor(w.hub.records,w.hub.hub.runs,principal).read(audit.digest,identity),null);
 }
 for(const client of [w.client,w.admin])for(const audit of audits){const hidden=await client.call('get_nodes',{reference:'rec:'+audit.digest}),missing=await client.call('get_nodes',{reference:'rec:'+'f'.repeat(64)});assert.equal(hidden.isError,true);// Memory audits are personal content: neutral, while an unknown digest is absent (D05 R[3], model 37).
assert.deepEqual(hidden.out.errors?.map(e=>e.code),['SOURCE_UNAVAILABLE']);assert.deepEqual(missing.out.errors?.map(e=>e.code),['SOURCE_ABSENT']);assert.ok(!JSON.stringify(hidden.out).includes('positions'));}
});
