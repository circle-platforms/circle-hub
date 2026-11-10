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
 // The scripts of the checks are technical values: they stand on the last tab.
 assert.doesNotMatch(String((await packPage(ctx,'synthetic-detail')).body),/functions\/check\.ts/);
 ctx.url=new URL(ctx.url.href+'?tab=technical');
 const body=String((await packPage(ctx,'synthetic-detail')).body);
 assert.doesNotMatch(body,/\[object Object\]/);
 assert.match(body,/functions\/check\.ts/);assert.match(body,/default/);
 assert.match(body,/functions\/named\.ts/);assert.match(body,/verify/);assert.match(body,/structure@1/);
 const unsafe=detailContext('workflow',[{id:'escaped',function:{module:'functions/<script>.ts',export:'<unsafe>'},judges:'target'}]);unsafe.url=new URL(unsafe.url.href+'?tab=technical');
 const escaped=String((await packPage(unsafe,'synthetic-detail')).body);
 assert.ok(escaped.includes('functions/&lt;script&gt;.ts'));assert.ok(escaped.includes('&lt;unsafe&gt;'));
});

test('breadcrumbs keep distinct classifications without repeating the area a place already names',async()=>{
 for(const [kind,labels] of [['workflow',['工作流','合成详情']],['skill',['技能','合成详情']],['product',['知识库','产品知识来源','合成详情']],['system',['连接','业务系统接入','合成详情']]] as const){
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
 const render=async(kind:'workflow'|'skill'='workflow')=>String((await packsPage(ctx,kind)).body);
 const body=await render(),skills=await render('skill');
 // One table per place: the row of a skill someone shared says so, and is not counted as the reader's own.
 const rowOf=(body:string,title:string)=>[...body.matchAll(/<tr[\s\S]*?<\/tr>/g)].find(match=>match[0].includes(title))?.[0]??'';
 assert.match(rowOf(skills,'合成受权技能'),/data-pack-scope="shared"/);assert.doesNotMatch(skills,/data-pack-scope="personal"/);
 assert.match(rowOf(body,'合成团队工作流'),/data-pack-scope="team"/);
 // Decision 151: each place lists its own kind only, and a skill's row links into the skills place.
 assert.ok(!body.includes('合成受权技能'));assert.ok(!skills.includes('合成团队工作流'));
 assert.match(skills,/href="\/console\/skills\/synthetic-shared\?/);assert.match(body,/href="\/console\/packs\/synthetic-team\?/);
 const audience=(body:string)=>[...body.matchAll(/<span data-pack-audience>([^<]*)<\/span>/g)].map(match=>match[1]);
 assert.deepEqual(audience(body),['团队']);
 ctx.admin=true;ctx.principal={...ctx.principal,role:'admin'};
 assert.deepEqual(audience(await render()),['合成作者']);
 assignments=[];assert.deepEqual(audience(await render()),['尚未指定成员']);
 assignments=['owner','peer','disabled'];assert.deepEqual(audience(await render()),['合成作者、合成协作者'],'a disabled member is not named');
});

test('workflow and skill details retain the scope counts of their own place without including the other kinds',async()=>{
 const principal={id:'reader',name:'合成成员',role:'user'},base={version:'1.0.0',owner:'admin',withdrawn:false,digest:'a'.repeat(64),samples:{},published_at:'2026-11-02T00:00:00.000Z'};
 const listings=[{...base,id:'workflow-one',title:'合成工作流',kind:'workflow'},{...base,id:'workflow-two',title:'合成第二工作流',kind:'workflow'},{...base,id:'skill-one',title:'合成技能',kind:'skill'},{...base,id:'skill-one',title:'合成旧技能',kind:'skill',version:'0.9.0',withdrawn:true},{...base,id:'system-one',title:'合成系统',kind:'system'},{...base,id:'product-one',title:'合成产品',kind:'product'}];
 const ctx={principal,admin:false,url:new URL('http://127.0.0.1/console/packs?scope=all'),userName:async()=>principal.name,chrome:(title:string,extra:object)=>({title,...extra,csrf:null,user:{name:principal.name,role:'成员',admin:false}}),deps:{packs:{list:async()=>listings},workflows:{byDigest:async()=>null},records:{authorizations:{canPublish:async()=>false}}}} as unknown as PageContext;
 // The counts of the scopes beside the navigation; a pack's own page also counts its tabs, which are not these.
 const counts=(body:string)=>[...body.matchAll(/<a href="\/console\/(?:packs|skills)\?scope=\w+"(?: aria-current="page")?>[^<]*<span class="ch-count">([^<]+)<\/span><\/a>/g)].map(match=>match[1]);
 // All, mine, team: two workflows in one place, one skill (two versions of it) in the other.
 const workflows=String((await packsPage(ctx)).body);assert.deepEqual(counts(workflows),['2','0','2']);
 ctx.url=new URL('http://127.0.0.1/console/skills?scope=all');
 const skills=String((await packsPage(ctx,'skill')).body);assert.deepEqual(counts(skills),['1','0','1']);
 assert.match(workflows,/href="\/console\/packs\?scope=team"/);assert.match(skills,/href="\/console\/skills\?scope=team"/);
 for(const [path,list,own,other] of [['/console/packs/workflow-one',workflows,/合成工作流/,/合成技能/],['/console/skills/skill-one',skills,/合成技能/,/合成工作流/]] as const){
  ctx.url=new URL('http://127.0.0.1'+path+'?scope=all');const detail=String((await packPage(ctx,path.split('/').at(-1)!)).body);
  assert.deepEqual(counts(detail),counts(list),path);assert.match(detail,own);assert.doesNotMatch(detail,other);assert.doesNotMatch(detail,/合成系统|合成产品/);
 }
});

test('member team scopes reveal neither assignment counts nor member names on cards or detail pages',async()=>{
 const principal={id:'reader',name:'合成阅读成员',role:'user'},hidden=['synthetic-private-one','synthetic-private-two'];
 let assigned:string[]=[];
 const pack={id:'synthetic-team-scope',space:'team',kind:'workflow',version:'1.0.0',title:'合成团队工作流',owner:'admin',withdrawn:false,digest:'a'.repeat(64),samples:{},published_at:'2026-11-02T00:00:00.000Z'};
 const ctx={principal,admin:false,url:new URL('http://127.0.0.1/console/packs?scope=team'),userName:async(id:string)=>{assert.ok(!hidden.includes(id),'member rendering must not resolve assignment names');return id==='admin'?'合成管理员':principal.name;},chrome:(title:string)=>({title,user:{name:principal.name,role:'成员',admin:false}}),deps:{packs:{list:async()=>[{...pack,assigned_to:assigned}]},workflows:{byDigest:async()=>null},records:{principals:{list:async()=>[principal,{id:'admin',name:'合成管理员',role:'admin'}]},authorizations:{canPublish:async()=>false,usersOf:async()=>{assert.fail('member rendering must not query assignments');}}}}} as unknown as PageContext;
 for(const ids of [[],hidden.slice(0,1),hidden]){
  assigned=ids;const cards=String((await packsPage(ctx)).body);
  assert.deepEqual([...cards.matchAll(/<span data-pack-audience>([^<]*)<\/span>/g)].map(match=>match[1]),['团队']);
  const detail=String((await packPage(ctx,pack.id)).body);
  assert.deepEqual([...detail.matchAll(/使用范围：([^<]*)/g)].map(match=>match[1]),['团队']);
  for(const body of [cards,detail]){assert.doesNotMatch(body,/名成员|尚未指定成员/);for(const id of hidden)assert.ok(!body.includes(id));}
 }
});
