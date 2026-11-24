import CHECKS from '../checks.json' with {type:'json'};
import REQUIREMENTS from '../requirements.json' with {type:'json'};
import * as checkModule from './checks.ts';
import * as subjectModule from './subject.ts';
import {slotRecordProblems} from './slot-record.ts';
import {selectedCatalog,type LockedTree,type SelectedCatalog} from './catalog-selection.ts';
import {isRecord,type Outcome} from './text.ts';
import {overlayOf,type RunLate} from './late.ts';
import {PLAN_DATA,listed,refusalText,shownValue} from './refusal-form.ts';
import {frozenQuoteView,quoteVerdicts} from './quote-sources.ts';
import type {QuotePlaces} from './subject.ts';
import type {Verdict} from '../../../../contracts/generated/vocabulary.ts';

const MODULES:Record<string,Record<string,unknown>>={'functions/checks.ts':checkModule,'functions/subject.ts':subjectModule};
const LOCAL_INTERPRETER='quote@1';
const PLACES_OF:Record<string,string>={quoteSubject:'quotePlaces'};
export const LATER_STAGE:Readonly<Record<string,string>>={
 scenario_fidelity:'场景保真审计在计划写完后由 fidelity-plumb 与 fidelity-apply 把判断写进 data.fidelity；submit-plans 发送前用同一个 fidelityProblems 函数复核',
};
export interface HubCheckCoverage {
 check:string;requirements:string[];ran:boolean;
 why?:string;problems?:number;
 unread?:Array<{pointer:string;reference:string;why:string}>;
}
export interface BoundaryProblem { code?:string;pointer:string;message:string;verdict?:Extract<Verdict,'refute'|'unknown'>;[key:string]:unknown }
export interface BoundaryResult { structure_ok:boolean;problems:BoundaryProblem[];coverage:HubCheckCoverage[] }

function selectionOf(check:typeof CHECKS.checks[number]):((input:unknown)=>unknown)|undefined{
 const select=(check as {catalog_select?:{module:string;export:string}}).catalog_select;
 return select===undefined?undefined:MODULES[select.module]?.[select.export] as ((input:unknown)=>unknown)|undefined;
}
const requirementsOf=(check:string):string[]=>REQUIREMENTS.requirements.filter(row=>(row.checks as string[]).includes(check)).map(row=>row.key);
export function notRunReason(check:typeof CHECKS.checks[number]):string|null{
 if(LATER_STAGE[check.id]!==undefined)return LATER_STAGE[check.id];
 if(check.applies!=='item')return '这条检查针对整个运行，不针对单个计划';
 const fn=(check as {function?:{module:string;export?:string}}).function,subject=(check as {subject?:{module:string;export:string}}).subject;
 if('interpreter' in check&&check.interpreter!==undefined){
  if(check.interpreter!==LOCAL_INTERPRETER)return `核心解释器 ${String(check.interpreter)} 只在 Hub 里运行，本地没有它`;
  const places=subject===undefined?undefined:PLACES_OF[subject.export];
  if(subject===undefined||places===undefined||MODULES[subject.module]?.[subject.export]===undefined||MODULES[subject.module]?.[places]===undefined)return `本地没有载入 ${check.interpreter} 的条目取材函数`;
  if('catalog' in check&&selectionOf(check)===undefined)return '这条检查读命令目录但没有声明目录选择函数；Hub 读整棵目录，本地不重放这种读法';
  return null;
 }
 if(fn===undefined||subject===undefined)return '这条检查没有声明包内函数或条目取材函数';
 if(subject.export==='workbookSubject')return '这条检查核对上传的工作簿；计划阶段还没有工作簿';
 if(MODULES[fn.module]?.[fn.export??'default']===undefined||MODULES[subject.module]?.[subject.export]===undefined)return `本地没有载入 ${fn.module}（${fn.export??'default'}）`;
 if('catalog' in check&&selectionOf(check)===undefined)return '这条检查读命令目录但没有声明目录选择函数；Hub 读整棵目录，本地不重放这种读法';
 return null;
}
const stripData=(pointer:string):string=>pointer==='/data'?'':pointer.startsWith('/data/')?pointer.slice('/data'.length):pointer;
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,inner)=>isRecord(inner)?Object.fromEntries(Object.entries(inner).sort(([a],[b])=>a<b?-1:a>b?1:0)):inner);

