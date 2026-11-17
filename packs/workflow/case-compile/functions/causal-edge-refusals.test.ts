// Causal links of a block plan (block_context.causal_links): each edge runs from a step block to an observation block that is not
// earlier than it, and every business configuration needs one such edge. Round 36 and round 37 (DNSSEC) wrote edges that end at
// another configuration block and were told «因果边必须由已有步骤指向不早于它的原文观察» and, for eleven configurations,
// «缺配置到后续观察的因果声明», with neither the edge as written, the block ids that exist, nor which end was wrong. The refusals
// now say all of that; what is refused, and whether it is an error or an unknown, is what it always was. Synthetic blocks only.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assertion,call,fixture,plan,quote} from '../testing/blocks.ts';
import {readSlots} from './slots.ts';
import {typedAuthorityGaps} from './typed-authority.ts';

type Edge={from:string;to:string};
/**
 * A capture (observation, 1), a configuration (2), a second configuration (3), an observation (4) and the cleanup of the first
 * configuration (5). The blocks' kinds decide what an end may be: the two captures/observations carry device text, the rest do not.
 */
function scenario(edges:Edge[],extra:Array<Record<string,any>>=[]){
 const f=fixture();
 const data=plan([
  {kind:'CAPTURE',id:'b_show',call:call(),register:'show_raw'},
  {kind:'CONFIG',id:'b_set',call:call('demo set 5')},
  {kind:'CONFIG',id:'b_more',call:call('demo set 6')},
  {kind:'OBSERVE_ASSERT',id:'b_probe',call:call(),assertions:[assertion('a_ready','b_probe')]},
  {kind:'CONFIG',id:'b_undo',call:call('no demo set'),cleanup:true},
  ...extra,
 ]);
 data.block_context!.causal_links=edges.map(edge=>({...edge,quote:quote()}));
 return {f,data};
}
function gapsOf(data:ReturnType<typeof scenario>['data'],f:ReturnType<typeof fixture>){
 const parsed=readSlots(data);assert.ok(parsed.ok,JSON.stringify(parsed));if(!parsed.ok)return [];
 return typedAuthorityGaps(f.contract,f.profile,parsed.slots,undefined,f.catalog,[],f.manifest_sha256);
}
const causal=(gaps:ReturnType<typeof gapsOf>)=>gaps.filter(gap=>gap.pointer.startsWith('/block_context/causal_links/'));
const missing=(gaps:ReturnType<typeof gapsOf>,pointer:string)=>gaps.find(gap=>gap.verdict==='unknown'&&gap.pointer===pointer&&gap.message.includes('因果'));
const has=(text:string,...parts:string[])=>{for(const part of parts)assert.ok(text.includes(part),`missing ${JSON.stringify(part)} in: ${text}`);};
const lacks=(text:string,...parts:string[])=>{for(const part of parts)assert.ok(!text.includes(part),`unexpected ${JSON.stringify(part)} in: ${text}`);};
const RULE='因果边必须由已有步骤指向不早于它的原文观察';
const ALL_IDS='b_show、b_set、b_more、b_probe、b_undo';
const GOOD:Edge[]=[{from:'b_set',to:'b_probe'},{from:'b_more',to:'b_probe'}];

test('an edge that ends at a configuration block says that the end is no observation, shows the edge, the ids that exist and what to do',()=>{
 const {f,data}=scenario([{from:'b_set',to:'b_more'},...GOOD.slice(1),{from:'b_set',to:'b_probe'}]);
 const [gap,...rest]=causal(gapsOf(data,f)) as any[];
 assert.equal(rest.length,0);assert.equal(gap.verdict,'refute');assert.equal(gap.pointer,'/block_context/causal_links/0');
 has(gap.message,RULE,'这一条不是：','终点 b_more 是 CONFIG 块（第 3 步），不产生设备原文，不是观察块',
  '看到：{"from":"b_set","to":"b_more"}',
  '允许：to 取 b_set（第 2 步）之后（含它自己）的观察块 id：b_probe',
  `本条的块 id（按计划顺序）：${ALL_IDS}`,
  '下一步：to 改成上面允许的观察块 id（真正检验这条配置的那一个）','quote 仍逐字取手册里说明它们关系的原文','边的终点必须是观察，不能指向另一条配置，也不能指向排在起点前面的块');
 lacks(gap.message,'起点 from 写的是');
});

test('an end that is the id of no step block is shown with its value, and a saved name is named for what it is',()=>{
 const unknown=scenario([{from:'b_set',to:'nowhere'},{from:'b_more',to:'b_probe'}]);
 const unknownTo=causal(gapsOf(unknown.data,unknown.f)) as any[];
 assert.equal(unknownTo.length,1);
 has(unknownTo[0].message,'终点 to 写的是 "nowhere"，它不是本条任何步骤块的 id','看到：{"from":"b_set","to":"nowhere"}','允许：to 取 b_set（第 2 步）之后（含它自己）的观察块 id：b_probe',`本条的块 id（按计划顺序）：${ALL_IDS}`,'下一步：to 改成上面允许的观察块 id');
 lacks(unknownTo[0].message,'终点 nowhere 是','起点 from');
 const {f,data}=scenario([{from:'show_raw',to:'b_probe'},{from:'b_set',to:'b_probe'},{from:'b_more',to:'b_probe'}]);
 const named=causal(gapsOf(data,f)) as any[];assert.equal(named.length,1);
 has(named[0].message,'起点 from 写的是 "show_raw"，它不是本条任何步骤块的 id；它是块 b_show 保存的名字，块 id 是 b_show','允许：from 取本条的步骤块 id：'+ALL_IDS,'下一步：from 改成本条的块 id（上面列出的），to 不变');
 lacks(named[0].message,'终点');
});

