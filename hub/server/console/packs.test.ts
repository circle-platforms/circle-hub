// Cards distinguish namespace ownership from grants and team assignment presentation.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {packsPage,packPage} from './packs.ts';
import type {PageContext} from './pages.ts';

const detailContext=(kind:string,checks:unknown[]=[])=>{
 const principal={id:'reader',name:'合成成员',role:'user'};
 const pack={id:'synthetic-detail',kind,version:'1.0.0',title:'合成详情',owner:'admin',withdrawn:false,digest:'a'.repeat(64),samples:{},published_at:'2026-11-02T00:00:00.000Z'};
 return {principal,admin:false,url:new URL('http://127.0.0.1/console/packs/'+pack.id),userName:async(id:string)=>id,chrome:(title:string,options:Record<string,unknown>)=>({title,...options,user:{name:principal.name,role:'成员',admin:false}}),deps:{packs:{list:async()=>[pack]},workflows:{byDigest:async()=>({requirements:[],checks})}}} as unknown as PageContext;
};

test('check descriptors display the module and selected export instead of an object coercion',async()=>{
 const ctx=detailContext('workflow',[
  {id:'first',title:'默认导出',function:{module:'functions/check.ts'},judges:'target'},
  {id:'second',title:'具名导出',function:{module:'functions/named.ts',export:'verify'},judges:'target'},
  {id:'third',title:'解释器',interpreter:'structure@1',judges:'target'},
 ]);
 const body=String((await packPage(ctx,'synthetic-detail')).body);
 assert.doesNotMatch(body,/\[object Object\]/);
 assert.match(body,/functions\/check\.ts/);assert.match(body,/default/);
 assert.match(body,/functions\/named\.ts/);assert.match(body,/verify/);assert.match(body,/structure@1/);
 const unsafe=detailContext('workflow',[{id:'escaped',function:{module:'functions/<script>.ts',export:'<unsafe>'},judges:'target'}]);
 const escaped=String((await packPage(unsafe,'synthetic-detail')).body);
 assert.ok(escaped.includes('functions/&lt;script&gt;.ts'));assert.ok(escaped.includes('&lt;unsafe&gt;'));
});

test('breadcrumbs keep distinct classifications without repeating the workflow area',async()=>{
 for(const [kind,labels] of [['workflow',['工作流','合成详情']],['skill',['工作流','通用技能','合成详情']],['product',['知识库','产品知识来源','合成详情']],['system',['连接','业务系统接入','合成详情']]] as const){
  const ctx=detailContext(kind);let crumbs='';ctx.chrome=(title,options)=>{crumbs=String(options?.crumbs??'');return {title,user:null,csrf:null};};
  await packPage(ctx,'synthetic-detail');
  assert.deepEqual(crumbs.split(' › ').map(part=>part.replace(/<[^>]*>/g,'')),labels);
 }
});

test('received skills stay in their own group and team scopes disclose assignments only to administrators',async()=>{
 let assignments=['owner'];
 const users=[{id:'owner',name:'合成作者',role:'user'},{id:'peer',name:'合成协作者',role:'user'},{id:'admin',name:'合成管理员',role:'admin'},{id:'disabled',name:'合成停用成员',role:'user',disabled:true}];
 const base={version:'1.0.0',withdrawn:false,digest:'a'.repeat(64),samples:{},published_at:'2026-11-02T10:41:34.891Z'};
 const listings=[{...base,id:'synthetic-team',kind:'workflow',title:'合成团队工作流',owner:'admin'},{...base,id:'synthetic-shared',kind:'skill',title:'合成受权技能',space:'peer',owner:'peer'}];
 const ctx={principal:users[0],url:new URL('http://127.0.0.1/console/packs'),userName:async(id:string)=>users.find(user=>user.id===id)?.name??'—',chrome:(title:string)=>({title,user:{name:'合成作者',role:'成员',admin:false}}),deps:{packs:{list:async()=>listings},records:{principals:{list:async()=>users},authorizations:{canPublish:async()=>false,usersOf:async()=>assignments}}}} as unknown as PageContext;
 const render=async()=>String((await packsPage(ctx)).body);
 const body=await render();
 assert.match(body,/<section[^>]+id="shared-skill"[^>]*>[\s\S]*?合成受权技能/);
 assert.doesNotMatch(/<section[^>]+id="personal-skill"[^>]*>([\s\S]*?)<\/section>/.exec(body)?.[1]??'',/合成受权技能/);
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
