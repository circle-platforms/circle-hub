// What the audit of the console against the modern-web-guidance guides found and fixed (2026-11-12): the checks here keep
// those fixes. Each names the guide its rule comes from. Synthetic data only.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createTestHub} from './testing-real.ts';
import {openConsole} from '../../tests/acceptance/support/console.ts';
import {request as httpRequest} from 'node:http';
import {brotliDecompressSync,gunzipSync} from 'node:zlib';
import {CSS} from './console/style.ts';
import {CONSOLE_CSS,CONSOLE_LIVE,CONSOLE_THEME,assetCoding} from './console/assets.ts';
import {pre} from './console/html.ts';
import {commandModal} from './console/presentation.ts';
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


// The items the owner approved on 2026-11-12 (they change what a reader sees or what the server sends).

test('a trail is an ordered list of links: the places above, then the page itself as the current one',async t=>{
 const hub=await createTestHub({repositoryPacks:false,stubs:false,requireOsIsolation:false});t.after(()=>hub.close());
 const member=await hub.createUser('合成成员'),client=await openConsole(hub,member.token);
 const spaces=hub.hub.knowledge.spaces!;await spaces.ensure(member.principal,member.user.id);
 await spaces.write(member.principal,{path:'/方法/步骤',kind:'observation',statement:'合成条目：路径要说全'});
 const reply=await client.get('/console/knowledge/space?'+new URLSearchParams({space:member.user.id,path:'/方法/步骤',scope:'personal'}));assert.equal(reply.status,200);
 const nav=/<nav class="ch-crumbs" aria-label="位置"><ol>(.*?)<\/ol><\/nav>/.exec(reply.body);assert.ok(nav,'breadcrumbs: an ordered list inside a named navigation landmark');
 const items=[...nav[1].matchAll(/<li><a href="([^"]*)"( aria-current="page")?>(.*?)<\/a><\/li>/g)];
 assert.equal(items.map(item=>item[0]).join(''),nav[1],'every item is a link and nothing stands between the items');
 assert.deepEqual(items.map(item=>item[3].replace(/<[^>]*>/g,'')),['知识库','我的','方法','步骤']);
 // The last item is the page: a link to itself, the only one marked current; the places above lead elsewhere.
 assert.deepEqual(items.map(item=>item[2]!==undefined),[false,false,false,true]);
 assert.equal(items.at(-1)![1],'');for(const item of items.slice(0,-1))assert.match(item[1],/^\/console\/knowledge/);
 // No separator is written into the text a screen reader reads: the style sheet draws it; the current page is told apart
 // by its weight as well as its colour, and by an underline where colours are forced.
 assert.doesNotMatch(nav[1],/›/);
 for(const rule of ['.ch-crumbs li + li::before { content: "›"; content: "›" / ""; margin-right: 6px; }','.ch-crumbs a[aria-current="page"] { color: var(--text-secondary); font-weight: 500; text-decoration: none; }','@media (forced-colors: active) { .ch-crumbs a[aria-current="page"] { text-decoration: underline; } }'])assert.ok(CSS.includes(rule),rule);
 // A page of a place itself has no trail: its title is the place.
 assert.doesNotMatch((await client.get('/console/runs')).body,/class="ch-crumbs" aria-label="位置"/);
});

test('the folder tree is nested lists of links: no folder is a disclosure and no link sits inside a summary',async t=>{
 const hub=await createTestHub({repositoryPacks:false,stubs:false,requireOsIsolation:false});t.after(()=>hub.close());
 const member=await hub.createUser('合成成员'),client=await openConsole(hub,member.token);
 const spaces=hub.hub.knowledge.spaces!;await spaces.ensure(member.principal,member.user.id);
 await spaces.write(member.principal,{path:'/方法/步骤',kind:'observation',statement:'合成条目：树是列表'});
 const reply=await client.get('/console/knowledge?scope=personal');assert.equal(reply.status,200);
 const tree=/<div class="ch-nav-tree">(.*?)<\/div>/.exec(reply.body)?.[1];assert.ok(tree,'the tree of the selected scope');
 assert.match(tree,/^<ul><li><a href="[^"]+" title="方法">方法<\/a><ul><li><a href="[^"]+" title="步骤">步骤<\/a><\/li><\/ul><\/li>/);
 assert.doesNotMatch(tree,/<details|<summary/);
 for(const rule of ['.ch-nav-tree ul { margin: 0; padding: 0; list-style: none; min-width: 0; }','.ch-nav-tree ul ul { padding-left: var(--space-3); }'])assert.ok(CSS.includes(rule),rule);
});