test('an observation earlier than the step is shown with both positions and the observations that are allowed',()=>{
 const {f,data}=scenario([{from:'b_probe',to:'b_show'},...GOOD]);
 const [gap,...rest]=causal(gapsOf(data,f)) as any[];
 assert.equal(rest.length,0);assert.equal(gap.verdict,'refute');
 has(gap.message,'终点 b_show（第 1 步）排在起点 b_probe（第 4 步）之前，边只能指向不早于起点的观察','看到：{"from":"b_probe","to":"b_show"}','允许：to 取 b_probe（第 4 步）之后（含它自己）的观察块 id：b_probe');
 lacks(gap.message,'不是观察块','不是本条任何步骤块的 id');
});

test('both ends wrong are both said, with the set of the step blocks for the start and of the observations for the end',()=>{
 const {f,data}=scenario([{from:'gone',to:'b_undo'},...GOOD]);
 const [gap]=causal(gapsOf(data,f)) as any[];
 has(gap.message,'起点 from 写的是 "gone"，它不是本条任何步骤块的 id','终点 b_undo 是 CONFIG 块（第 5 步），不产生设备原文，不是观察块','允许：from 取本条的步骤块 id：'+ALL_IDS,'to 取本条的观察块 id：b_show、b_probe','下一步：from 改成本条的块 id，to 改成上面允许的观察块 id');
});

test('a configuration without an edge to a later observation is named by its block id, with the observations after it that could carry the edge',()=>{
 const {f,data}=scenario([{from:'b_more',to:'b_probe'}]);
 const gap=missing(gapsOf(data,f),'/blocks/1/call') as any;assert.ok(gap,JSON.stringify(gapsOf(data,f)));
 has(gap.message,'配置块 b_set（ORBIT_0.command，第 2 步）没有因果边指向它之后的观察块','看到：block_context.causal_links 里没有以它为起点的边','允许：to 取 b_set 之后（含它自己）的观察块 id：b_probe',
  '下一步：在 block_context.causal_links 加一条 {"from":"b_set","to":"<上面允许的一个>","quote":{"reference":"<引用>","text":"<逐字原文>"}}','to 选真正检验这条配置的观察','不能从合法 after 推定因果');
 assert.equal(missing(gapsOf(data,f),'/blocks/2/call'),undefined,'b_more has its edge');
 lacks(gap.message,'b_show');
});

test('the edges a configuration already has that do not count are named next to its missing declaration',()=>{
 const {f,data}=scenario([{from:'b_set',to:'b_more'},{from:'b_more',to:'b_probe'}]);
 const gaps=gapsOf(data,f),gap=missing(gaps,'/blocks/1/call') as any;assert.ok(gap,JSON.stringify(gaps));
 has(gap.message,'看到：block_context.causal_links 里以它为起点的边：第 1 条（to=b_more，终点是 CONFIG 块，不是观察块）不算数','允许：to 取 b_set 之后（含它自己）的观察块 id：b_probe');
 assert.equal(causal(gaps).length,1,'the edge itself is refused once, at its own place');
});

test('a configuration with no observation after it is told so instead of an empty set being listed as a fact',()=>{
 const f=fixture(),data=plan([{kind:'OBSERVE_ASSERT',id:'b_probe',call:call(),assertions:[assertion('a_ready','b_probe')]},{kind:'CONFIG',id:'b_late',call:call('demo set 5')}]);
 data.block_context!.causal_links=[];
 const gaps=gapsOf(data,f),gap=missing(gaps,'/blocks/1/call') as any;assert.ok(gap,JSON.stringify(gaps));
 has(gap.message,'配置块 b_late（ORBIT_0.command，第 2 步）没有因果边指向它之后的观察块','允许：无，它之后没有观察块','下一步：先在它之后安排检验它的观察块，再写 {"from":"b_late","to":"<那个观察块的 id>","quote":{"reference":"<引用>","text":"<逐字原文>"}}');
});

test('correct edges leave no causal finding at all, and the refusals keep the verdicts and the places they always had',()=>{
 const good=scenario(GOOD);assert.deepEqual(gapsOf(good.data,good.f).filter(gap=>gap.message.includes('因果')),[]);
 const decisions=(edges:Edge[])=>{const {f,data}=scenario(edges);return gapsOf(data,f).filter(gap=>gap.message.includes('因果')).map(gap=>`${gap.verdict} ${gap.pointer}`);};
 assert.deepEqual(decisions([{from:'b_set',to:'b_more'},{from:'b_more',to:'b_probe'}]),['unknown /blocks/1/call','refute /block_context/causal_links/0']);
 assert.deepEqual(decisions([]),['unknown /blocks/1/call','unknown /blocks/2/call']);
 assert.deepEqual(decisions([{from:'gone',to:'b_probe'},{from:'b_set',to:'nowhere'},{from:'b_probe',to:'b_show'}]),['unknown /blocks/1/call','unknown /blocks/2/call','refute /block_context/causal_links/0','refute /block_context/causal_links/1','refute /block_context/causal_links/2']);
});

test('the refusal is text only: the plan the model wrote is not rewritten',()=>{
 const {f,data}=scenario([{from:'b_set',to:'b_more'}]),before=JSON.stringify(data);
 gapsOf(data,f);assert.equal(JSON.stringify(data),before);
});
