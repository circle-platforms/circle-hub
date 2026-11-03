// Decision 88: real console and six-tool flows with synthetic passwords, temporary storage and the OS pack sandbox.
import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {parse,type DefaultTreeAdapterMap} from 'parse5';
type HtmlNode=DefaultTreeAdapterMap['node'];
const textOf=(node:HtmlNode):string=>'value' in node?node.value:'childNodes' in node?node.childNodes.map(textOf).join(''):'';
const rowTexts=(node:HtmlNode):string[]=>[...('tagName' in node&&node.tagName==='tr'?[textOf(node)]:[]),...('childNodes' in node?node.childNodes.flatMap(rowTexts):[])];
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTestHub,type TestHub} from '../../hub/server/testing-real.ts';
import {writePack,workflowPack} from '../../hub/runs/packs/testing/builder.ts';
import {sandboxSkip} from '../../hub/runs/engine/testing/harness.ts';
import {uiLabelOf,EntryKindSchema} from '../../contracts/generated/vocabulary.ts';
import {connect,type McpClient} from './support/mcp.ts';
import {openConsole,type ConsoleClient} from './support/console.ts';

const skip=await sandboxSkip(),pack='synthetic-memory-review';
let hub:TestHub,dir:string,owner:Awaited<ReturnType<TestHub['createUser']>>,reader:typeof owner;
let client:McpClient,other:McpClient,admin:McpClient,browser:ConsoleClient,received:ConsoleClient,adminBrowser:ConsoleClient;
let verified:{root:string;path:string;entry:string},note:string;
const csrf=(body:string)=>/name="csrf" value="([^"]+)"/.exec(body)?.[1]??'';
const knowledge=(scope:string)=>'/console/knowledge?'+new URLSearchParams({scope});
const memory=(parameters:Record<string,string>={})=>'/console/knowledge?'+new URLSearchParams({view:'memory',...parameters});
const space=(parameters:Record<string,string>)=>'/console/knowledge/space?'+new URLSearchParams(parameters);
before(async()=>{
 if(skip)return;
 dir=await mkdtemp(join(tmpdir(),'console-memory-acceptance-'));
 hub=await createTestHub({repositoryPacks:false,stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false});
 owner=await hub.createUser('合成控制台作者');reader=await hub.createUser('合成控制台接收人');
 client=await connect(hub,owner.token);other=await connect(hub,reader.token);admin=await connect(hub,hub.admin.token);
 browser=await openConsole(hub,owner.token);received=await openConsole(hub,reader.token);adminBrowser=await openConsole(hub,hub.admin.token);
 const spec=workflowPack({id:pack,product:{catalogs:[]}});spec.files['knowledge.json']={schema:'knowledge@1',requires:[]};
 const written=await writePack(join(dir,'workflow'),spec),published=await hub.hub.registry.personal!.publish(owner.principal,written.dir);assert.ok(published.ok,JSON.stringify(published));
 await hub.publishPack(written.dir);await hub.assignPack(owner.principal,pack);
 const source=await hub.records.artifacts.ingest({bytes:Buffer.from('合成来源：认证请求包含两项。'),mediaType:'text/plain',origin:{read:{object:'synthetic:document:console'}},author:{user:null},provenanceType:'observed',visibility:{readers:[owner.user.id],admins:true,packs:[],shareable:false}});
 const saved=await hub.hub.knowledge.spaces!.write(owner.principal,{path:'/方法/认证',kind:'observation',statement:'合成认证观察',grounds:[{reference:'src:'+source.body.sha256,quotation:'认证请求包含两项'}]});verified={root:saved.root,path:'/方法/认证',entry:saved.entry};
 note=(await hub.hub.knowledge.spaces!.write(owner.principal,{path:verified.path,kind:EntryKindSchema.enum.pitfall,statement:'合成待验证笔记'})).entry;
 await hub.hub.knowledge.spaces!.write(reader.principal,{path:'/共享经验',kind:EntryKindSchema.enum.pitfall,statement:'合成接收范围观察'});
 await hub.hub.knowledge.spaces!.grant(reader.principal,{path:'/共享经验',audience:'member',member:owner.user.id});
});
after(async()=>{await client?.close();await other?.close();await admin?.close();await hub?.close();if(dir)await rm(dir,{recursive:true,force:true});});

