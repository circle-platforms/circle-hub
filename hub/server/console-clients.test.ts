// Knowledge interface phase 2 (docs/hub-r4-tasks/knowledge-ui-phase2.md, sections 1 and 2) on a temporary PostgreSQL:
// connected clients by the names they reported, entry version lines, superseded links, empty states and success
// messages. Every account, client name and folder is synthetic; no deployed Hub is touched.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createTestHub} from './testing-real.ts';
import {openConsole} from '../../tests/acceptance/support/console.ts';
import {wordingProblems} from './console/testing-wording.ts';
import {identityPage,confirmPage} from './console/authorize.ts';
import {shareFeedback,actionNotice} from './console/feedback.ts';
import {UNNAMED_CLIENT,type AuthorizationRequest} from './oauth.ts';
import {uiLabelOf} from '../../contracts/generated/vocabulary.ts';

const options={repositoryPacks:false,stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false};
const csrfOf=(body:string)=>/name="csrf" value="([^"]+)"/.exec(body)?.[1]??'';
/** The visible text of a fragment, tags removed. */
const visible=(markup:string)=>markup.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g,'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ');
const section=(body:string,marker:string)=>{const start=body.indexOf(marker);assert.ok(start>=0,marker);return body.slice(start,body.indexOf('</ul>',start));};

test('the authorization page names the client by its registered name, or 客户端 when it registered none',()=>{
 const base:AuthorizationRequest={id:'synthetic-request',client:{id:'synthetic-client',name:'合成编辑器'},redirectUri:'http://127.0.0.1:43123/callback',redirectSent:true,state:null,challenge:'s'.repeat(43),peer:'127.0.0.1',resource:'http://127.0.0.1/mcp',issuer:'http://127.0.0.1',secure:false,created:0,csrf:'synthetic-csrf',browser:'synthetic-browser',invitation:null,failures:0} as AuthorizationRequest;
 const named=identityPage(base,null).text,unnamed=identityPage({...base,client:{id:'synthetic-client',name:UNNAMED_CLIENT}},null).text;
 assert.match(named,/<h1 class="ch-title">[\s\S]*允许 <span data-evidence>合成编辑器<\/span> 连接/);
 assert.match(named,/<title>允许客户端连接 · circle-hub<\/title>/,'the browser tab never carries a recorded name');
 assert.match(unnamed,/<h1 class="ch-title">[\s\S]*允许客户端连接/);
 assert.ok(!unnamed.includes(UNNAMED_CLIENT),'the Hub placeholder is shown as 客户端');
 const confirm=confirmPage({...base,client:{id:'synthetic-client',name:UNNAMED_CLIENT}},{id:'synthetic-account',name:'合成成员',role:'成员'},'session','synthetic-csrf',null).text;
 assert.match(confirm,/允许 <b>客户端<\/b> 连接本 Hub/);
 // The registration id is a technical detail, never on the page itself.
 assert.ok(!visible(confirm.replace(/<details[\s\S]*?<\/details>/g,'')).includes('synthetic-client'));
 assert.match(confirm,/<details class="ch-section" data-technical>[\s\S]*synthetic-client/);
 for(const page of [named,unnamed,confirm]){assert.deepEqual(wordingProblems(page),[]);assert.doesNotMatch(visible(page),/\bCircle\b/);}
});