export function frozenRunProblem(run:unknown,item:string|null):BoundaryProblem{
 if(!isRecord(run))return {pointer:'/run',message:refusalText({what:'--run 读到的不是冻结运行',place:'--run',seen:'顶层不是 JSON 对象',next:'--run 指向本次计划运行下载的运行目录（目录里的 run.json 是冻结运行），不是计划、判断或别的 JSON；重新下载，不手写'})};
 const groups=Array.isArray(run.groups)?run.groups.filter(isRecord):[],cases=groups.filter(group=>group.kind==='case-compile');
 const named=`运行 ${String(run.run)}（工作流 ${String(run.pack)}）`;
 if(cases.length!==1)return {pointer:'/run',message:refusalText({
  what:'冻结运行里的 case-compile 组不是恰好一个',place:'--run',
  seen:`${named}有 ${cases.length} 个 case-compile 组，它的组是 ${groups.length?listed(groups.map(group=>String(group.kind))):'没有'}`,
  allowed:['恰好 1 个 kind 为 case-compile 的组'],
  next:'--run 指向本次脚本编写（plan）运行下载的运行目录，不是用例重组或别的运行的；换成脚本编写运行下载的运行目录再检',
 })};
 const rows=Array.isArray(run.items)?run.items.filter(isRecord):[],ids=rows.map(row=>String(row.id));
 const numbered=item===null?undefined:rows.find(row=>isRecord(row.fields)&&row.fields.autoid===item);
 return {pointer:'/item',message:refusalText({
  what:'计划的 item 不是冻结运行里的条目',place:'/item',seen:shownValue(item??undefined),
  allowed:ids.map(shownValue),
  also:[`${named}共有 ${ids.length} 个条目，id 在 run.json 的 items[].id，也是条目文件 items/<序号>.json 里的 id`],
  next:numbered!==undefined?`把 /item 改成 ${shownValue(numbered.id)}：计划里写的 ${shownValue(item)} 是它的用例号（fields.autoid），item 要写条目 id`:ids.length?'把 /item 改成允许的条目 id 之一':'这份冻结运行里没有条目；重新下载本次计划运行，--run 指向它的运行目录',
 })};
}

export function frozenContext(run:Record<string,unknown>,late?:RunLate|null):Record<string,unknown>{
 const lateInputs=late?late.late.inputs:Array.isArray(run.late_inputs)?run.late_inputs.filter(isRecord).map(row=>({slot:row.slot,run:row.run})):undefined;
 const names=(Array.isArray(run.target_basis)?run.target_basis:[]).flatMap(claim=>isRecord(claim)&&isRecord(claim.statement)&&isRecord(claim.statement.data)&&claim.statement.data.field==='product'&&Array.isArray(claim.statement.data.names)?claim.statement.data.names:[]);
 return {run:run.run,predecessor:run.predecessor??null,...(run.product_pack_digest?{product_pack_digest:run.product_pack_digest}:{}),...(run.skills!==undefined?{skills:run.skills}:{}),...(run.command_policy?{command_policy:run.command_policy}:{}),...(run.feeding_offset?{feeding_offset:run.feeding_offset}:{}),product:run.product??null,names,line:run.version??null,build:run.build??null,root:run.root??null,parameters:run.parameters??{},groups:Array.isArray(run.groups)?run.groups:[],...(lateInputs!==undefined?{late_inputs:lateInputs}:{})};
}
export function checkInput(run:Record<string,unknown>,item:Record<string,unknown>,slots:unknown,catalog?:{entries:unknown[];complete:boolean;missing?:string},late?:RunLate|null):Record<string,unknown>{
 const overlay=typeof item.id==='string'?overlayOf(late,item.id):undefined;
 return {applies:'item',item:{id:item.id,label:item.label,location:item.location,fields:item.fields,...(overlay!==undefined?{late:overlay}:{})},slots,evidence:[],context:frozenContext(run,late),...(catalog!==undefined?{catalog:catalog.entries,catalog_complete:catalog.complete,...(catalog.missing!==undefined?{catalog_missing:catalog.missing}:{})}:{})};
}
export function problemsOf(outcome:Outcome):BoundaryProblem[]{
 const code=outcome.code??outcome.reason;
 const gaps=isRecord(outcome.data)&&Array.isArray(outcome.data.problems)?outcome.data.problems.filter(isRecord):[];
 if(gaps.length)return gaps.map(gap=>({...gap,...(code!==undefined?{code}:{}),pointer:String(gap.pointer??''),message:String(gap.message??'')}) as BoundaryProblem);
 return [{...(code!==undefined?{code}:{}),pointer:stripData(outcome.pointer??''),message:outcome.statement,verdict:outcome.verdict as Extract<Verdict,'refute'|'unknown'>}];
}

function quoteCheck(found:QuotePlaces,run:Record<string,unknown>,tree:LockedTree|undefined):{rows:BoundaryProblem[];coverage:Pick<HubCheckCoverage,'ran'|'why'|'problems'|'unread'>}{
 if(found.kind==='blocked')return {rows:[],coverage:{ran:false,why:`前置检查 contract_shape 驳回了这份计划（${listed(found.blocked.map(row=>`${row.pointer}（${row.code}）`),3)}），Hub 在这些驳回改好前不核引文；先改前置`}};
 if(found.kind==='gap')return {rows:[],coverage:{ran:false,why:`前置检查还缺「${String(found.missing)}」，Hub 在补齐前不核引文`}};
 if(found.kind==='unreadable')return {rows:[],coverage:{ran:false,why:'计划槽位、冻结的合约或清单读不出，没有可核的引文；先改结构，或重新下载本次运行'}};
 const done=quoteVerdicts(found.item,found.places,frozenQuoteView(run,tree));
 const rows=done.outcomes.filter(outcome=>outcome.verdict!=='support').flatMap(problemsOf);
 const unread=done.unread.map(row=>({pointer:row.frozen===true?`冻结条目的 ${row.place}`:`${PLAN_DATA}${row.place}`,reference:row.reference,why:row.why}));
 const reasons=listed([...new Set(unread.map(row=>row.why))],3);
 const decided=found.places.length-unread.length;
 return {rows,coverage:{ran:decided>0||found.places.length===0,problems:rows.length,...(unread.length?{why:`${decided>0?`其中 ${unread.length} 条`:`这 ${unread.length} 条`}引文的原文本地读不到（${reasons}），${decided>0?'这几条':'它们'}以提交回执为准`,unread}:{})}};
}

