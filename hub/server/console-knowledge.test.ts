import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServerDeps } from './api.ts';
import { knowledgePage, runsPage, type PageContext, productSourcesPage } from './console/pages.ts';
const member = {id:'usr_01arzte2b0dy6pj8cd4avj118p',name:'合成成员',role:'user' as const};
function context(deps: unknown, admin = false): PageContext {
  return {deps:{records:{},packs:{list:async()=>[]},...deps as object} as unknown as ServerDeps,principal:admin ? {...member,role:'admin'} : member,admin,url:new URL('http://127.0.0.1/console/knowledge'),userName:async()=>member.name,chrome:(title,extra)=>({title,...extra,user:{name:member.name,role:'用户',admin},csrf:null})};
}
const products = {products:async()=>[],readableProducts:async()=>new Set<string>()};
test('knowledge removes the retired intake flow card and keeps explanations on the page heading',async()=>{
 const body=String((await knowledgePage(context({products,knowledge:{}}))).body);
 assert.doesNotMatch(body,/知识入库流程|class="knowledge-flow"/);assert.match(body,/title="统一的知识库/);
});
test('knowledge intake pending items live only in knowledge and an empty list is hidden', async () => {
  const todo = {source:{system:'synthetic',id:'source-1'},missing:'合成缺失内容',next_action:'补充来源',detail:{message:'合成脚本错误'}};
  let reader: unknown;
  const deps = {products,knowledge:{feeding:{todos:async(by:unknown)=>{reader=by;return [todo];}}},runs:{listRuns:async()=>({items:[],next:null})}};
  const ctx=context(deps);
  const body=String((await knowledgePage(ctx)).body);
  assert.equal(reader,ctx.principal);
  assert.match(body,/知识入库待处理/);
  for(const text of ['来源','待补充内容','后续处理','检查脚本出错详情',todo.missing,todo.next_action,todo.detail.message]) assert.ok(body.includes(text),text);
  assert.doesNotMatch(String((await runsPage(ctx)).body),/知识入库待处理|知识喂入|合成缺失内容/);
  assert.doesNotMatch(String((await knowledgePage(context({products,knowledge:{}}))).body),/知识入库待处理/);
});
test('knowledge empty states reflect the reader and import remains an administrator action with a hover explanation', async () => {
  const deps={products,knowledge:{}};
  const memberBody=String((await knowledgePage(context(deps))).body);
  const adminBody=String((await knowledgePage(context(deps,true))).body);
  assert.match(memberBody,/没有可读的团队知识；成员可读分配给自己的工作流所绑定的产品线/);
  assert.match(adminBody,/还没有团队知识；团队知识按产品线组织，发布产品知识来源后可在此浏览和导入/);
  for(const body of [memberBody,adminBody]) assert.doesNotMatch(body,/按产品线浏览|版本差异|name="from"|name="to"/);
  assert.doesNotMatch(memberBody,/导入团队知识<\/a>/);
  assert.match(adminBody,/title="从产品知识来源声明的来源导入到团队知识库；产品文件夹沿用产品线读权，仅管理员可用"/);
});
test('version comparison offers only the product line builds and defaults to previous and current produced roots', async () => {
  const current='a'.repeat(64),previous='b'.repeat(64),foreign='c'.repeat(64);
  const deps={products:{products:async()=>[{product:{id:'synthetic',title:'合成产品',names:[]}}]},knowledge:{builds:async()=>[
    {name:'build-3',line:'3',root:current,family:'synthetic',released_at:null},
    {name:'build-2',line:'2',root:previous,family:'synthetic',released_at:null},
    {name:'build-1',line:'1',root:null,family:'synthetic',released_at:null},
  ],currentRoot:async()=>null}};
  const body=String((await knowledgePage(context(deps,true))).body);
  assert.match(body,/<select name="from">/);
  assert.match(body,/<select name="to">/);
  assert.doesNotMatch(body,/<input name="from"|<input name="to"/);
  const from=/<select name="from">([\s\S]*?)<\/select>/.exec(body)![1];
  const to=/<select name="to">([\s\S]*?)<\/select>/.exec(body)![1];
  assert.ok(from.includes(`value="${previous}" selected`));
  assert.ok(to.includes(`value="${current}" selected`));
  assert.ok(!body.includes(foreign));
  assert.doesNotMatch(from,/build-1/);
});
test('different versions remain selectable when their knowledge content is identical', async () => {
  const root='d'.repeat(64);
  const deps={products:{products:async()=>[{product:{id:'synthetic',title:'合成产品',names:[]}}]},knowledge:{builds:async()=>[
    {name:'current-build',line:'3',root,family:'synthetic',released_at:null},
    {name:'previous-build',line:'2',root,family:'synthetic',released_at:null},
  ],currentRoot:async()=>null}};
  const body=String((await knowledgePage(context(deps,true))).body);
  const from=/<select name="from">([\s\S]*?)<\/select>/.exec(body)![1];
  const to=/<select name="to">([\s\S]*?)<\/select>/.exec(body)![1];
  assert.match(from,/selected>2 \/ previous-build<\/option>/);
  assert.match(to,/selected>3 \/ current-build<\/option>/);
});

test('with knowledge spaces, as the real assembly always has, the product sources and the pending intake are the fourth tab of the place', async () => {
  const todo = {source:{system:'synthetic',id:'source-2'},missing:'合成待补充',next_action:'补充合成出处'};
  const spaces = {visible:async()=>[],recent:async()=>({items:[],total:0}),shareHistory:async()=>({items:[],next:null}),usage:async()=>({knowledge:0,memory:0,used:0,limit:1024 ** 3,remaining:1024 ** 3,over:0})};
  const deps = {products,knowledge:{spaces,feeding:{todos:async()=>[todo]}}};
  // Decision 151: the home is the list of entries. It leads to the sources by the fourth tab and no longer carries them.
  for (const scope of ['all','team','personal']) {
    const ctx = context(deps, true); ctx.url = new URL(`http://127.0.0.1/console/knowledge?scope=${scope}`);
    const body = String((await knowledgePage(ctx)).body);
    assert.doesNotMatch(body, /id="(?:live-)?product-sources"|知识入库待处理/, scope);
    assert.ok(body.includes(`<a href="/console/knowledge/products?scope=${scope}">产品知识来源</a>`), scope);
  }
  const ctx = context(deps, true); ctx.url = new URL('http://127.0.0.1/console/knowledge/products?scope=all');
  const body = String((await productSourcesPage(ctx)).body);
  assert.match(body, /id="live-product-sources"/); assert.match(body, /知识入库待处理/); assert.ok(body.includes(todo.missing));
  const tabs = /<nav class="ch-seg" aria-label="知识库内容">([\s\S]*?)<\/nav>/.exec(body)?.[1] ?? '';
  assert.deepEqual([...tabs.matchAll(/<a href="[^"]+"( aria-current="page")?>([^<]+)<\/a>/g)].map((match) => [match[2], !!match[1]]), [['知识', false], ['记忆', false], ['原文', false], ['产品知识来源', true]]);
  assert.doesNotMatch(body, /<aside class="ch-inspector"/);
});

test('the knowledge list shows the exact space-filtered count in its head, without uncertainty and without a side pane',async()=>{
 const spaces={visible:async()=>[],recent:async()=>({items:[],total:7}),shareHistory:async()=>({items:[],next:null}),usage:async()=>({knowledge:0,memory:0,used:0,limit:1024**3,remaining:1024**3,over:0})};
 const ctx=context({products,knowledge:{spaces}},true);ctx.url=new URL('http://127.0.0.1/console/knowledge?scope=personal');
 const body=String((await knowledgePage(ctx)).body);
 // Decision 151: the count stands in the head of the list it counts; no pane repeats it.
 assert.match(body,/<h2 class="ch-card-title">[\s\S]*?<\/h2><span class="ch-meta">7 条<\/span>/);
 assert.doesNotMatch(body,/<aside class="ch-inspector"/);
 assert.doesNotMatch(body,/至多|候选记录.*上限/);
});