test('space panels show all four readable scopes and only verified own knowledge can be selected', {skip},async()=>{
 const home=await browser.get('/console/knowledge');assert.equal(home.status,200,home.body);
 for(const scope of ['all','personal','shared','team'] as const)assert.ok(home.body.includes(uiLabelOf('knowledge_search_scope',scope)));
 assert.match(home.body,/最近变化/);assert.doesNotMatch(home.body,/知识入库流程/);
 assert.match(home.body,/与我共享 › 合成控制台接收人 › 共享经验/);
 const own=await browser.get(space({space:owner.user.id,path:verified.path}));assert.equal(own.status,200,own.body);
 assert.match(textOf(parse(own.body)),/知识库 › 我的 › 方法/);assert.match(own.body,/<h1[^>]*>认证<\/h1>/);assert.doesNotMatch(own.body,/id="page-sub"/);assert.match(own.body,new RegExp('name="selected_entry" value="'+verified.entry+'"'));
 assert.doesNotMatch(own.body,new RegExp('name="selected_entry" value="'+note+'"'));assert.match(own.body,/type="checkbox"/);
 assert.match(own.body,/<span class="ch-badge ch-badge--pass"><span[^>]*><\/span>已验证<\/span>/);assert.match(own.body,/<span class="ch-badge ch-badge--pending"><span[^>]*><\/span>待验证<\/span>/);
 assert.match(textOf(parse(own.body)),/\/ 上限 1\.0 GB/);assert.doesNotMatch(own.body,/上限 1073741824 字节/);
 assert.match(own.body,/<details class="ch-section" id="knowledge-history"><summary[^>]*>知识版本记录<\/summary>/);assert.doesNotMatch(own.body,/<details[^>]*open[^>]*><summary[^>]*>知识版本记录/);
 assert.match(own.body,/<span class="nowrap" title="\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}">版本 2 · (?:今天 \d{2}:\d{2}|昨天|\d{2}-\d{2}|\d{4}-\d{2}-\d{2})<\/span> ·/);
 assert.equal((own.body.match(/href="#grant-knowledge"/g)??[]).length,1);
 const checked=await browser.post('/console/knowledge/do/grant',{csrf:csrf(own.body),path:verified.path,audience:'administrators',member:reader.user.name,preview_grant:'1'});
 assert.equal(checked.status,303);const checkedPage=await browser.get(String(checked.headers.location));
 assert.match(checkedPage.body,/<option value="administrators" selected>/);assert.equal((await hub.hub.knowledge.spaces!.grants(owner.principal)).length,0,'preview grants nothing');
 const shared=await browser.get(knowledge('shared'));assert.match(shared.body,/来自 合成控制台接收人/);assert.match(shared.body,/合成接收范围观察/);
 const outsider=await adminBrowser.get(knowledge('shared'));assert.doesNotMatch(outsider.body,/合成接收范围观察/);
 const metadata=await adminBrowser.get('/console/team/'+owner.user.id);assert.equal(metadata.status,200,metadata.body);assert.match(metadata.body,/私人空间容量/);assert.doesNotMatch(metadata.body,/合成认证观察|合成待验证笔记|本文件夹条目/);
});

test('a duplicate stops the preview before credential scanning and team rows retain their actual source', {skip},async()=>{
 const spaces=hub.hub.knowledge.spaces!,original=await spaces.entry(owner.principal,verified.root,verified.path,verified.entry);assert.ok(original);
 const saved=await spaces.write(owner.principal,{path:verified.path,kind:EntryKindSchema.enum.observation,statement:'合成重复预检观察',grounds:original.body.grounds});
 const input={root:saved.root,path:verified.path,entry:saved.entry,team_path:'/共享/重复'};
 const merged=await client.call('upload_file',{share_entry:input});assert.equal(merged.isError,false,merged.text);
 const home=await browser.get('/console/knowledge');
 assert.match(home.body,/<a href="\/console\/knowledge\/space\?space=team[^\"]+">合成重复预检观察<\/a>/);
 assert.doesNotMatch(home.body,new RegExp('>'+saved.entry.slice(0,12)+'</a>'));
 const preview=await browser.get(space({space:owner.user.id,root:saved.root,path:verified.path,entry:saved.entry,team_path:input.team_path,share:'1'}));assert.equal(preview.status,200,preview.body);
 const checks=rowTexts(parse(preview.body));assert.ok(checks.some(row=>row.startsWith('与团队条目不重复未通过')));assert.ok(checks.some(row=>row.startsWith('凭据扫描未检查')));assert.match(preview.body,/已有团队条目/);
 const team=await received.get(space({space:'team',path:input.team_path}));assert.equal(team.status,200,team.body);for(const field of ['提交人','来源','合并时间'])assert.ok(team.body.includes(field));assert.doesNotMatch(team.body,/<input[^>]+name="selected_entry"/);
});