export function planBoundary(input:{run:Record<string,unknown>;item:string;slots:unknown;catalog?:LockedTree;checks?:readonly string[];late?:RunLate|null}):BoundaryResult{
 const coverage:HubCheckCoverage[]=[],problems:BoundaryProblem[]=[],seen=new Set<string>();
 const add=(row:BoundaryProblem):void=>{const key=canonical(row);if(!seen.has(key)){seen.add(key);problems.push(row);}};
 const frozen=isRecord(input.run.slots)?input.run.slots.schema:undefined;
 const structure=slotRecordProblems(frozen,input.slots);
 for(const row of structure)add({code:'SUBMISSION_SCHEMA_VIOLATION',pointer:row.pointer,message:row.message});
 const item=(Array.isArray(input.run.items)?input.run.items:[]).find(row=>isRecord(row)&&row.id===input.item);
 const selections=new Map<string,SelectedCatalog>();
 const catalogOf=(check:typeof CHECKS.checks[number],raw:Record<string,unknown>,tree:LockedTree)=>{
  const key=JSON.stringify([(check as {catalog?:string}).catalog,(check as {catalog_select?:unknown}).catalog_select]);
  let selected=selections.get(key);
  if(selected===undefined){selected=selectedCatalog(tree,selectionOf(check)!(raw));selections.set(key,selected);}
  return 'entries' in selected?{entries:selected.entries,complete:tree.complete}:{entries:[],complete:false,missing:selected.missing};
 };
 for(const check of CHECKS.checks){
  if(input.checks!==undefined&&!input.checks.includes(check.id))continue;
  const why=notRunReason(check),requirements=requirementsOf(check.id);
  if(why!==null){coverage.push({check:check.id,requirements,ran:false,why});continue;}
  if(structure.length){coverage.push({check:check.id,requirements,ran:false,why:'条目的槽位记录有结构问题时 Hub 不跑任何检查；先改结构'});continue;}
  if(!isRecord(item)){coverage.push({check:check.id,requirements,ran:false,why:'冻结运行里没有这个条目'});continue;}
  const fn=(check as unknown as {function:{module:string;export?:string}}).function,subject=(check as unknown as {subject:{module:string;export:string}}).subject;
  if('interpreter' in check){
   try{
    const bare=checkInput(input.run,item,input.slots,undefined,input.late);
    const raw='catalog' in check&&input.catalog!==undefined?checkInput(input.run,item,input.slots,catalogOf(check,bare,input.catalog),input.late):bare;
    const found=(MODULES[subject.module][PLACES_OF[subject.export]!] as (value:unknown)=>QuotePlaces)(raw);
    const done=quoteCheck(found,input.run,input.catalog);
    for(const row of done.rows)add(row);
    coverage.push({check:check.id,requirements,...done.coverage});
   }catch(error){
    add({code:'check_error',pointer:'',message:`检查 ${check.id} 在本地无法运行：${error instanceof Error?error.message:String(error)}`,verdict:'unknown'});
    coverage.push({check:check.id,requirements,ran:false,why:'本地运行时出错'});
   }
   continue;
  }
  let outcomes:Outcome[];
  try{
   const bare=checkInput(input.run,item,input.slots,undefined,input.late);
   const raw='catalog' in check&&input.catalog!==undefined?checkInput(input.run,item,input.slots,catalogOf(check,bare,input.catalog),input.late):bare;
   const built=(MODULES[subject.module][subject.export] as (value:unknown)=>unknown)(raw);
   outcomes=(MODULES[fn.module][fn.export??'default'] as (value:unknown)=>Outcome[])({check:check.id,subject:built,context:{run:input.run.run,requirement:requirements[0],pack:'case-compile',sets:{}},sources:{},unread_sources:[]});
  }catch(error){
   add({code:'check_error',pointer:'',message:`检查 ${check.id} 在本地无法运行：${error instanceof Error?error.message:String(error)}`,verdict:'unknown'});
   coverage.push({check:check.id,requirements,ran:false,why:'本地运行时出错'});continue;
  }
  const rows=outcomes.filter(outcome=>outcome.verdict!=='support').flatMap(problemsOf);
  for(const row of rows)add(row);
  coverage.push({check:check.id,requirements,ran:true,problems:rows.length});
 }
 return {structure_ok:structure.length===0,problems,coverage};
}
