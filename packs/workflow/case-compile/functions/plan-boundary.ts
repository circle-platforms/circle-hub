// What the Hub does to a plan submission before it accepts it, run offline with the frozen inputs of one run: the item's slot
// record against the schema the run froze, then every pack check of checks.json that judges the plan, each with the subject builder
// and the function the Hub calls, on the input the Hub builds for it. A check this cannot run here is listed with the reason, so
// the caller never reads "no problem" for a check that did not run.
import CHECKS from '../checks.json' with {type:'json'};
import REQUIREMENTS from '../requirements.json' with {type:'json'};
import * as checkModule from './checks.ts';
import * as subjectModule from './subject.ts';
import {slotRecordProblems} from './slot-record.ts';
import {selectedCatalog,type LockedTree,type SelectedCatalog} from './catalog-selection.ts';
import {isRecord,type Outcome} from './text.ts';
import type {Verdict} from '../../../../contracts/generated/vocabulary.ts';

/** Modules a check or its subject builder is read from, as checks.json names them. */
const MODULES:Record<string,Record<string,unknown>>={'functions/checks.ts':checkModule,'functions/subject.ts':subjectModule};
/** Checks the Hub runs on a plan submission that a plan check leaves to a later stage, with where the same function runs. */
export const LATER_STAGE:Readonly<Record<string,string>>={
 scenario_fidelity:'场景保真审计在计划写完后由 fidelity-plumb 与 fidelity-apply 把判断写进 data.fidelity；submit-plans 发送前用同一个 fidelityProblems 函数复核',
};
export interface HubCheckCoverage { check:string;requirements:string[];ran:boolean;why?:string;problems?:number }
export interface BoundaryProblem { code?:string;pointer:string;message:string;verdict?:Extract<Verdict,'refute'|'unknown'>;[key:string]:unknown }
export interface BoundaryResult { structure_ok:boolean;problems:BoundaryProblem[];coverage:HubCheckCoverage[] }

/** The function a check names to choose what it reads of the catalog (catalog_select), when it is one this module has loaded. */
function selectionOf(check:typeof CHECKS.checks[number]):((input:unknown)=>unknown)|undefined{
 const select=(check as {catalog_select?:{module:string;export:string}}).catalog_select;
 return select===undefined?undefined:MODULES[select.module]?.[select.export] as ((input:unknown)=>unknown)|undefined;
}
const requirementsOf=(check:string):string[]=>REQUIREMENTS.requirements.filter(row=>(row.checks as string[]).includes(check)).map(row=>row.key);
/** Why a declared check cannot run in a plan check; null when it can. */
export function notRunReason(check:typeof CHECKS.checks[number]):string|null{
 if(LATER_STAGE[check.id]!==undefined)return LATER_STAGE[check.id];
 if(check.applies!=='item')return '这条检查针对整个运行，不针对单个计划';
 if('interpreter' in check&&check.interpreter!==undefined)return `核心解释器 ${String(check.interpreter)} 在 Hub 里按它解出的原件文字逐字核对引文；本地没有这些原件文字，引文是否逐字以提交回执为准`;
 const fn=(check as {function?:{module:string;export?:string}}).function,subject=(check as {subject?:{module:string;export:string}}).subject;
 if(fn===undefined||subject===undefined)return '这条检查没有声明包内函数或条目取材函数';
 if(subject.export==='workbookSubject')return '这条检查核对上传的工作簿；计划阶段还没有工作簿';
 if(MODULES[fn.module]?.[fn.export??'default']===undefined||MODULES[subject.module]?.[subject.export]===undefined)return `本地没有载入 ${fn.module}（${fn.export??'default'}）`;
 if('catalog' in check&&selectionOf(check)===undefined)return '这条检查读命令目录但没有声明目录选择函数；Hub 读整棵目录，本地不重放这种读法';
 return null;
}
const stripData=(pointer:string):string=>pointer==='/data'?'':pointer.startsWith('/data/')?pointer.slice('/data'.length):pointer;
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,inner)=>isRecord(inner)?Object.fromEntries(Object.entries(inner).sort(([a],[b])=>a<b?-1:a>b?1:0)):inner);

/** The context the Hub gives checks (runContextOf): only the facts of the frozen run, never anything of the submission. */
export function frozenContext(run:Record<string,unknown>):Record<string,unknown>{
 const names=(Array.isArray(run.target_basis)?run.target_basis:[]).flatMap(claim=>isRecord(claim)&&isRecord(claim.statement)&&isRecord(claim.statement.data)&&claim.statement.data.field==='product'&&Array.isArray(claim.statement.data.names)?claim.statement.data.names:[]);
 return {run:run.run,predecessor:run.predecessor??null,...(run.product_pack_digest?{product_pack_digest:run.product_pack_digest}:{}),...(run.skills!==undefined?{skills:run.skills}:{}),...(run.command_policy?{command_policy:run.command_policy}:{}),...(run.feeding_offset?{feeding_offset:run.feeding_offset}:{}),product:run.product??null,names,line:run.version??null,build:run.build??null,root:run.root??null,parameters:run.parameters??{},groups:Array.isArray(run.groups)?run.groups:[]};
}
/**
 * The input the Hub builds for the subject builder of one item check (evaluate.ts, builderInput): the frozen facts of the run and the
 * item, and for a check that reads a catalog what its selection answered: the entries and whether the catalog is complete, or why
 * they could not be read (no entries then, and the reason with them).
 */
