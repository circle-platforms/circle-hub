// Synthetic-bed acceptance through the client; no time-based booking or renewal is a successful operation.
// New independent gold (replace the external old gold; obsolete need.hours/acquire.hours/extend are rejected):
// { inventory: "synthetic-bed-topology", need: { devices: [{type:"load-balancer",count:1}] },
//   beds: [{name:"bed-a",free:"idle",ownership:"你登记的"}],
//   acquire: {bed:"bed-a",devices:["dut0"]}, release: true }
// free is "idle", "held" (occupied with no expiry), or the exact earliest-free ISO timestamp.
// Optional ownership is the search disclosure "你登记的" / "有主人" / "未登记". Owner identities and registration
// prefixes (owner/prefix in the gold are refused) are not exposed by this conclusion: do not derive a bed/<name>/ prefix and call it independent proof.
// Optional acquire.addresses lists expected addresses, as in the previous gold; no new address request is invented.
// Three fixed negative probes exercise top-level hours, need.hours and action=extend separately. Each must return
// the specific refusal and correction in its own error reply. Search/acquire/release are graded independently of
// those expected errors, including their complete result pages. Release always names and descends from the booking,
// never the refused extend. No register/unregister or other ownership mutation is performed by this scenario.
import {resultTexts,type LoggedTurn,type Scenario} from '../lib/accept.ts';
import type {Check} from '../lib/report.ts';
import type {Reply,Turn} from '../scripted-model.ts';
import {parseNextCall,parseRecReference} from './case-location.ts';

export interface SearchBedGold {
  name:string;
  free:'idle'|'held'|string;
  ownership?:'你登记的'|'有主人'|'未登记';
}
export interface AcquireGold {bed:string;devices:string[];addresses?:string[]}
export interface TestBedGold {
  inventory:string;
  need:{devices:Array<{type:string;count:number}>};
  beds:SearchBedGold[];
  acquire:AcquireGold;
  release:true;
}
export const IDLE_WORDING='Hub 记录里空闲（未排除本地操作）';
export const earliestWording=(moment:string):string=>`Hub 记录里最早 ${moment} 空闲（未排除本地操作）`;
export const MAX_PAGES=4;
export function parseRunId(text:string):string|null{return /\b(run_[0-9a-z]{26})\b/.exec(text)?.[1]??null;}
const CORRECTION='台架预订不限时长，用完由运行释放';
const UNLIMITED='不限时长，用完由运行释放';
const HELD='Hub 记录里被占用，没有到期时刻（未排除本地操作）';
type Step='search'|'hours'|'need-hours'|'acquire'|'extend'|'release';
interface Evidence {texts:string[];pages:string[];run:string|null;complete:boolean;refused:boolean}
interface Machine {consume:(turn:Pick<Turn,'index'|'toolResults'>)=>Reply;evidence:Record<Step,Evidence>;failure:()=>string|null}
const textOf=(turn:Pick<Turn,'toolResults'>)=>turn.toolResults.map(result=>result.text).join('\n');
const errorOf=(turn:Pick<Turn,'toolResults'>)=>turn.toolResults.some(result=>result.isError)||turn.toolResults.some(result=>result.text.includes('出错：'));
const refusalOf=(turn:Pick<Turn,'toolResults'>)=>turn.toolResults.length===1&&turn.toolResults.some(result=>result.isError&&result.text.includes('不再接受 hours 或 extend')&&result.text.includes(CORRECTION)&&parseRunId(result.text)===null);

function machine(gold:TestBedGold):Machine {
  const empty=():Evidence=>({texts:[],pages:[],run:null,complete:false,refused:false});
  const evidence:Record<Step,Evidence>={search:empty(),hours:empty(),'need-hours':empty(),acquire:empty(),extend:empty(),release:empty()};
  let step:Step='search',paging=false,pagesRead=0,reference:string|null=null,booking:string|null=null,done=false,failure:string|null=null;
  const start=(next:Step):Reply=>{
    step=next;paging=false;pagesRead=0;reference=null;
    const parameters:Record<string,unknown>=next==='search'?{action:'search',need:gold.need}
      :next==='hours'?{action:'search',need:gold.need,hours:2}
      :next==='need-hours'?{action:'search',need:{...gold.need,hours:2}}
      :next==='acquire'?{action:'acquire',bed:gold.acquire.bed,need:gold.need}
      :next==='extend'?{action:'extend',booking}
      :{action:'release',booking};
    return [{tool:'hub_start_run',input:{pack:'test-bed',inputs:{inventory:{external:`doc:doc:${gold.inventory}`}},parameters,...(next==='extend'||next==='release'?{predecessor:booking}:{})}}];
  };
  const stop=(reason:string):Reply=>{
    failure??=reason;
    // A known booking must still be released when reading or a negative probe fails.
    if(booking!==null&&step!=='release'&&!evidence.release.complete)return start('release');
    done=true;return [{text:`核验未完成：${reason}；下一步：核对本次工具回执，${booking===null?'修复后重新运行场景':`核对预订 ${booking} 的释放结果，必要时由该运行谱系重试释放`}。`}];
  };
  const finished=():Reply=>[{text:failure===null?'本轮搜索、旧入口拒绝与释放回执已读完。':`核验未完成：${failure}；下一步：核对本次回执${booking===null?'并修复后重跑':`及预订 ${booking} 的释放结果，必要时由该运行谱系重试释放`}。`}];
  const advance=():Reply=>step==='search'?start('hours'):step==='hours'?start('need-hours'):step==='need-hours'?start('acquire'):step==='acquire'?start('extend'):step==='extend'?start('release'):(done=true,finished());
  return {evidence,failure:()=>failure,consume(turn){
    if(turn.index===0)return start('search');
    if(done)return finished();
    const current=evidence[step],text=textOf(turn);current.texts.push(text);
    if(step==='hours'||step==='need-hours'||step==='extend'){
      current.refused=refusalOf(turn);current.complete=current.refused;
      return current.refused?advance():stop(`${step} 未返回确定的旧入口拒绝原因和修正说明`);
    }
    if(errorOf(turn))return stop(`${step} 工具调用失败`);
    if(!paging){
      current.run=parseRunId(text);
      if(step==='acquire')booking=current.run;
      const rec=parseRecReference(text);
      if(current.run===null||rec===null)return stop(`${step} 缺少运行号或完整结果引用`);
      reference=rec;paging=true;pagesRead=1;
      return [{tool:'hub_get_nodes',input:{reference:rec}}];
    }
    current.pages.push(text);
    const next=parseNextCall(text);
    if(next!==null){
      if(next.reference!==reference)return stop(`${step} 分页引用改变`);
      if(pagesRead>=MAX_PAGES)return stop(`${step} 在 ${MAX_PAGES} 页内仍未读全`);
      pagesRead++;return [{tool:'hub_get_nodes',input:next}];
    }
    current.complete=true;return advance();
  }};
}