test('knowledge batch previews stop honestly and confirmation rechecks a withdrawal', {skip},async()=>{
 const view=await hub.hub.knowledge.spaces!.entry(owner.principal,verified.root,verified.path,verified.entry);assert.ok(view);
 const second=await hub.hub.knowledge.spaces!.write(owner.principal,{path:verified.path,kind:EntryKindSchema.enum.observation,statement:'合成第二条批量观察',grounds:view.body.grounds});
 const current=(await hub.hub.knowledge.spaces!.current(owner.user.id))!;
 const params=new URLSearchParams({root:current.root,path:verified.path,selected_entry:verified.entry,team_path:'/共享/认证'});
 params.append('selected_entry',second.entry);
 const before=await hub.records.store.watermark!(),preview=await browser.get('/console/knowledge/share-batch?'+params);
 assert.equal(preview.status,200,preview.body);assert.match(preview.body,/确认分享到团队/);assert.equal(await hub.records.store.watermark!(),before);
 assert.doesNotMatch(preview.body,/<button[^>]+disabled[^>]*>确认分享到团队/);
 await hub.hub.knowledge.spaces!.withdraw(owner.principal,verified.entry,owner.user.id);
 params.set('csrf',csrf(preview.body));
 const confirmed=await browser.send('/console/knowledge/do/share-batch',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin:'http://127.0.0.1:'+browser.port},body:params.toString()});
 assert.equal(confirmed.status,303,confirmed.body);
 const history=await browser.get(String(confirmed.headers.location));assert.match(history.body,/SHARE_UNVERIFIED/);assert.match(history.body,/已拒收/);
 const receipts=await hub.hub.knowledge.spaces!.shareHistory(owner.principal);
 assert.equal(receipts.items.find(receipt=>receipt.source.entry===second.entry)?.status,'merged','another selected entry is rechecked and merged independently');
});

