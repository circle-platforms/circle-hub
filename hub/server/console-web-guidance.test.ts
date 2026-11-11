// What the audit of the console against the modern-web-guidance guides found and fixed (2026-11-12): the checks here keep
// those fixes. Each names the guide its rule comes from. Synthetic data only.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createTestHub} from './testing-real.ts';
import {openConsole} from '../../tests/acceptance/support/console.ts';
import {CSS} from './console/style.ts';
import {INTERACTION_SCRIPT} from './console/interaction.ts';

test('every signed-in page declares its colour schemes and starts with one skip link to its main content',async t=>{
 const hub=await createTestHub({repositoryPacks:false,stubs:false,requireOsIsolation:false});t.after(()=>hub.close());
 const owner=await hub.createUser('合成读者'),client=await openConsole(hub,owner.token);
 for(const path of ['/console/overview','/console/runs','/console/knowledge','/console/settings']){
  const reply=await client.get(path);assert.equal(reply.status,200,path);
  // dark-mode: the supported schemes are declared in the HTML, before the stylesheet.
  assert.ok(reply.body.includes('<meta name="color-scheme" content="light dark">'),path);
  assert.ok(reply.body.indexOf('<meta name="color-scheme"')<reply.body.indexOf('rel="stylesheet"'),path);
  // accessibility, skip links: the first thing in the body, before the navigation, and it leads to the one main landmark.
  const body=reply.body.slice(reply.body.indexOf('<body'));
  assert.match(body,/^<body class="hub"><a class="ch-skip" href="#console-main">跳到主要内容<\/a>/,path);
  assert.equal((body.match(/class="ch-skip"/g)??[]).length,1,'a single skip link');
  assert.equal((body.match(/<main\b/g)??[]).length,1,'one main landmark');
  assert.ok(body.includes('<main class="ch-pane" id="console-main" tabindex="-1">'),'the target takes focus without joining the tab order');
  assert.ok(body.indexOf('class="ch-skip"')<body.indexOf('<nav class="ch-nav"'),'before the repeated navigation');
 }
 // The sign-in page has nothing to skip: its only content is the form.
 const signIn=await (await openConsole(hub)).get('/console/login');
 assert.equal(signIn.status,200);assert.ok(!signIn.body.includes('ch-skip'));assert.ok(signIn.body.includes('<meta name="color-scheme" content="light dark">'));
});