test('connections, team and settings list each client by the name and version it reported in initialize',async t=>{
 const hub=await createTestHub(options);t.after(()=>hub.close());
 const owner=await hub.createUser('合成客户端成员');
 const session=await hub.client(owner.token,{sessionId:'synthetic-client-session'});t.after(()=>session.close());
 // A registration without client_name, issued through the standard authorization: the Hub records its placeholder.
 const unnamed=await hub.records.principals.registerClient(UNNAMED_CLIENT,['http://127.0.0.1:43123/callback']);
 await hub.records.principals.issueToken(hub.admin.principal,owner.user.id,UNNAMED_CLIENT,unnamed.id);
 const admin=await openConsole(hub,hub.admin.token),member=await openConsole(hub,owner.token);
 for(const path of ['/console/connections','/console/team']){
  const reply=await admin.get(path);assert.equal(reply.status,200,path);
  const tables=[...reply.body.matchAll(/<table[\s\S]*?<\/table>/g)].map(match=>match[0]).join('');
  assert.match(tables,/<th scope="col">客户端<\/th><th scope="col">成员<\/th><th scope="col">连接方式<\/th><th scope="col">最近凭据使用<\/th>/,path);
  assert.match(tables,/<span data-evidence>hub-test-real 0\.0\.0<\/span>/,'the name and version from clientInfo, as recorded');
  assert.match(tables,/访问令牌 · <span data-evidence>test<\/span>/,'the token it connected with');
  assert.match(tables,/<span data-evidence>客户端<\/span>[\s\S]*标准连接确认</,'an unnamed registration is 客户端');
  assert.ok(!tables.includes(UNNAMED_CLIENT));
  assert.deepEqual(wordingProblems(reply.body),[],path);assert.doesNotMatch(visible(reply.body.replace(/<span data-evidence>[^<]*<\/span>/g,'')),/\bCircle\b/,path);
 }
 const token=(await hub.records.principals.identify!('Bearer '+owner.token))!.token_id;
 const selected=await admin.get('/console/connections?circle='+token);assert.equal(selected.status,200);
 assert.match(selected.body,/<span class="ch-tag">客户端<\/span><h2 class="ch-panel-title"><span data-evidence>hub-test-real<\/span><\/h2>/);
 assert.match(selected.body,/<dt>版本<\/dt><dd><span data-evidence>0\.0\.0<\/span><\/dd>/);
 assert.match(selected.body,/data-technical>[\s\S]*名称来源[\s\S]*MCP initialize clientInfo/,'where the name came from stays in the technical details');
 const mine=await member.get('/console/settings');assert.equal(mine.status,200);
 assert.match(mine.body,/我的客户端/);assert.match(mine.body,/hub-test-real 0\.0\.0/);assert.deepEqual(wordingProblems(mine.body),[]);
});

test('an entry lists its versions as who · client · when · what changed, and a superseded entry links to its replacement',async t=>{
 const hub=await createTestHub(options);t.after(()=>hub.close());const spaces=hub.hub.knowledge.spaces!;
 const owner=await hub.createUser('合成版本作者');
 const session=await hub.client(owner.token,{sessionId:'synthetic-version-session'});t.after(()=>session.close());
 const written=await session.call('upload_file',{personal_entry:{kind:'observation',statement:'合成版本条目',path:'/方法'}});assert.equal(written.isError,false,JSON.stringify(written));
 const first=(await spaces.current(owner.user.id))!.body.entries.find(row=>row.path==='/方法')!;
 const source=await hub.records.artifacts.ingest({bytes:Buffer.from('合成原文：先核对输入再检查权限。'),name:'合成原文.txt',mediaType:'text/plain',origin:{read:{object:'synthetic:document:versions'}},author:{user:null},provenanceType:'observed',visibility:{readers:[owner.user.id],admins:true,packs:[],shareable:false}});
 const second=await spaces.write(owner.principal,{path:'/方法',kind:'observation',statement:'合成版本条目：先核对输入',grounds:[{reference:'src:'+source.body.sha256,quotation:'先核对输入再检查权限'}],replaces:first.entry});
 const browser=await openConsole(hub,owner.token);
 const url=(entry:string)=>'/console/knowledge/space?'+new URLSearchParams({space:owner.user.id,path:'/方法',entry});
 const current=await browser.get(url(second.entry));assert.equal(current.status,200,current.body);
 const lines=[...section(current.body,'data-entry-versions').matchAll(/<li>([\s\S]*?)<\/li>/g)].map(match=>visible(match[1]).trim());
 assert.equal(lines.length,2,lines.join('\n'));
 assert.match(lines[0],/^合成版本作者 · 客户端 · \S.* 更新了内容和来源$/,'a write that reported no client is 客户端');
 assert.match(lines[1],/^合成版本作者 · hub-test-real · \S.* 新建了条目$/,'the first version keeps the client that declared itself');
 assert.deepEqual(wordingProblems(current.body),[]);
 const old=await browser.get(url(first.entry));assert.equal(old.status,200,old.body);
 const notice=/<p class="notice">([\s\S]*?)<\/p>/.exec(old.body)?.[1]??'';
 assert.ok(notice.startsWith(uiLabelOf('knowledge_entry_status','superseded')+' · '),notice);assert.match(notice,new RegExp('<a href="[^"]*entry='+second.entry+'[^"]*">查看取代它的条目</a>'));
 // A reader the folder is shared with sees the entry but not its version history, like the space's own records.
 const reader=await hub.createUser('合成版本读者');await spaces.grant(owner.principal,{path:'/方法',audience:'member',member:reader.user.id});
 const shared=await (await openConsole(hub,reader.token)).get(url(second.entry));assert.equal(shared.status,200);assert.ok(!shared.body.includes('data-entry-versions'));
});

