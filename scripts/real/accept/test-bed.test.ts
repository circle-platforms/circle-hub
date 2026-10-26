// Synthetic transcripts only: no connector, inventory read, model or persistent Hub is contacted.
import assert from 'node:assert/strict';
import {describe,test} from 'node:test';
import type {LoggedTurn} from '../lib/accept.ts';
import type {Reply,Turn} from '../scripted-model.ts';
import scenario,{IDLE_WORDING,earliestWording,type TestBedGold} from './test-bed.ts';

const FIX='台架预订不限时长，用完由运行释放';
const gold:TestBedGold={inventory:'synthetic-bed-topology',need:{devices:[{type:'load-balancer',count:1},{type:'client',count:1}]},beds:[{name:'bed-a',free:'idle',ownership:'你登记的'},{name:'bed-b',free:'held',ownership:'有主人'},{name:'bed-c',free:'2026-10-24T18:00:00.000Z',ownership:'未登记'}],acquire:{bed:'bed-a',devices:['dut0','client0']},release:true};
const run=(char:string)=>'run_'+char.repeat(26);
const SEARCH=run('a'),BOOKING=run('b'),RELEASE=run('c');
const reference=(char:string)=>'rec:'+char.repeat(64);
const start=(id:string,ref:string)=>`运行 ${id}：任务包 test-bed@1.2.0\n完整结果 ${ref}：用 get_nodes 读第一页`;
const refusal=`出错：SUBMISSION_SCHEMA_VIOLATION\n不再接受 hours 或 extend\n修正：${FIX}`;
const searchPage=`台架 bed-a：${IDLE_WORDING}；你登记的\n台架 bed-b：Hub 记录里被占用，没有到期时刻（未排除本地操作）；有主人\n台架 bed-c：${earliestWording('2026-10-24T18:00:00.000Z')}；未登记`;
const acquirePage='预订 bed-a，设备 dut0、client0，不限时长，用完由运行释放';
const releasePage=`释放 bed-a 的预订 ${BOOKING}，设备 dut0、client0`;
type Response={text:string;error?:boolean};
const responses=():Response[]=>[
 {text:start(SEARCH,reference('a'))},{text:searchPage},
 {text:refusal,error:true},{text:refusal,error:true},
 {text:start(BOOKING,reference('b'))},{text:acquirePage},
 {text:refusal,error:true},
 {text:start(RELEASE,reference('c'))},{text:releasePage},
];
const turn=(index:number,response?:Response):Turn=>({index,system:null,messages:[],tools:[],toolResults:response?[{id:'r'+index,text:response.text,isError:response.error===true}]:[]});
async function replay(values=responses()){
 const s=scenario(gold),turns:LoggedTurn[]=[],replies:Reply[]=[];
 for(let i=0;i<=values.length;i++){
  const t=turn(i,values[i-1]);const reply=await s.respond(t);replies.push(reply);
  turns.push({index:i,toolResults:t.toolResults,tools:reply.flatMap(block=>'tool'in block?[block.tool]:[])});
 }
 return {s,turns,replies};
}
const failed=(value:Awaited<ReturnType<typeof replay>>)=>value.s.check(value.turns).filter(check=>!check.ok);

