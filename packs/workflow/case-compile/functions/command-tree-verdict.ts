import type {LockedTree} from './catalog-selection.ts';
import {planBoundary} from './plan-boundary.ts';
import {isRecord} from './text.ts';

export const COMMAND_TREE_CHECK='commands_catalog';
export interface TreeProblem {pointer:string;message:string;verdict?:string;code?:string}
export interface CommandTreeCheck {ran:boolean;why?:string;problems:TreeProblem[]}
export type TreeStatus='accepted'|'refused'|'undetermined'|'not_run';
export interface TreeAnswer {status:TreeStatus;reason?:string;problems?:TreeProblem[]}

const clip=(text:string,chars:number):string=>[...text].length>chars?[...text].slice(0,chars).join('')+'…':text;

export function commandTreeCheck(input:{run:unknown;item:string;slots:unknown;catalog?:LockedTree;catalogProblem?:string}):CommandTreeCheck{
 if(!isRecord(input.run))return {ran:false,why:'没有这次运行冻结的 run.json；命令树核对要用它冻结的合约、环境配置和锁定命令树',problems:[]};
 if(input.catalog===undefined)return {ran:false,why:input.catalogProblem??'缺这次运行冻结根的命令树（knowledge/nodes.jsonl）；没有它命令树核对跑不了',problems:[]};
 let result:ReturnType<typeof planBoundary>;
 try{result=planBoundary({run:input.run,item:input.item,slots:input.slots,catalog:input.catalog,checks:[COMMAND_TREE_CHECK]});}
 catch(error){return {ran:false,why:`命令树核对在本地无法运行：${clip(error instanceof Error?error.message:String(error),200)}`,problems:[]};}
 const row=result.coverage.find(entry=>entry.check===COMMAND_TREE_CHECK);
 const problems:TreeProblem[]=result.problems.map(problem=>({pointer:problem.pointer,message:problem.message,...(problem.verdict!==undefined?{verdict:problem.verdict}:{}),...(problem.code!==undefined?{code:problem.code}:{})}));
 if(row===undefined||!row.ran)return {ran:false,why:`${row?.why??'命令树核对没有运行'}${problems.length?`：${clip(problems[0]!.message,160)}`:''}`,problems:[]};
 return {ran:true,problems};
}

const within=(pointer:string,scope:string):boolean=>pointer===scope||pointer.startsWith(scope+'/');
const holderOf=(pointer:string):string|null=>/^\/(?:blocks|steps)\/\d+(?=\/|$)/u.exec(pointer)?.[0]??null;
const scopeOf=(pointer:string):string=>pointer.endsWith('/call')?pointer.slice(0,-'/call'.length):pointer;

export function commandTreeAnswer(check:CommandTreeCheck,pointer:string):TreeAnswer{
 if(!check.ran)return {status:'not_run',reason:check.why??'命令树核对没有运行'};
 const scope=scopeOf(pointer),own=check.problems.filter(problem=>within(problem.pointer,scope));
 const refused=own.filter(problem=>problem.verdict==='refute');
 if(refused.length)return {status:'refused',problems:refused.slice(0,3)};
 const unsettled=own.length?own:check.problems.filter(problem=>holderOf(problem.pointer)===null);
 if(unsettled.length)return {status:'undetermined',reason:`${own.length?'命令树核对在这一步没有结论':'命令树核对有不属于任何一步的问题，不能说它与这条命令无关'}：${clip(unsettled[0]!.message,160)}`,problems:unsettled.slice(0,3)};
 return {status:'accepted'};
}

export interface PlumbCall {call:'pass'|'review'|'reject';note:string|null;yes?:number}
export interface StepJudgment {verdict:'pass'|'review'|'reject';blocked:boolean;review_required:boolean;note?:string;disclosure?:string}
export const OVERRIDE_DISCLOSURE='Plumb 判断（未确认）与命令树核对不一致；命令树核对通过，以命令树为准，需人工复核';

// The judgment without Plumb: only the program's command tree check speaks. A step it cannot settle stays unknown and is disclosed.
export function treeOnlyStep(tree:TreeAnswer,strictReview:boolean):StepJudgment{
 if(tree.status==='refused'){
  const found=tree.problems?.map(problem=>problem.message).join('；')??'';
  return {verdict:'reject',blocked:true,review_required:false,note:`命令树核对未通过（程序判定）：${found}`};
 }
 if(tree.status==='accepted')return {verdict:'pass',blocked:false,review_required:false};
 return {verdict:'review',blocked:strictReview,review_required:true,disclosure:`命令树核对没有给出结论（${tree.reason??'没有说明'}）；这次按选定的判断方式不问 Plumb，这一步没有判断，状态未知`};
}

export function judgeStep(plumb:PlumbCall,tree:TreeAnswer,strictReview:boolean):StepJudgment{
 if(tree.status==='refused'){
  const found=tree.problems?.map(problem=>problem.message).join('；')??'';
  return {verdict:'reject',blocked:true,review_required:false,note:`命令树核对未通过（程序判定）：${found}${plumb.call==='reject'?'；Plumb 也判这条命令不匹配（未确认）':''}`};
 }
 if(plumb.call==='reject'&&tree.status==='accepted')return {verdict:'review',blocked:strictReview,review_required:true,note:`[需人工复核：Plumb 拒绝${plumb.yes!==undefined?`（p(是)=${plumb.yes.toFixed(3)}）`:''}，命令树核对通过]`,disclosure:OVERRIDE_DISCLOSURE};
 const alone=plumb.call==='reject'&&tree.status!=='accepted'?{disclosure:`命令树核对没有给出结论（${tree.reason??'没有说明'}）；这一步只有 Plumb 的判断（未确认），按它处理`}:{};
 if(plumb.call==='reject')return {verdict:'reject',blocked:true,review_required:false,...(plumb.note!==null?{note:plumb.note}:{}),...alone};
 if(plumb.call==='review')return {verdict:'review',blocked:strictReview,review_required:true,...(plumb.note!==null?{note:plumb.note}:{})};
 return {verdict:'pass',blocked:false,review_required:false,...(plumb.note!==null?{note:plumb.note}:{})};
}
