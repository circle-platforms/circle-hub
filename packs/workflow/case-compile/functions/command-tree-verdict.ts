// The program's word on the commands of a plan, for the tool that asks a model about them. InfoTest judges commands by program only:
// the command tree of the build decides whether a command exists and whether its parameters have the right count, type, enum and
// range (emit_xlsx_tool.py command_existence_verdict, vendor_stdlib.py _parameter_contract_error; "the XML is the only authority"),
// and no model judges a command. Here the same word is the Hub's own command-tree check (commands_catalog of checks.json, the
// function check-plan runs) on the frozen run and its locked tree, read step by step. Nothing of it is written again.
import type {LockedTree} from './catalog-selection.ts';
import {planBoundary} from './plan-boundary.ts';
import {isRecord} from './text.ts';

/** The one Hub check whose word this is. */
export const COMMAND_TREE_CHECK='commands_catalog';
export interface TreeProblem {pointer:string;message:string;verdict?:string;code?:string}
/** What the check said of a whole plan: whether it ran (and if not why), and every problem it named. */
export interface CommandTreeCheck {ran:boolean;why?:string;problems:TreeProblem[]}
/** accepted: the tree resolves the command and names no problem at its step. refused: it names one. undetermined: it ran but could not settle this step. not_run: it did not run. */
export type TreeStatus='accepted'|'refused'|'undetermined'|'not_run';
export interface TreeAnswer {status:TreeStatus;reason?:string;problems?:TreeProblem[]}

const clip=(text:string,chars:number):string=>[...text].length>chars?[...text].slice(0,chars).join('')+'…':text;

/** Runs the Hub's command-tree check on one plan item with the inputs of its frozen run. It never throws and never reads a file. */
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
/** The block or step a pointer lies in, when it lies in one: /blocks/<n> or /steps/<n>. */
const holderOf=(pointer:string):string|null=>/^\/(?:blocks|steps)\/\d+(?=\/|$)/u.exec(pointer)?.[0]??null;
/** The step of a unit: a block's command call lies in the block, so the whole block is its scope. */
const scopeOf=(pointer:string):string=>pointer.endsWith('/call')?pointer.slice(0,-'/call'.length):pointer;

/**
 * What the check says of one step or block, named by the pointer of its call (`/steps/<n>` or `/blocks/<n>/call`). Accepted only
 * when the check ran and named nothing at this step and nothing that belongs to no step (which could concern any command).
 */
export function commandTreeAnswer(check:CommandTreeCheck,pointer:string):TreeAnswer{
 if(!check.ran)return {status:'not_run',reason:check.why??'命令树核对没有运行'};
 const scope=scopeOf(pointer),own=check.problems.filter(problem=>within(problem.pointer,scope));
 const refused=own.filter(problem=>problem.verdict==='refute');
 if(refused.length)return {status:'refused',problems:refused.slice(0,3)};
 const unsettled=own.length?own:check.problems.filter(problem=>holderOf(problem.pointer)===null);
 if(unsettled.length)return {status:'undetermined',reason:`${own.length?'命令树核对在这一步没有结论':'命令树核对有不属于任何一步的问题，不能说它与这条命令无关'}：${clip(unsettled[0]!.message,160)}`,problems:unsettled.slice(0,3)};
 return {status:'accepted'};
}

/** What Plumb said of a command, as the tool reads its answer: pass, review or reject, and the sentence the tool wrote for that. */
export interface PlumbCall {call:'pass'|'review'|'reject';note:string|null;/** Plumb's probability of the answer "yes", when it gave one. */yes?:number}
export interface StepJudgment {verdict:'pass'|'review'|'reject';blocked:boolean;review_required:boolean;note?:string;disclosure?:string}
/** The sentence a step carries when Plumb rejected a command that the tree accepts. */
export const OVERRIDE_DISCLOSURE='Plumb 判断（未确认）与命令树核对不一致；命令树核对通过，以命令树为准，需人工复核';

/**
 * One verdict out of Plumb's call and the tree's answer: the program decides what it can decide and the model's judgment, which is
 * unconfirmed, only advises. The tree refuses a command: blocked, whatever Plumb said. The tree accepts a command Plumb rejected:
 * review (a person looks), blocked only under --strict-review. Where the tree gave no conclusion (it did not run, or could not
 * settle the step) Plumb alone has spoken and its call stands, as it did before the tree was asked.
 */
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