describe('unlimited test-bed scenario',()=>{
 test('searches without hours, verifies three legacy refusals, acquires without TTL and releases from the booking lineage',async()=>{
  const value=await replay();assert.deepEqual(failed(value),[]);
  const starts=value.replies.flat().filter(block=>'tool'in block&&block.tool==='hub_start_run').map(block=>(block as {input:any}).input);
  assert.deepEqual(starts.map(input=>input.parameters),[
   {action:'search',need:gold.need},
   {action:'search',need:gold.need,hours:2},
   {action:'search',need:{...gold.need,hours:2}},
   {action:'acquire',bed:'bed-a',need:gold.need},
   {action:'extend',booking:BOOKING},
   {action:'release',booking:BOOKING},
  ]);
  assert.equal(starts[4].predecessor,BOOKING);assert.equal(starts[5].predecessor,BOOKING);
  assert.ok(starts.every(input=>input.inputs.inventory.external==='doc:doc:synthetic-bed-topology'));
  assert.equal(starts[3].predecessor,undefined);
 });
 test('old duration gold is refused before producing any request',()=>{
  for(const change of [{need:{...gold.need,hours:2}},{acquire:{...gold.acquire,hours:2}},{extend:{hours:1}},{release:false}])assert.throws(()=>scenario({...gold,...change} as TestBedGold),/金标准/);
 });
 test('unexposed owner identities and registration prefixes are not silently accepted as checked gold',()=>{
  for(const extra of [{owner:'synthetic-owner'},{prefix:'bed/bed-a/'}])assert.throws(()=>scenario({...gold,beds:[{...gold.beds[0],...extra}]}),/金标准/);
 });
 test('each successful operation needs its own run id and complete result reference',async()=>{
  for(const at of [0,4,7]){const values=responses();values[at]={text:'出错：SOURCE_UNAVAILABLE',error:true};assert.ok(failed(await replay(values)).length);}
  const values=responses();values[7].text=start(BOOKING,reference('c'));assert.ok(failed(await replay(values)).length);
 });
 test('legacy refusals require a tool error, the specific cause and the full correction in that same reply',async()=>{
  for(const at of [2,3,6])for(const bad of [
   {text:`运行 ${run('d')}\n${refusal}`,error:false},
   {text:refusal,error:false},
   {text:'出错：SOURCE_UNAVAILABLE\n'+FIX,error:true},
   {text:'出错：不再接受 hours 或 extend',error:true},
  ]){const values=responses();values[at]=bad;assert.ok(failed(await replay(values)).length,`${at}: ${JSON.stringify(bad)}`);}
 });
 test('a correction in another phase cannot make a missing refusal pass',async()=>{
  const values=responses();values[2]={text:'出错：不再接受 hours 或 extend',error:true};values[1].text+='\n'+FIX;assert.ok(failed(await replay(values)).length);
 });
 test('the acquire must state unlimited duration and name every device and optional address',async()=>{
  for(const text of [acquirePage.replace('不限时长，用完由运行释放','2 小时'),acquirePage.replace('、client0',''),acquirePage.replace('client0','client01')]){const values=responses();values[5].text=text;assert.ok(failed(await replay(values)).length);}
  const value=await replay();const s=scenario({...gold,acquire:{...gold.acquire,addresses:['192.0.2.10']}});assert.ok(s.check(value.turns).some(check=>!check.ok));
 });
 test('release must name the actual booking and all devices; an echoed request does not prove release',async()=>{
  for(const text of ['',releasePage.replace(BOOKING,SEARCH),releasePage.replace('、client0','')]){const values=responses();values[8].text=text;assert.ok(failed(await replay(values)).length);}
 });
 test('bed availability and ownership are checked on the search pages, not later echoed text',async()=>{
  for(const bad of [searchPage.replace(IDLE_WORDING,'空闲'),searchPage.replace('没有到期时刻','稍后到期'),searchPage.replace('18:00:00','19:00:00'),searchPage.replace('；你登记的','；有主人'),searchPage.split('\n').slice(0,2).join('\n')]){
   const values=responses();values[1].text=bad;values[5].text+='\n'+searchPage;assert.ok(failed(await replay(values)).length);
  }
 });
 test('reads search pagination before probing or booking and never treats a capped page as complete',async()=>{
  const s=scenario(gold);await s.respond(turn(0));await s.respond(turn(1,responses()[0]));
  const more=`\n下一页：get_nodes {"reference":"${reference('a')}","cursor":"next"}`;
  const reply=await s.respond(turn(2,{text:searchPage+more}));assert.deepEqual(reply,[{tool:'hub_get_nodes',input:{reference:reference('a'),cursor:'next'}}]);
  for(let index=3;index<=5;index++)await s.respond(turn(index,{text:searchPage+more}));
  const logs:LoggedTurn[]=[{index:0,toolResults:[],tools:['hub_start_run']},...Array.from({length:5},(_,i)=>({index:i+1,toolResults:[{id:'r',text:i===0?responses()[0].text:searchPage+more,isError:false}],tools:[]}))];
  assert.ok(s.check(logs).some(check=>!check.ok));
 });
 test('an unrelated pagination reference stops the flow and fails instead of reading it',async()=>{
  const s=scenario(gold);await s.respond(turn(0));await s.respond(turn(1,responses()[0]));
  const reply=await s.respond(turn(2,{text:searchPage+`\n下一页：get_nodes {"reference":"${reference('f')}","cursor":"next"}`}));assert.ok('text'in reply[0]);
 });

 test('a failed extend probe or acquire-page read still triggers release of the known booking',async()=>{
  for(const at of [5,6]){const values=responses();values[at]={text:'出错：SOURCE_UNAVAILABLE',error:true};const value=await replay(values);
   assert.ok(failed(value).length);
   const releases=value.replies.flat().filter(block=>'tool'in block&&block.tool==='hub_start_run'&&(block.input as any).parameters.action==='release');
   assert.equal(releases.length,1);assert.equal((releases[0] as {input:any}).input.predecessor,BOOKING);
  }
 });
 test('an unregistered ownership gold adds no registration or forced-release action',async()=>{
  const value=await replay();const actions=value.replies.flat().filter(block=>'tool'in block&&block.tool==='hub_start_run').map(block=>(block as {input:any}).input.parameters.action);
  assert.ok(!actions.some(action=>['register','unregister','force_release'].includes(action)));
 });
 test('a new scenario instance can independently grade the logged transcript',async()=>{
  const value=await replay();assert.ok(scenario(gold).check(value.turns).every(check=>check.ok));
 });
});