export function checkInput(run:Record<string,unknown>,item:Record<string,unknown>,slots:unknown,catalog?:{entries:unknown[];complete:boolean;missing?:string}):Record<string,unknown>{
 return {applies:'item',item:{id:item.id,label:item.label,location:item.location,fields:item.fields},slots,evidence:[],context:frozenContext(run),...(catalog!==undefined?{catalog:catalog.entries,catalog_complete:catalog.complete,...(catalog.missing!==undefined?{catalog_missing:catalog.missing}:{})}:{})};
}
/** One outcome of a check as plan problems: a gap list becomes one problem per gap (the Hub's data.problems), anything else one problem. */
export function problemsOf(outcome:Outcome):BoundaryProblem[]{
 const code=outcome.code??outcome.reason;
 const gaps=isRecord(outcome.data)&&Array.isArray(outcome.data.problems)?outcome.data.problems.filter(isRecord):[];
 if(gaps.length)return gaps.map(gap=>({...gap,...(code!==undefined?{code}:{}),pointer:String(gap.pointer??''),message:String(gap.message??'')}) as BoundaryProblem);
 return [{...(code!==undefined?{code}:{}),pointer:stripData(outcome.pointer??''),message:outcome.statement,verdict:outcome.verdict as Extract<Verdict,'refute'|'unknown'>}];
}

/**
 * The plan problems of one item with the frozen inputs of its run. `slots` is the item's `slots` object as it would be submitted;
 * `catalog` is the locked command tree downloaded beside the run (optional: without it the checks report what they cannot judge).
 * A check receives the part of it the Hub gives that check: what the check's own catalog_select function asks for, read by the
 * Hub's walk of the tree (catalog-selection.ts), never the whole tree. Like the Hub, an item whose slot record has a structure
 * problem gets no check at all.
 */
export function planBoundary(input:{run:Record<string,unknown>;item:string;slots:unknown;catalog?:LockedTree}):BoundaryResult{
 const coverage:HubCheckCoverage[]=[],problems:BoundaryProblem[]=[],seen=new Set<string>();
 const add=(row:BoundaryProblem):void=>{const key=canonical(row);if(!seen.has(key)){seen.add(key);problems.push(row);}};
 const frozen=isRecord(input.run.slots)?input.run.slots.schema:undefined;
 const structure=slotRecordProblems(frozen,input.slots);
 for(const row of structure)add({code:'SUBMISSION_SCHEMA_VIOLATION',pointer:row.pointer,message:row.message});
 const item=(Array.isArray(input.run.items)?input.run.items:[]).find(row=>isRecord(row)&&row.id===input.item);
 // One selection serves every check that names the same catalog and function, as in the engine (selectionKey of evaluate.ts).
 const selections=new Map<string,SelectedCatalog>();
 const catalogOf=(check:typeof CHECKS.checks[number],raw:Record<string,unknown>,tree:LockedTree)=>{
  const key=JSON.stringify([(check as {catalog?:string}).catalog,(check as {catalog_select?:unknown}).catalog_select]);
  let selected=selections.get(key);
  if(selected===undefined){selected=selectedCatalog(tree,selectionOf(check)!(raw));selections.set(key,selected);}
  return 'entries' in selected?{entries:selected.entries,complete:tree.complete}:{entries:[],complete:false,missing:selected.missing};
 };
 for(const check of CHECKS.checks){
  const why=notRunReason(check),requirements=requirementsOf(check.id);
  if(why!==null){coverage.push({check:check.id,requirements,ran:false,why});continue;}
  if(structure.length){coverage.push({check:check.id,requirements,ran:false,why:'条目的槽位记录有结构问题时 Hub 不跑任何检查；先改结构'});continue;}
  if(!isRecord(item)){coverage.push({check:check.id,requirements,ran:false,why:'冻结运行里没有这个条目'});continue;}
  const fn=(check as unknown as {function:{module:string;export?:string}}).function,subject=(check as unknown as {subject:{module:string;export:string}}).subject;
  let outcomes:Outcome[];
  try{
   const bare=checkInput(input.run,item,input.slots);
   const raw='catalog' in check&&input.catalog!==undefined?checkInput(input.run,item,input.slots,catalogOf(check,bare,input.catalog)):bare;
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
