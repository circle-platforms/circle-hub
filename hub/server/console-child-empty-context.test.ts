import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createTestHub} from './testing-real.ts';
import {openConsole} from '../../tests/acceptance/support/console.ts';
import {href as rawHref} from './console/html.ts';
const href=(...args:Parameters<typeof rawHref>)=>rawHref(...args).replaceAll('&','&amp;');
const options={repositoryPacks:false,stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false};

test('nonempty parents retain their knowledge while empty child entries name their exact readable path',async t=>{
 const hub=await createTestHub(options);t.after(()=>hub.close());const owner=await hub.createUser('合成文件夹作者'),reader=await hub.createUser('合成文件夹读者'),spaces=hub.hub.knowledge.spaces!;
 for(const path of ['/认证','/认证/会话','/认证/接口','/隐藏目录'])await spaces.directory(owner.principal,path);
 await spaces.write(owner.principal,{path:'/认证',kind:'observation',statement:'合成认证知识仍在父文件夹',grounds:[]});await spaces.grant(owner.principal,{path:'/认证',audience:'member',member:reader.user.id});const version=(await spaces.current(owner.user.id))!,sessions=new Map([[owner.user.id,await openConsole(hub,owner.token)],[reader.user.id,await openConsole(hub,reader.token)]]),watermark=await hub.records.store.watermark!();
 for(const [member,scope] of [[owner,'personal'],[reader,'shared']] as const){
  const browser=sessions.get(member.user.id)!,response=await browser.get('/console/knowledge/space?'+new URLSearchParams({space:owner.user.id,root:version.root,path:'/认证',scope}));assert.equal(response.status,200,response.body);const tail=response.body.slice(response.body.indexOf('data-view="knowledge-directory"'));let depth=1,end=0;for(const tag of tail.matchAll(/<\/?section\b[^>]*>/g)){depth+=tag[0].startsWith('</')?-1:1;if(depth===0){end=tag.index!+tag[0].length;break;}}assert.ok(end);const directory=tail.slice(0,end);assert.match(directory,/合成认证知识仍在父文件夹/);assert.equal((directory.match(/data-empty-child/g)??[]).length,2);assert.doesNotMatch(directory,/ch-empty-title|这个文件夹还没有知识|每条知识都附带来源/);assert.ok(directory.indexOf('合成认证知识仍在父文件夹')<directory.indexOf('data-empty-child'));
  for(const path of ['/认证/会话','/认证/接口'])assert.ok(directory.includes(href('/console/knowledge/space',{space:owner.user.id,root:version.root,path,scope})));
  if(member===reader){assert.doesNotMatch(response.body,/隐藏目录/);assert.doesNotMatch(directory,/新建知识|name="selected_entry"/);}
  const child=await browser.get('/console/knowledge/space?'+new URLSearchParams({space:owner.user.id,root:version.root,path:'/认证/会话',scope}));assert.equal(child.status,200,child.body);assert.match(child.body,/<p class="ch-empty-title">认证 › 会话 中还没有知识<\/p>/);assert.doesNotMatch(child.body,/data-empty-child|这个文件夹还没有知识/);
  if(member===owner){assert.ok(child.body.includes(href('/console/knowledge/space',{space:owner.user.id,root:version.root,path:'/认证/会话',scope,edit:'1'})));assert.match(child.body,/没有来源的笔记记为待验证/);}
  else assert.doesNotMatch(child.body,/在此新建知识/);
 }
 assert.equal(await hub.records.store.watermark!(),watermark);
});

test('a team child remains readable to members without a private new-entry action',async t=>{
 const hub=await createTestHub(options);t.after(()=>hub.close());const reader=await hub.createUser('合成团队空目录读者'),spaces=hub.hub.knowledge.spaces!;await spaces.directory(hub.admin.principal,'/合成团队/空子目录','team');const root=(await spaces.current('team'))!.root,browser=await openConsole(hub,reader.token),response=await browser.get('/console/knowledge/space?'+new URLSearchParams({space:'team',root,path:'/合成团队/空子目录',scope:'team'}));assert.equal(response.status,200,response.body);assert.match(response.body,/合成团队 › 空子目录 中还没有知识/);assert.doesNotMatch(response.body,/在此新建知识|name="selected_entry"/);
});

test('empty root titles are explicit and root-selected child links keep snapshot and scope',async t=>{
 const hub=await createTestHub(options);t.after(()=>hub.close());const owner=await hub.createUser('合成根目录作者'),spaces=hub.hub.knowledge.spaces!;await spaces.directory(owner.principal,'/空子文件夹');const root=(await spaces.current(owner.user.id))!.root,browser=await openConsole(hub,owner.token),response=await browser.get('/console/knowledge/space?'+new URLSearchParams({space:owner.user.id,root,path:'/',scope:'personal'}));assert.equal(response.status,200);assert.match(response.body,/<p class="ch-empty-title">根文件夹 中还没有知识<\/p>/);assert.match(response.body,/空子文件夹<\/a> · 此子文件夹暂无知识/);assert.ok(response.body.includes(href('/console/knowledge/space',{space:owner.user.id,root,path:'/空子文件夹',scope:'personal'})));
});