test('a detail that stands alone carries the page title as a level-one heading, absent where the list shows its own',async t=>{
 const hub=await createTestHub({repositoryPacks:false,stubs:false,requireOsIsolation:false});t.after(()=>hub.close());
 const member=await hub.createUser('合成成员'),client=await openConsole(hub,member.token);
 const spaces=hub.hub.knowledge.spaces!;await spaces.ensure(member.principal,member.user.id);
 const written=await spaces.write(member.principal,{path:'/方法',kind:'observation',statement:'合成条目：详情要有标题'});
 const place={space:member.user.id,path:'/方法',scope:'personal'};
 const list=await client.get('/console/knowledge/space?'+new URLSearchParams(place));assert.equal(list.status,200);
 const entry=/[?&amp;]entry=([^"&]+)/.exec(list.body)?.[1];assert.ok(entry,JSON.stringify(Object.keys(written)));
 const detail=await client.get('/console/knowledge/space?'+new URLSearchParams({...place,entry:decodeURIComponent(entry)}));assert.equal(detail.status,200);
 assert.match(detail.body,/<div class="ch-app[^"]* is-detail"/);
 // accessibility, headings: one level-one heading in the list's pane and one for the pane that replaces it on a narrow screen.
 assert.match(detail.body,/<aside class="ch-inspector" aria-label="详情"><h1 class="ch-visually-hidden ch-detail-heading">方法<\/h1>/);
 assert.equal((detail.body.match(/<h1\b/g)??[]).length,2);
 // Only one of the two is ever rendered: this one is off wherever the list, and with it the page's own heading, is shown.
 assert.ok(CSS.includes('.ch-detail-heading { display: none; }\n@media (max-width: 1180px) { .ch-app.is-detail .ch-detail-heading { display: block; } }'));
 assert.ok(CSS.includes('.ch-app.is-detail > .ch-pane { display: none; }'),'the list is hidden at the same width');
 // A page without a selected thing has the one heading of its pane.
 assert.equal((list.body.match(/<h1\b/g)??[]).length,1);assert.doesNotMatch(list.body,/ch-detail-heading/);
});

test('on a touch screen whatever is pressed is at least 24px high and a field is 16px; with a mouse nothing changes',()=>{
 const coarse=/@media \(pointer: coarse\) \{\n((?:  .*\n)+)\}/.exec(CSS)?.[1];assert.ok(coarse,'accessibility, target size: one block for coarse pointers');
 for(const rule of [
  '> a:not(.ch-btn, .ch-row, .ch-nav-item), .hub .ch-table td a:not(.ch-btn) { padding-block: 4px; }',
  // A name of one or two characters is as wide as it is high.
  '.hub .ch-table td a:not(.ch-btn), .hub .ch-crumbs a { display: inline-block; min-width: 24px; }',
  '.hub .ch-source-head > a { min-height: 24px; align-content: center; }',
  '.hub summary { min-height: 24px; align-content: center; }',
  '.hub :is(input[type="checkbox"], input[type="radio"]) { min-width: 24px; min-height: 24px; }',
  '.hub :is(input:not([type="checkbox"], [type="radio"], [type="hidden"]), select, textarea) { min-height: 32px; }',
 ])assert.ok(coarse.includes(rule),rule);
 // forms: 16px keeps a phone from zooming the page in when a field is tapped; on a phone-width window too.
 assert.ok(CSS.includes('@media (pointer: coarse), (max-width: 760px) {\n  .hub :is(input:not([type="checkbox"], [type="radio"], [type="hidden"]), select, textarea) { font-size: 16px; }\n}'));
 // Outside these two blocks no rule of the audit touches a size: the dense rows of a mouse are as they were.
 const outside=CSS.slice(CSS.indexOf('/* accessibility, skip links')).replace(/@media \(pointer: coarse\)[^{]*\{\n(?:  .*\n)+\}/g,'');
 assert.doesNotMatch(outside,/padding-block: 4px|min-height: 24px|min-width: 24px|min-height: 32px|font-size: 16px/);
 // A scroll region holds the text kept for screen readers inside it, so a wide table never widens the page itself.
 assert.ok(CSS.includes('.ch-table-wrap { position: relative; }'));
});

test('output that is code or data is a code element inside its block, and keeps the block\'s size',()=>{
 // html, code blocks: a command to copy, a command's output and a JSON body are code; the element says so.
 assert.equal(pre('{"合成":1}').text,'<pre><code>{&quot;合成&quot;:1}</code></pre>');
 const modal=commandModal({id:'cmd-synthetic',title:'合成命令',text:'合成说明',command:'circle-hub status'}).text;
 assert.ok(modal.includes('<pre class="ch-quote"><code>circle-hub status</code></pre>'),modal);
 // Inline code is 12px and breaks anywhere; inside a block it takes the block's size and wrapping.
 assert.ok(CSS.includes(':where(.hub) pre code { font-size: inherit; overflow-wrap: inherit; }'));
});

test('the three assets are sent compressed to a client that takes it, each coding with its own validator; a page never is',async t=>{
 const hub=await createTestHub({repositoryPacks:false,stubs:false,requireOsIsolation:false});t.after(()=>hub.close());
 // fetch() would add its own Accept-Encoding and decode the answer, so the coded bytes are read with node:http.
 const raw=(path:string,headers:Record<string,string>={})=>new Promise<{status:number;headers:Record<string,string|string[]|undefined>;bytes:Buffer}>((resolve,reject)=>{
  const request=httpRequest({host:'127.0.0.1',port:hub.port,path,headers},response=>{const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode??0,headers:response.headers,bytes:Buffer.concat(chunks)}));});
  request.on('error',reject);request.end();
 });
 for(const value of [CONSOLE_CSS,CONSOLE_THEME,CONSOLE_LIVE]){
  const plain=await raw(value.path);assert.equal(plain.status,200);
  assert.equal(plain.headers['content-encoding'],undefined);assert.equal(plain.headers.vary,'Accept-Encoding');
  assert.equal(plain.bytes.toString('utf8'),value.body);assert.equal(plain.headers.etag,`"${value.integrity}"`);
  const br=await raw(value.path,{'accept-encoding':'gzip, deflate, br'});assert.equal(br.status,200);
  assert.equal(br.headers['content-encoding'],'br');assert.equal(br.headers.vary,'Accept-Encoding');
  assert.equal(br.headers['content-length'],String(br.bytes.length));assert.equal(br.headers['cache-control'],'public, max-age=31536000, immutable');
  assert.equal(brotliDecompressSync(br.bytes).toString('utf8'),value.body,'the integrity the page pins is over these decoded bytes');
  const gzip=await raw(value.path,{'accept-encoding':'gzip'});assert.equal(gzip.headers['content-encoding'],'gzip');
  assert.equal(gunzipSync(gzip.bytes).toString('utf8'),value.body);
  // Each coding is a representation of its own: three validators, and a conditional request matches only its own.
  assert.equal(new Set([plain.headers.etag,br.headers.etag,gzip.headers.etag]).size,3);
  assert.equal((await raw(value.path,{'accept-encoding':'br','if-none-match':String(br.headers.etag)})).status,304);
  assert.equal((await raw(value.path,{'accept-encoding':'br','if-none-match':String(gzip.headers.etag)})).status,200);
  // A coding the client refuses is not used.
  assert.equal((await raw(value.path,{'accept-encoding':'br;q=0, gzip;q=0'})).headers['content-encoding'],undefined);
  if(Buffer.byteLength(value.body)>10_000)assert.ok(br.bytes.length*3<Buffer.byteLength(value.body),'a third of the size or less');
 }
 // A page carries the form token of its session: it is sent as it is, whatever the client accepts.
 const member=await hub.createUser('合成成员'),client=await openConsole(hub,member.token);
 const page=await raw('/console/overview',{'accept-encoding':'gzip, deflate, br',cookie:`circle_hub_session=${client.sessionCookie}`});
 assert.equal(page.status,200);assert.equal(page.headers['content-encoding'],undefined);assert.match(page.bytes.toString('utf8'),/name="csrf" value="[^"]+"/);
});

test('an Accept-Encoding header picks the preferred coding the client names or covers, and none where it names none',()=>{
 assert.equal(assetCoding('gzip, deflate, br'),'br');assert.equal(assetCoding('gzip'),'gzip');assert.equal(assetCoding('*'),'br');
 assert.equal(assetCoding('br;q=0, *;q=0.1'),'gzip');assert.equal(assetCoding('gzip;q=0.5, br;q=0'),'gzip');
 assert.equal(assetCoding(undefined),null);assert.equal(assetCoding(''),null);assert.equal(assetCoding('identity'),null);assert.equal(assetCoding('br;q=abc'),null);
 assert.equal(assetCoding(['deflate','BR ; q=0.8']),'br');
});
