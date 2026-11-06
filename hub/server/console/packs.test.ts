// Cards distinguish namespace ownership from grants and team assignment presentation.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {packsPage,skillsPage,packPage} from './packs.ts';
import type {PageContext} from './pages.ts';

test('received skills stay in their own group and team scopes disclose assignments only to administrators',async()=>{
 let assignments=['owner'];
 const users=[{id:'owner',name:'合成作者',role:'user'},{id:'peer',name:'合成协作者',role:'user'},{id:'admin',name:'合成管理员',role:'admin'},{id:'disabled',name:'合成停用成员',role:'user',disabled:true}];
 const base={version:'1.0.0',withdrawn:false,digest:'a'.repeat(64),samples:{},published_at:'2026-11-02T10:41:34.891Z'};
 const listings=[{...base,id:'synthetic-team',kind:'workflow',title:'合成团队工作流',owner:'admin'},{...base,id:'synthetic-shared',kind:'skill',title:'合成受权技能',space:'peer',owner:'peer'}];
 const ctx={principal:users[0],url:new URL('http://127.0.0.1/console/packs'),userName:async(id:string)=>users.find(user=>user.id===id)?.name??'—',chrome:(title:string)=>({title,user:{name:'合成作者',role:'成员',admin:false}}),deps:{packs:{list:async()=>listings},records:{principals:{list:async()=>users},authorizations:{canPublish:async()=>false,usersOf:async()=>assignments}}}} as unknown as PageContext;
 const render=async()=>String((await packsPage(ctx)).body);
 const body=await render();
 const skillBody=String((await skillsPage({...ctx,url:new URL('http://127.0.0.1/console/skills')} as never)).body);
 assert.match(skillBody,/<section[^>]+id="shared-skill"[^>]*>[\s\S]*?合成受权技能/);
 assert.doesNotMatch(/<section[^>]+id="personal-skill"[^>]*>([\s\S]*?)<\/section>/.exec(skillBody)?.[1]??'',/合成受权技能/);
 assert.doesNotMatch(body,/合成受权技能/);
 assert.match(body,/使用范围：团队/);assert.doesNotMatch(body,/使用范围：合成作者|使用范围：本人及全体管理员/);
 ctx.admin=true;ctx.principal={...ctx.principal,role:'admin'};
 assert.match(await render(),/使用范围：合成作者/);
 assignments=[];assert.match(await render(),/使用范围：尚未指定成员/);
 assignments=['owner','peer','disabled'];const all=await render();assert.match(all,/使用范围：合成作者、合成协作者/);assert.doesNotMatch(all,/使用范围：[^<]*合成停用成员/);
});

test('member team scopes reveal neither assignment counts nor member names on cards or detail pages',async()=>{
 const principal={id:'reader',name:'合成阅读成员',role:'user'},hidden=['synthetic-private-one','synthetic-private-two'];
 let assigned:string[]=[];
 const pack={id:'synthetic-team-scope',space:'team',kind:'workflow',version:'1.0.0',title:'合成团队工作流',owner:'admin',withdrawn:false,digest:'a'.repeat(64),samples:{},published_at:'2026-11-02T00:00:00.000Z'};
 const ctx={principal,admin:false,url:new URL('http://127.0.0.1/console/packs?scope=team'),userName:async(id:string)=>{assert.ok(!hidden.includes(id),'member rendering must not resolve assignment names');return id==='admin'?'合成管理员':principal.name;},chrome:(title:string)=>({title,user:{name:principal.name,role:'成员',admin:false}}),deps:{packs:{list:async()=>[{...pack,assigned_to:assigned}]},workflows:{byDigest:async()=>null},records:{principals:{list:async()=>[principal,{id:'admin',name:'合成管理员',role:'admin'}]},authorizations:{canPublish:async()=>false,usersOf:async()=>{assert.fail('member rendering must not query assignments');}}}}} as unknown as PageContext;
 for(const ids of [[],hidden.slice(0,1),hidden]){
  assigned=ids;const cards=String((await packsPage(ctx)).body);
  assert.deepEqual([...cards.matchAll(/使用范围：([^<]*)/g)].map(match=>match[1]),['团队']);
  const detail=String((await packPage(ctx,pack.id)).body);
  for(const body of [cards,detail]){assert.doesNotMatch(body,/使用范围：[^<]*(?:\d|名成员|尚未指定成员)/);for(const id of hidden)assert.ok(!body.includes(id));}
 }
});

test('a skill says what it offers and who uses it, and a workflow lists what it is made of (T01 R[6])',async()=>{
 const base={version:'1.0.0',withdrawn:false,digest:'a'.repeat(64),samples:{},published_at:'2026-11-06T10:41:34.891Z',owner:'admin',active:false};
 const listings=[{...base,id:'format',kind:'skill',title:'合成格式'},{...base,id:'other',kind:'skill',title:'没人用的技能'},{...base,id:'work',kind:'workflow',title:'合成工作流',embeds:[{pack:'format',version:'1.0.0',module:'reader'}],dependencies:[{pack:'parser'}]}];
 const users=[{id:'admin',name:'合成管理员',role:'admin'}];
 const workflow={manifest:{},requirements:[],checks:[],workflow:{inputs:[{slot:'subject',accepts:['agile:mindmap','application/json']},{slot:'contract',accepts:['doc:doc']},{slot:'index',accepts:['knowledge:index']}],product:{catalogs:['commands@1']}}};
 const ctx=(path:string)=>({principal:users[0],admin:false,url:new URL('http://127.0.0.1'+path),userName:async()=>'合成管理员',chrome:(title:string)=>({title,user:{name:'合成管理员',role:'管理员',admin:false}}),deps:{packs:{list:async()=>listings,skillDeclaration:async(id:string)=>id==='format'?{parsers:1,modules:[{id:'reader',title:'合成读取',family:'合成格式的文件'}]}:{parsers:0,modules:[]}},workflows:{byDigest:async()=>workflow},records:{authorizations:{canPublish:async()=>false,usersOf:async()=>[]},principals:{list:async()=>users,get:async()=>users[0]}}}});
 const list=String((await skillsPage(ctx('/console/skills') as never)).body);
 assert.match(list,/合成格式/);assert.match(list,/1 个模块 · 1 个解析器 · 1 个工作流在用/);assert.match(list,/没人用的技能/);assert.match(list,/0 个工作流在用/);assert.doesNotMatch(list,/合成工作流/);
 const skill=String((await packPage(ctx('/console/packs/format') as never,'format')).body);
 assert.match(skill,/合成读取/);assert.match(skill,/合成格式的文件/);assert.match(skill,/href="\/console\/packs\/work"/);assert.match(skill,/内嵌模块/);
 const work=String((await packPage(ctx('/console/packs/work') as never,'work')).body);
 assert.match(work,/组成/);assert.match(work,/内嵌 1\.0\.0/);assert.match(work,/agile:mindmap/);assert.match(work,/commands@1/);assert.match(work,/knowledge:index/);assert.match(work,/>contract</);assert.doesNotMatch(work,/application\/json<\/code>/);
});