export default function scenario(gold:TestBedGold):Scenario {
  if(!gold||!gold.need||!gold.acquire||Object.hasOwn(gold.need,'hours')||Object.hasOwn(gold.acquire,'hours')||Object.hasOwn(gold,'extend')||gold.release!==true)throw new TypeError('台架金标准已改为不限时长并由运行释放：删除 need.hours、acquire.hours 和 extend，写 release:true');
  if(gold.beds.some(bed=>Object.hasOwn(bed,'owner')||Object.hasOwn(bed,'prefix')))throw new TypeError('台架金标准不能声称已核验 owner 或 prefix：当前搜索结论只披露 ownership 登记状态；主人身份和登记前缀需要额外只读接口');
  const area='台架',live=machine(gold);
  return {
    name:'test-bed',area,
    prompt:`在合成清单 ${gold.inventory} 只读搜索台架，核对旧 hours 和 extend 请求的确定拒绝；不限时预订 ${gold.acquire.bed}，用完由预订运行谱系释放。`,
    respond:turn=>live.consume(turn),
    check(turns:LoggedTurn[]):Check[]{
      const replay=machine(gold);for(const turn of turns)replay.consume(turn);
      const e=replay.evidence,checks:Check[]=[];
      const add=(name:string,expected:string,actual:string,ok:boolean)=>checks.push({area,name,expected,actual:actual.slice(0,250),ok});
      const runs=[e.search.run,e.acquire.run,e.release.run];
      add('搜索、预订和释放各有独立完整结果','3 个不同运行，均读完完整结果',runs.join('、'),runs.every(run=>run!==null)&&new Set(runs).size===3&&[e.search,e.acquire,e.release].every(result=>result.complete));
      add('流程没有未处理错误或截断','没有未处理错误，分页读全',replay.failure()??'无',replay.failure()===null);
      for(const step of ['hours','need-hours','extend'] as const)add(`旧入口 ${step} 返回确定修正`,CORRECTION,e[step].texts.join('\n'),e[step].refused);
      const search=e.search.pages.join('\n').split('\n');
      for(const bed of gold.beds){
        const lines=search.filter(line=>line.includes(`台架 ${bed.name}：`));
        const wording=bed.free==='idle'?IDLE_WORDING:bed.free==='held'?HELD:earliestWording(bed.free);
        add(`台架 ${bed.name} 的空闲结论`,wording,lines.join('\n')||'没有这个台架的结论',lines.some(line=>line.includes(wording)));
        if(bed.ownership!==undefined)add(`台架 ${bed.name} 的登记状态`,bed.ownership,lines.join('\n'),lines.some(line=>line.split('；').some(part=>part.trim()===bed.ownership)));
      }
      const acquired=e.acquire.pages.join('\n').split('\n').find(line=>line.includes(`预订 ${gold.acquire.bed}，`));
      add('预订明确不限时长并由运行释放',UNLIMITED,acquired??'没有预订结论',acquired!==undefined&&acquired.includes(UNLIMITED)&&!/[0-9]+\s*小时/u.test(acquired));
      const named=(line:string|undefined,label:string,name:string):boolean=>line?.split('，').some(part=>part.startsWith(label+' ')&&part.slice(label.length+1).split('、').some(value=>value.trim()===name))===true;
      for(const name of gold.acquire.devices)add(`预订点名设备 ${name}`,name,acquired??'没有预订结论',named(acquired,'设备',name));
      for(const name of gold.acquire.addresses??[])add(`预订点名地址 ${name}`,name,acquired??'没有预订结论',named(acquired,'地址',name));
      const released=e.release.pages.join('\n').split('\n').find(line=>line.includes(`释放 ${gold.acquire.bed} 的预订 ${e.acquire.run}`));
      add('释放点名原预订和全部设备',`释放 ${gold.acquire.bed} 的预订 ${e.acquire.run}，${gold.acquire.devices.join('、')}`,released??'没有原预订的释放结论',released!==undefined&&gold.acquire.devices.every(name=>named(released,'设备',name))&&(gold.acquire.addresses??[]).every(name=>named(released,'地址',name)));
      const texts=resultTexts(turns);add('回答没有超过客户端能转交的长度','每个工具结果不超过 30000 个字符',`最长 ${Math.max(0,...texts.map(text=>text.length))} 个字符`,texts.every(text=>text.length<=30_000));
      return checks;
    },
  };
}