test('workflow grants reuse the dialog, hide unavailable team publication and expose no personal external actions', {skip},async()=>{
 const detail=await browser.get('/console/packs/'+pack+'?space='+owner.user.id);assert.equal(detail.status,200,detail.body);assert.match(detail.body,/id="grant-pack"/);
 const listing=await browser.get('/console/packs?scope=personal');assert.match(listing.body,new RegExp('href="/console/packs/'+pack+'\\?space='+owner.user.id));
 const team=await browser.get('/console/packs?scope=team');assert.match(team.body,/使用范围：团队/);assert.doesNotMatch(team.body,/使用范围：本人及|使用范围：合成控制台作者/);
 const adminTeam=await adminBrowser.get('/console/packs?scope=team');assert.match(adminTeam.body,/使用范围：合成控制台作者/);
 assert.match(detail.body,/<button[^>]+disabled[^>]+title="没有发布权/);assert.doesNotMatch(detail.body,/name="(?:leases|dispatch|system|named_document)"|cmd-pack-assign/);
 const preview=await browser.post('/console/packs/do/grant',{csrf:csrf(detail.body),pack,audience:'member',member:reader.user.name,preview_grant:'1'});assert.equal(preview.status,303);
 const checked=await browser.get(String(preview.headers.location));assert.equal(checked.status,200,checked.body);
 assert.equal((checked.body.match(/name="member"/g)??[]).length,1);assert.match(checked.body,/name="member"[^>]*value="合成控制台接收人"/);
 assert.equal((await hub.hub.registry.personal!.grants(owner.principal,pack)).length,0);
 const granted=await browser.post('/console/packs/do/grant',{csrf:csrf(checked.body),pack,audience:'member',member:reader.user.name});assert.equal(granted.status,303,granted.body);
 const visible=await received.get('/console/packs?scope=shared');assert.match(visible.body,/来自 合成控制台作者/);assert.match(visible.body,new RegExp(pack));
 const revoke=await browser.post('/console/packs/do/revoke',{csrf:csrf(detail.body),pack,audience:'member',member_id:reader.user.id});assert.equal(revoke.status,303,revoke.body);
 assert.doesNotMatch((await received.get('/console/packs?scope=shared')).body,new RegExp(pack));
});

let memoryDocument:string,memoryVersion:string;
test('memory modes remain private, reject evidence binding and accept independent equal-byte uploads', {skip},async()=>{
 const markdown='{"format":"synthetic-only"}';
 const saved=await client.call('upload_file',{memory:{title:'合成会话记忆',path:'/偏好',markdown,expected_version:null,client_key:'accept-create'}});assert.equal(saved.isError,false,saved.text);memoryDocument=saved.out.memory_write!.document;memoryVersion=saved.out.memory_write!.version;
 const page=await client.call('get_nodes',{memory:{scope:'personal',for_session:true}});assert.equal(page.out.memory_page!.items[0].document,memoryDocument);
 const read=await client.call('get_nodes',{memory:{document:memoryDocument,version:memoryVersion,for_session:true}});assert.equal(read.out.memory_document?.markdown,markdown);
 for(const who of [client,admin])for(const digest of [memoryDocument,memoryVersion])assert.equal((await who.call('get_nodes',{reference:'rec:'+digest})).isError,true);
 const denied=await client.call('start_run',{pack,pack_space:owner.user.id,inputs:{target:{reference:'rec:'+memoryVersion}}});assert.equal(denied.out.errors[0]?.code,'SOURCE_UNAVAILABLE');assert.equal(denied.out.run,undefined);
 const independent=await client.upload(Buffer.from(markdown),'synthetic.json','application/json');const started=await client.call('start_run',{pack,pack_space:owner.user.id,inputs:{target:{reference:independent}}});assert.equal(started.isError,false,started.text);
 await hub.hub.knowledge.spaces!.grant(owner.principal,{path:'/',audience:'member',member:reader.user.id});
 assert.equal((await other.call('get_nodes',{memory:{document:memoryDocument}})).isError,true);
 const own=await browser.get(memory({scope:'personal'}));assert.match(own.body,/memory-grants/);
 assert.equal((await browser.post('/console/knowledge/do/memory-grant',{csrf:csrf(own.body),path:'/偏好',audience:'member',member:reader.user.name})).status,303);
 const browsed=await other.call('get_nodes',{memory:{document:memoryDocument}});assert.equal(browsed.isError,false,browsed.text);assert.equal(browsed.out.memory_document?.auto_load_allowed,false);
 assert.equal((await other.call('get_nodes',{memory:{document:memoryDocument,version:memoryVersion,for_session:true}})).isError,true);
 const shared=await received.get(memory({scope:'shared'}));assert.match(shared.body,/来自 合成控制台作者/);assert.match(shared.body,/合成会话记忆/);
 assert.equal((await browser.post('/console/knowledge/do/memory-revoke',{csrf:csrf(own.body),path:'/偏好',audience:'member',member_id:reader.user.id})).status,303);
 assert.equal((await other.call('get_nodes',{memory:{document:memoryDocument}})).isError,true);
});

test('memory limits and credential refusals are real; re-sharing preserves administrator edits', {skip},async()=>{
 const oversized=await client.call('upload_file',{memory:{title:'合成超限',markdown:'合'.repeat(8001),expected_version:null,client_key:'over-document'}});assert.equal(oversized.out.errors[0]?.code,'MEMORY_DOCUMENT_LIMIT');
 const secret='DB_PASSWORD=synthetic-secret-7429';
 for(let attempt=0;attempt<2;attempt++){const refused=await client.call('upload_file',{memory:{title:'合成拒收',markdown:secret,expected_version:null,client_key:'credential-refusal'}});assert.equal(refused.out.errors[0]?.code,'MEMORY_CREDENTIALS_DETECTED');assert.ok(!refused.text.includes('synthetic-secret-7429'));if(attempt===0)assert.match(refused.text,/Markdown 正文第 1 行/);}
 const audits=await hub.records.store.find({kind:'action',key:'memory.refusal.by',value:owner.user.id});assert.equal(audits.items.filter(row=>(row.body as {code:string}).code==='MEMORY_CREDENTIALS_DETECTED').length,1);assert.ok(!JSON.stringify(audits).includes(secret));
 const input={document:memoryDocument,version:memoryVersion,client_key:'accept-share'};
 const before=await hub.records.store.watermark!(),plan=await client.call('upload_file',{memory_share:{...input,check_only:true}});assert.equal(plan.out.memory_share?.effect,'create');assert.equal(await hub.records.store.watermark!(),before+1,'only the ordinary call log is appended by MCP preview');
 const first=await client.call('upload_file',{memory_share:input});assert.equal(first.isError,false,first.text);const team=first.out.memory_share!.share!;
 const edited=await client.call('upload_file',{memory:{document:memoryDocument,expected_version:memoryVersion,markdown:'合成修订偏好',client_key:'accept-edit'}});memoryVersion=edited.out.memory_write!.version;
 const replacement=await browser.get(memory({document:memoryDocument,share:'1',client_key:'accept-replace'}));assert.match(replacement.body,/取代 合成会话记忆/);
 const adminEdit=await hub.hub.knowledge.memory.write(hub.admin.principal,{space:'team',document:team.team_document!,expected_version:team.team_version!,markdown:'合成管理员保留的正文',client_key:'admin-edit'});
 const fresh=await browser.get(memory({document:memoryDocument,share:'1',client_key:'accept-replace'}));assert.match(fresh.body,/新写入一篇/);
 const final=await client.call('upload_file',{memory_share:{document:memoryDocument,version:memoryVersion,client_key:'accept-replace'}});assert.equal(final.isError,false,final.text);assert.notEqual(final.out.memory_share?.share?.team_document,team.team_document);
 assert.equal((await hub.hub.knowledge.memory.read(owner.principal,team.team_document!)).version,adminEdit.version);assert.equal((await hub.hub.knowledge.memory.read(owner.principal,team.team_document!)).markdown,'合成管理员保留的正文');
 const teamSession=await other.call('get_nodes',{memory:{scope:'team',for_session:true}});assert.equal(teamSession.out.memory_page!.items.length,2);
});

test('memory refusal audits and unchanged receipts cannot bind as inputs even for assigned administrators', {skip},async()=>{
 const unchanged=await client.call('upload_file',{memory:{document:memoryDocument,expected_version:memoryVersion,client_key:'accept-unchanged'}});assert.equal(unchanged.out.memory_write?.unchanged,true,unchanged.text);
 const records=(await hub.records.store.list({kind:'action',limit:100})).items.filter(record=>record.schema==='memory-refusal@1'||record.schema==='memory-unchanged@1');assert.ok(records.some(record=>record.schema==='memory-refusal@1'));assert.ok(records.some(record=>record.schema==='memory-unchanged@1'));
 await hub.assignPack(hub.admin.principal,pack);
 for(const who of [client,admin])for(const record of records){
  const read=await who.call('get_nodes',{reference:'rec:'+record.digest});assert.equal(read.isError,true);assert.ok(!read.text.includes('"positions"'));
  const started=await who.call('start_run',{pack,inputs:{target:{reference:'rec:'+record.digest}}});assert.equal(started.out.errors[0]?.code,'SOURCE_UNAVAILABLE',started.text);assert.equal(started.out.run,undefined);
 }
});


test('entry inspectors keep counts with labels and one ordered action row; opening withdrawal only displays its confirmation', {skip},async()=>{
 const spaces=hub.hub.knowledge.spaces!,original=await spaces.entry(owner.principal,verified.root,verified.path,verified.entry);assert.ok(original);
 const current=await spaces.write(owner.principal,{path:'/方法/认证',kind:EntryKindSchema.enum.observation,statement:'合成操作栏检查',grounds:original.body.grounds});
 const path=space({space:owner.user.id,path:'/方法/认证',root:current.root,entry:current.entry});
 const before=await hub.records.store.watermark!(),reply=await browser.get(path);
 assert.equal(reply.status,200,reply.body);
 assert.match(reply.body,/<h2 class="ch-section-label"[^>]*>来源 · 1<\/h2>/);
 const foot=/<footer class="ch-inspector-actions">([\s\S]*?)<\/footer>/.exec(reply.body)?.[1]??'';
 assert.match(foot,/ch-btn--ghost[^>]*>知识版本记录<\/a>[\s\S]*ch-btn--danger[^>]*>撤回…<\/a>[\s\S]*ch-btn--secondary[^>]*>分享到团队…<\/a>[\s\S]*ch-btn--primary[^>]*>编辑<\/a>/);
 assert.doesNotMatch(foot,/<details|<summary|<form/);
 assert.match(reply.body,/<div class="ch-dialog" id="withdraw-entry"[\s\S]*action="\/console\/knowledge\/do\/withdraw"/);
 const confirmation=await browser.get(path+'#withdraw-entry');assert.equal(confirmation.status,200);
 assert.equal(await hub.records.store.watermark!(),before,'GET selection and confirmation never perform a withdrawal');
 assert.equal((await spaces.entry(owner.principal,current.root,'/方法/认证',current.entry))?.row.status,'verified');
});
