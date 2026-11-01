import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServerDeps } from './api.ts';
import { knowledgePage, runsPage, type PageContext } from './console/pages.ts';
const member = {id:'usr_01arzte2b0dy6pj8cd4avj118p',name:'合成成员',role:'user' as const};
function context(deps: unknown, admin = false): PageContext {
  return {deps:deps as ServerDeps,principal:admin ? {...member,role:'admin'} : member,admin,url:new URL('http://127.0.0.1/console/knowledge'),userName:async()=>member.name,chrome:(title,extra)=>({title,...extra,user:{name:member.name,role:'用户',admin},csrf:null})};
}
const products = {products:async()=>[],readableProducts:async()=>new Set<string>()};
test('knowledge intake pending items live only in knowledge and an empty list is hidden', async () => {
  const todo = {source:{system:'synthetic',id:'source-1'},missing:'合成缺失内容',next_action:'补充出处',detail:{message:'合成脚本错误'}};
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