test('the stylesheet keeps the skip link out of sight until focused, scrolls a row of page tabs in its own box and gives fields an outline in forced colours',()=>{
 for(const rule of [
  '.ch-skip { position: absolute;',
  '.ch-skip:focus { transform: none; }',
  // tabs: one row that scrolls, never a wider page.
  'main nav.ch-seg { max-width: 100%; overflow-x: auto;',
  'main nav.ch-seg a { flex: none; }',
  // color, forced colours: a box-shadow ring is removed there.
  '.ch-input:focus-within, .ch-composer:focus-within { outline: 2px solid Highlight; outline-offset: 1px; }',
  '.ch-original-preview:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }',
  // A long unbreakable value wraps in its cell.
  '.ch-kv dd { min-width: 0; overflow-wrap: anywhere; }',
 ])assert.ok(CSS.includes(rule),rule);
 assert.match(CSS,/@media \(forced-colors: active\) \{\n  \.ch-input:focus-within/);
});

test('the page script moves the current tab into a scrolling tab row and takes no composing Enter for a command',()=>{
 assert.ok(INTERACTION_SCRIPT.includes("document.querySelectorAll('main nav.ch-seg a[aria-current]')"));
 assert.ok(INTERACTION_SCRIPT.includes('row.scrollLeft +='),'the row scrolls, the page does not');
 // ime-safe-enter-submit: Enter that confirms an input method's composition is not a command.
 assert.ok(INTERACTION_SCRIPT.includes("event.key === 'Enter' && !event.isComposing"));
});

test('a search link whose page no longer fits starts the search again at its first page and says so',async t=>{
 const hub=await createTestHub({repositoryPacks:false,stubs:false,requireOsIsolation:false});t.after(()=>hub.close());
 const owner=await hub.createUser('合成搜索者'),spaces=hub.hub.knowledge.spaces!,client=await openConsole(hub,owner.token);
 await spaces.ensure(owner.principal,owner.user.id);
 for(let n=1;n<=3;n++)await spaces.write(owner.principal,{path:'/方法',kind:'observation',statement:`合成搜索词 认证 第 ${n} 条`});
 const query=new URLSearchParams({q:'认证',scope:'all'});
 const first=await client.get('/console/search?'+query);
 assert.equal(first.status,200);assert.ok(first.body.includes('合成搜索词'));assert.ok(!first.body.includes('已从第一页重新搜索'));
 // A cursor that binds another state of the knowledge, as a link kept from before an entry was written.
 const stale=Buffer.from(JSON.stringify({binding:'0'.repeat(64),offset:30})).toString('base64url');
 const again=await client.get('/console/search?'+new URLSearchParams({q:'认证',scope:'all',knowledge_cursor:stale}));
 assert.equal(again.status,200,'not an error page');
 assert.ok(again.body.includes('<p class="notice" role="status">知识或分享范围在翻页期间有变化，已从第一页重新搜索。</p>'));
 for(let n=1;n<=3;n++)assert.ok(again.body.includes(`第 ${n} 条`),'the first page of results is shown');
 assert.ok(!again.body.includes('分页游标与当前空间'));
 // A scope that is not one is still refused: only the page link is forgiven.
 assert.notEqual((await client.get('/console/search?'+new URLSearchParams({q:'认证',scope:'nowhere'}))).status,200);
});

test('the statistics tab has a heading between the page title and its figures',async t=>{
 const hub=await createTestHub({repositoryPacks:false,stubs:false,requireOsIsolation:false});t.after(()=>hub.close());
 const owner=await hub.createUser('合成记录读者'),client=await openConsole(hub,owner.token);
 const reply=await client.get('/console/records?tab=stats');assert.equal(reply.status,200);
 const levels=[...reply.body.matchAll(/<h([1-6])\b/g)].map(match=>Number(match[1]));
 assert.ok(levels.length>0);
 // accessibility, headings: no level is skipped on the way down.
 for(let i=1;i<levels.length;i++)assert.ok(levels[i]<=levels[i-1]+1,`h${levels[i-1]} is followed by h${levels[i]}`);
});

test('every table says what it lists: its section\'s title, or the page\'s, as the name of its scroll region and as a caption',async t=>{
 const hub=await createTestHub({repositoryPacks:false,stubs:false,requireOsIsolation:false});t.after(()=>hub.close());
 const admin=await hub.createUser('合成管理员','admin'),member=await hub.createUser('合成成员'),client=await openConsole(hub,admin.token);
 const spaces=hub.hub.knowledge.spaces!;await spaces.ensure(member.principal,member.user.id);
 await spaces.write(member.principal,{path:'/方法',kind:'observation',statement:'合成条目：表格要有名字'});
 let tables=0;
 const own=await openConsole(hub,member.token);
 // The member's own folder is read as the member: an administrator has no way into a personal space.
 for(const [reader,path] of [[client,'/console/team'],[client,'/console/records'],[client,'/console/connections'],[own,'/console/knowledge/space?'+new URLSearchParams({space:member.user.id,path:'/方法',scope:'personal'})]] as const){
  const reply=await reader.get(path);assert.equal(reply.status,200,path);
  // accessibility, tables: no table is left with the generic name.
  assert.ok(!reply.body.includes('aria-label="表格"'),path);
  for(const match of reply.body.matchAll(/<div class="ch-table-wrap" tabindex="0" role="region" aria-label="([^"]*)"><table class="ch-table"(?: data-view="[^"]*")?>(<caption class="ch-visually-hidden">([^<]*)<\/caption>)?/g)){
   tables++;
   assert.ok(match[1].trim().length>0,`${path}: the scroll region has a name`);
   assert.equal(match[3],match[1],`${path}: the caption says the same as the region`);
  }
 }
 assert.ok(tables>=2,`tables were checked (${tables})`);
});