test('empty lists say what appears there with one action, and knowledge actions report what they did',async t=>{
 const hub=await createTestHub(options);t.after(()=>hub.close());
 const owner=await hub.createUser('合成空状态成员'),browser=await openConsole(hub,owner.token);
 const team=await browser.get('/console/knowledge?scope=team');assert.equal(team.status,200);
 assert.match(team.body,/<div class="ch-empty"><p class="ch-empty-title">团队还没有知识<\/p><p class="ch-empty-text">[^<]+<\/p><div class="ch-actions"><a class="ch-btn ch-btn--primary" href="\/console\/knowledge\?scope=personal">打开我的知识<\/a><\/div><\/div>/);
 const submissions=await browser.get('/console/knowledge/submissions');assert.equal(submissions.status,200);
 assert.match(submissions.body,/<p class="ch-empty-title">还没有分享到团队的内容<\/p><p class="ch-empty-text">[^<]+<\/p><div class="ch-actions"><a class="ch-btn ch-btn--primary" href="\/console\/knowledge\?scope=personal">打开我的知识<\/a>/);
 for(const body of [team.body,submissions.body])assert.deepEqual(wordingProblems(body),[]);
 const folder='/console/knowledge/space?'+new URLSearchParams({space:owner.user.id,path:'/'});
 const created=await browser.post('/console/knowledge/do/directory',{csrf:csrfOf((await browser.get(folder)).body),space:owner.user.id,path:'/合成文件夹'});assert.equal(created.status,303,created.body);
 const after=await browser.get(String(created.headers.location));assert.match(after.body,/data-toast-success[^>]*>已新建文件夹 · 合成文件夹<\/div>/);
 assert.doesNotMatch(after.body,/操作已完成/);
 const entry=await browser.post('/console/knowledge/do/entry',{csrf:csrfOf(after.body),space:owner.user.id,path:'/合成文件夹',kind:'observation',statement:'合成提示条目',reason:'合成写入'});assert.equal(entry.status,303,entry.body);
 assert.match((await browser.get(String(entry.headers.location))).body,/data-toast-success[^>]*>已保存条目<\/div>/);
 const empty=await browser.get('/console/knowledge/space?'+new URLSearchParams({space:owner.user.id,path:'/合成文件夹'}));
 assert.doesNotMatch(empty.body,/这个文件夹还没有知识/,'a folder with an entry is not empty');
});

test('success messages count merged and refused shares and name the action',()=>{
 assert.equal(shareFeedback([{status:'merged'},{status:'merged'}]),'已分享到团队 · 2 条');
 assert.equal(shareFeedback([{status:'merged'},{status:'rejected'}]),'已分享到团队 · 1 条；已拒收 1 条');
 assert.equal(shareFeedback([{status:'rejected'}]),'未分享到团队 · 已拒收 1 条');
 const values=(fields:Record<string,string>)=>new URLSearchParams(fields);
 assert.equal(actionNotice('knowledge','withdraw',values({})),'已撤回条目');
 assert.equal(actionNotice('knowledge','entry',values({replaces:'a'.repeat(64)})),'已更新条目');
 assert.equal(actionNotice('knowledge','grant',values({audience:'member',member:'合成读者'})),'已分享给合成读者');
 assert.equal(actionNotice('knowledge','grant',values({audience:'member',member:'Synthetic Reader'})),'已分享给 Synthetic Reader');
 assert.equal(actionNotice('knowledge','revoke',values({})),'已收回分享');
 assert.equal(actionNotice('memory','write',values({enabled:'false'})),'已停用记忆');
 assert.equal(actionNotice('packs','retire',values({})),'已下架这个版本');
 assert.equal(actionNotice('knowledge','unknown',values({})),null);
});
