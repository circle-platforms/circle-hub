import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runRecord, accepted } from '../../contracts/src/fixtures.ts';
import type { ServerDeps } from './api.ts';
import { productPage, diffPage, runPage, runsPage, type PageContext } from './console/pages.ts';
const root='a'.repeat(64),other='b'.repeat(64);
function context(deps:unknown,url:string):PageContext{return{deps:deps as ServerDeps,principal:{id:runRecord.runner,name:'合成用户',role:'user'},admin:false,url:new URL(url,'http://127.0.0.1'),userName:async()=> '合成用户',chrome:title=>({title,user:{name:'合成用户',role:'用户',admin:false},csrf:null})};}
const products={products:async()=>[{product:{id:'demo',title:'合成产品',names:['Demo']}}],readableProducts:async()=>new Set(['demo'])};
function next(body:string):string {const href=/href="([^"]+)"[^>]*>下一页/.exec(body)?.[1];assert.ok(href,body.slice(-600));return href.replaceAll('&amp;','&');}
test('products page exposes the 501st build through a bounded cursor rather than truncating it',async()=>{
  const builds=Array.from({length:501},(_,i)=>({name:`rel_demo_10_6_${i}`,family:'Demo',line:'10.6',base:`rel_demo_10_6_${i}`,platform:null,built_at:null,released_at:null,root:null}));
  const deps={products,knowledge:{builds:async()=>builds}};
  const first=String((await productPage(context(deps,'/console/knowledge/product?id=demo'))).body);
  assert.ok(!first.includes('rel_demo_10_6_500'));
  const second=String((await productPage(context(deps,next(first)))).body);
  assert.ok(second.includes('rel_demo_10_6_500'));
  assert.ok(first.includes('分页')&&first.includes('501'));
});
test('diff cursor reaches every immutable path beyond 1000 and binds the requested roots',async()=>{
  const deps={products,knowledge:{rootInfo:async()=>[{product:'demo'}],diffRoots:async()=>({added:Array.from({length:1001},(_,i)=>`/synthetic/${i}`),removed:[],modified:[]})}};
  const first=String((await diffPage(context(deps,`/console/knowledge/diff?from=${root}&to=${other}`))).body);
  const second=String((await diffPage(context(deps,next(first)))).body);
  assert.ok(second.includes('/synthetic/1000'));
  assert.ok(!second.includes('>/synthetic/0</a>'));
  const swapped=new URL(next(first),'http://127.0.0.1');swapped.searchParams.set('from',other);swapped.searchParams.set('to',root);
  assert.equal((await diffPage(context(deps,swapped.href))).status,400);
});
test('run log pagination uses the stored cursor and historical missing exits remain explicit',async()=>{
  const old=structuredClone(accepted) as unknown as import('../../contracts/src/validation.ts').ValidationResult;
  for(const items of Object.values(old.partitions))for(const item of items)for(const r of item.requirements)for(const layer of r.layers){delete (layer as {exit?:unknown}).exit;}
  const seen:Array<Record<string,unknown>>=[];
  const deps={runs:{getRun:async()=>({run:runRecord,latest:{record:'c'.repeat(64),result:old},production:{record:'c'.repeat(64),result:old},submissions:[]})},records:{callLog:{query:async(_by:unknown,query:Record<string,unknown>)=>{seen.push(query);return {items:[],next:query.cursor?null:'synthetic-next'};}}}};
  const first=String((await runPage(context(deps,`/console/runs/${runRecord.run}`),runRecord.run)).body);
  assert.ok(first.includes('出口未写'));
  await runPage(context(deps,next(first)),runRecord.run);
  assert.equal(seen[1].cursor,'synthetic-next');
});

test('runs page separates overdue unanswered requests from the ordinary request list',async()=>{
  const request={record:'d'.repeat(64),run:runRecord.run,kind:'clarification',audience:runRecord.runner,due:'2026-10-22T01:00:00.000Z',missing:'合成逾期事实',next_action:'管理员核对原请求',source:'e'.repeat(64),code:'awaiting_step',answered_by:null};
  const deps={knowledge:{},runs:{listRuns:async()=>({items:[],next:null,overdue_requests:[request]}),listRequests:async()=>[request]}};
  const body=String((await runsPage(context(deps,'/console/runs'))).body);
  assert.ok(body.includes('已到期未回答的请求'));
  assert.ok(body.indexOf('合成逾期事实')<body.lastIndexOf('未回答的请求'));
  assert.ok(body.includes(request.record)&&body.includes(request.due));
});
