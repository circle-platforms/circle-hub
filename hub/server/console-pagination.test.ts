import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runRecord, accepted } from '../../contracts/src/fixtures.ts';
import type { ServerDeps } from './api.ts';
import { productPage, diffPage, runPage, runsPage, type PageContext } from './console/pages.ts';
const root='a'.repeat(64),other='b'.repeat(64);
function context(deps:unknown,url:string):PageContext{return{deps:deps as ServerDeps,principal:{id:runRecord.runner,name:'合成用户',role:'user'},admin:false,url:new URL(url,'http://127.0.0.1'),userName:async()=> '合成用户',chrome:title=>({title,user:{name:'合成用户',role:'用户',admin:false},csrf:null})};}
const products={products:async()=>[{product:{id:'demo',title:'合成产品',names:['Demo']}}],readableProducts:async()=>new Set(['demo'])};
function next(body:string):string {const href=/href="([^"]+)"[^>]*>下一页/.exec(body)?.[1];assert.ok(href,body.slice(-600));return href.replaceAll('&amp;','&');}
test('an empty task list hides filters and zero counts, while an active filter remains clearable', async () => {
  const deps = { knowledge: {}, runs: { listRuns: async () => ({ items: [], next: null }) } };
  const empty = String((await runsPage(context(deps, '/console/runs'))).body);
  assert.match(empty, /尚无任务/);
  assert.doesNotMatch(empty, /name="pack"|本页 0 个任务|按任务结果筛选/);
  for (const query of ['?pack=missing', '?result=passed']) {
    const filtered = String((await runsPage(context(deps, `/console/runs${query}`))).body);
    assert.match(filtered, /name="pack"/);
    assert.match(filtered, /本页 0 个任务，筛选后 0 个/);
    assert.match(filtered, /按开始时间排列/);
  }
});
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
  // The item results are one tab and the calls another (decision 151); the call log pages inside its tab.
  assert.ok(String((await runPage(context(deps,`/console/runs/${runRecord.run}?tab=items`),runRecord.run)).body).includes('出口未写'));
  const first=String((await runPage(context(deps,`/console/runs/${runRecord.run}?tab=process`),runRecord.run)).body);
  await runPage(context(deps,next(first)),runRecord.run);
  // The waterfall reads the call log too; the paged queries are the ones that carry a cursor.
  const paged=seen.filter(query=>'cursor' in query);
  assert.equal(paged[1].cursor,'synthetic-next');
});

test('the requests of the listed tasks name their audience and put overdue requests first',async()=>{
  const request={record:'d'.repeat(64),run:runRecord.run,kind:'clarification',audience:runRecord.runner,due:'2026-10-22T01:00:00.000Z',missing:'合成逾期事实',next_action:'管理员核对原请求',source:'e'.repeat(64),code:'awaiting_step',answered_by:null};
  const future={...request,record:'f'.repeat(64),due:'2099-01-01T00:00:00.000Z',missing:'合成未来事实'};
  const flagged={...future,record:'c'.repeat(64),missing:'合成列表逾期事实'};
  const asked:unknown[]=[];
  const listing=async(_by:unknown,query:unknown)=>{asked.push(query);return {items:[runRecord],next:null};};
  const deps={knowledge:{},runs:{listRuns:listing,listRequests:async(_by:unknown,run?:string)=>{assert.equal(run,runRecord.run,'a page reads the requests of its own tasks, never every request');return [future,request];}}};
  // Decision 151: the requests are a tab of the task page, merged by what they ask for; the task list says how many wait per task.
  const body=String((await runsPage(context(deps,'/console/runs?view=requests'))).body);
  assert.deepEqual(asked.map(query=>(query as {requests?:boolean}).requests),[false],'the run listing is not asked for every request');
  assert.match(body,/等待回应中的请求/);
  assert.doesNotMatch(body,/已到期未回答的请求|未回答的请求/);
  assert.equal(body.split(request.missing).length,2);
  assert.ok(body.indexOf(request.missing)<body.indexOf(future.missing),'the overdue kind comes first');
  assert.doesNotMatch(body,new RegExp(`${request.record}|${request.audience}`));
  assert.match(body,/<td>合成用户<\/td>/);
  assert.match(body,/1 条已逾期/);
  assert.equal(body.split('已逾期').length,2,'only the overdue kind is marked');
  assert.match(body,/共 2 条，内容相同的归并为 2 类/);
  const tasksView=String((await runsPage(context(deps,'/console/runs'))).body);
  assert.doesNotMatch(tasksView,/合成逾期事实|data-requests/,'the task list carries no request table');
  assert.match(tasksView,/2 条请求等待回应中/,'and says per task how many requests wait');
  assert.match(tasksView,/等待回应中的请求 <span class="ch-count">2<\/span>/);
  assert.doesNotMatch(tasksView,/aria-label="概况"/,'no summary pane repeats the list');
  const detailDeps={records:{callLog:{query:async()=>({items:[],next:null})}},runs:{getRun:async()=>({run:runRecord,latest:null,production:null,submissions:[],requests:[request,future,{...flagged,answered_by:'a'.repeat(64)}]})}};
  const detail=String((await runPage(context(detailDeps,`/console/runs/${runRecord.run}?tab=requests`),runRecord.run)).body);
  assert.match(detail,/等待回应中的请求/);
  const front=String((await runPage(context(detailDeps,`/console/runs/${runRecord.run}`),runRecord.run)).body);
  assert.match(front,/还需处理 · 2 条请求等待回应中/,'the page opens with how many requests wait');assert.ok(front.includes(request.missing)&&front.includes(future.missing));assert.doesNotMatch(front,/data-requests/);
  assert.doesNotMatch(detail,/<th>所属任务<\/th>|合成列表逾期事实/);
  const empty=String((await runsPage(context({knowledge:{},runs:{listRuns:async()=>({items:[],next:null})}},'/console/runs'))).body);
  assert.doesNotMatch(empty,/等待回应中的请求/);
  const atLaterClock={knowledge:{},now:()=>new Date('2100-01-01T00:00:00.000Z'),runs:{listRuns:async()=>({items:[runRecord],next:null}),listRequests:async()=>[future]}};
  const expiredByClock=String((await runsPage(context(atLaterClock,'/console/runs?view=requests'))).body);
  assert.match(expiredByClock,/1 条已逾期/,'request state uses the Hub clock, like the task timeline');
  // The same request issued 150 times is one row that says so.
  const same=Array.from({length:150},(_,n)=>({...future,record:n.toString(16).padStart(64,'0')}));
  const merged=String((await runsPage(context({knowledge:{},runs:{listRuns:async()=>({items:[runRecord],next:null}),listRequests:async()=>same}},'/console/runs?view=requests'))).body);
  assert.equal(merged.split(future.missing).length-1,1);assert.match(merged,/<td>150 条<\/td>/);assert.match(merged,/共 150 条，内容相同的归并为 1 类/);
  const many=Array.from({length:150},(_,n)=>({...request,record:n.toString(16).padStart(64,'0'),missing:`合成事实${n}`}));
  const cut=String((await runsPage(context({knowledge:{},runs:{listRuns:async()=>({items:[runRecord],next:null}),listRequests:async()=>many}},'/console/runs?view=requests'))).body);
  assert.equal(cut.split('合成事实').length-1,100,'a pack can ask something different of thousands of items: a page draws a bounded list');
  assert.match(cut,/显示 100 \/ 共 150 类/,'and says what it left out');
});
