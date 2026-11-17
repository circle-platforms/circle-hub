// The Hub's plan validation, run offline over one frozen run: the pack's own check functions on the input the Hub builds for them
// (functions/plan-boundary.ts), the quotation check of quote@1 against texts the caller supplies, and the validation@1 record the
// generator tool reads. The command catalog of a check is what the check's own catalog_select function asks for, read from the locked
// tree of the run by functions/catalog-selection.ts, the very walk the local plan check (tools/check-plan.ts, planBoundary) makes of
// the same tree, so the two read one selection. Nothing here needs a database, a sandbox or the network; the Hub's run engine
// (requirement statuses over several rounds, accounts, records) is not reproduced, only what one accepted submission of plans looks
// like to the generator. Used by tests of this pack and by offline reference-plan checks; it never stands in for a Hub acceptance.
import CHECKS from '../checks.json' with {type:'json'};
import REQUIREMENTS from '../requirements.json' with {type:'json'};
import * as checkModule from '../functions/checks.ts';
import * as subjectModule from '../functions/subject.ts';
import {canonicalJson} from '../functions/canonical-json.ts';
import {checkInput} from '../functions/plan-boundary.ts';
import {selectedCatalog,type LockedTree,type SelectedCatalog} from '../functions/catalog-selection.ts';
import {frozenSourceTexts} from '../functions/quote-sources.ts';
import {GENERATOR,generateWorkbookSet,type GenerationInput} from '../functions/generate.ts';
import {sha256} from '../functions/generated/skills/run-tools/hub-client/index.ts';
import {quoteMatches} from '../functions/quote.ts';
import type {ItemHandling} from '../functions/generated/vocabulary.ts';
import {isRecord,type Outcome} from '../functions/text.ts';
import {readWorkbook} from '../functions/workbook.ts';
import {satisfiedRecipes} from '../tools/generate-workbook.ts';
import {coreModel} from './workbook-model.ts';

const MODULES:Record<string,Record<string,unknown>>={'functions/checks.ts':checkModule,'functions/subject.ts':subjectModule};

/** What the quotation check reads: the text a reference points at, or undefined when the caller has none. */
export type TextOf=(reference:string)=>string|undefined;
export interface OfflineCheck {check:string;requirements:string[];ran:boolean;why?:string;outcomes:Outcome[]}
export interface OfflineSubmissionItem {item:string;handling:ItemHandling;slots?:unknown;reason?:string}

/**
 * The texts a frozen run itself holds for references: the author's expectation nodes and atoms, and the declared assertion of an
 * expectation node under its `/@assertion` pseudo reference (what quoteSubject asks quote@1 to find). Manual and command texts come from the caller.
 */
export const frozenTexts=(run:Record<string,unknown>):Map<string,string>=>frozenSourceTexts(run);

const requirementsOf=(check:string):string[]=>REQUIREMENTS.requirements.filter(row=>(row.checks as string[]).includes(check)).map(row=>row.key);
type Declared=typeof CHECKS.checks[number];
/** The function a check names to choose what it reads of the catalog (catalog_select), as the local plan check reads it. */
const selectionOf=(check:Declared):((input:unknown)=>unknown)|undefined=>{
 const select=(check as {catalog_select?:{module:string;export:string}}).catalog_select;
 return select===undefined?undefined:MODULES[select.module]?.[select.export] as ((input:unknown)=>unknown)|undefined;
};

/**
 * Every check of checks.json that judges one plan, on the input the Hub builds for it; workbook checks wait for a workbook.
 * `tree` is the locked tree of the run (testing/locked-tree.ts builds one from a catalog; a run download holds it as
 * knowledge/nodes.jsonl). A check that reads a catalog receives what its own selection function asks for, walked with the Hub's
 * rules and limits (functions/catalog-selection.ts), never the whole tree; the local plan check is given the same tree and walks it
 * the same way.
 */
export function offlineChecks(run:Record<string,unknown>,item:string,slots:unknown,tree:LockedTree|undefined,textOf?:TextOf):OfflineCheck[]{
 const row=(Array.isArray(run.items)?run.items:[]).find(value=>isRecord(value)&&value.id===item);
 if(!isRecord(row))throw new Error(`the frozen run has no item ${item}`);
 const bare=checkInput(run,row,slots);
 // One selection serves every check that names the same catalog and function, as in the engine (selectionKey of evaluate.ts).
 const selections=new Map<string,SelectedCatalog>();
 const inputOf=(check:Declared):Record<string,unknown>=>{
  const select=selectionOf(check);
  if(tree===undefined||!('catalog' in check)||select===undefined)return bare;
  const key=JSON.stringify([(check as {catalog?:string}).catalog,(check as {catalog_select?:unknown}).catalog_select]);
  let selected=selections.get(key);
  if(selected===undefined){selected=selectedCatalog(tree,select(bare));selections.set(key,selected);}
  return checkInput(run,row,slots,'entries' in selected?{entries:selected.entries,complete:tree.complete}:{entries:[],complete:false,missing:selected.missing});
 };
 const rows:OfflineCheck[]=[];
 for(const check of CHECKS.checks){
  const requirements=requirementsOf(check.id);
  const subject=(check as {subject?:{module:string;export:string}}).subject,fn=(check as {function?:{module:string;export?:string}}).function;
  if('interpreter' in check&&check.interpreter==='quote@1'){
   const built=(MODULES[subject!.module][subject!.export] as (value:unknown)=>unknown)(inputOf(check)) as {quotes?:Array<{reference?:string;text?:string}>;blocked?:unknown;missing?:string};
   if(textOf===undefined||!Array.isArray(built.quotes)){rows.push({check:check.id,requirements,ran:false,why:textOf===undefined?'no source texts supplied':'the subject holds no readable quotes',outcomes:[]});continue;}
   rows.push({check:check.id,requirements,ran:true,outcomes:built.quotes.map((quote,index):Outcome=>{
    const text=typeof quote.reference==='string'?textOf(quote.reference):undefined;
    if(text===undefined)return {verdict:'unknown',reason:'missing_input',missing:`no text for ${String(quote.reference)}`,statement:`quote ${index} has no source text offline`,grounds:[],tier:'blocking',item,pointer:`/quotes/${index}/text`};
    return quoteMatches(text,String(quote.text))?{verdict:'support',statement:`quote ${index} is verbatim`,grounds:[],tier:'blocking',item,pointer:`/quotes/${index}/text`,data:{quote:quote.text,reference:quote.reference}}:{verdict:'refute',code:'quote_not_verbatim',statement:`quote ${index} is not in ${String(quote.reference)}`,grounds:[],tier:'blocking',item,pointer:`/quotes/${index}/text`};
   })});
   continue;
  }
  if(fn===undefined||subject===undefined||subject.export==='workbookSubject'){rows.push({check:check.id,requirements,ran:false,why:'judges the uploaded workbook',outcomes:[]});continue;}
  const built=(MODULES[subject.module][subject.export] as (value:unknown)=>unknown)(inputOf(check));
  const outcomes=(MODULES[fn.module][fn.export??'default'] as (value:unknown)=>Outcome[])({check:check.id,subject:built,context:{run:run.run,requirement:requirements[0],pack:'case-compile',sets:{}},sources:{},unread_sources:[]});
  rows.push({check:check.id,requirements,ran:true,outcomes});
 }
 return rows;
}

/** The problems of one plan: every outcome of the checks that ran that is not a support. */
export const offlineProblems=(rows:OfflineCheck[]):Outcome[]=>rows.flatMap(row=>row.outcomes.filter(outcome=>outcome.verdict!=='support'));

/** One item's requirements the way the generator reads them: a requirement is satisfied when every check behind it ran and every outcome supports. */
function requirementRows(rows:OfflineCheck[]){
 return REQUIREMENTS.requirements.map(requirement=>{
  const claims=rows.filter(row=>row.requirements.includes(requirement.key)||(requirement.checks as string[]).includes(row.check)).flatMap(row=>row.outcomes);
  if(requirement.key==='workbook_verified')return {requirement:requirement.key,status:'pending',layers:[{layer:'static',terminal:'unchecked',reason:'missing_input',gaps:[{reason:'missing_input'}]}],claims:[]};
  const checks=requirement.checks as string[];
  const behind=rows.filter(row=>checks.includes(row.check));
  const all=behind.every(row=>row.ran)&&behind.length===checks.length;
  const satisfied=checks.length===0||all&&claims.length>0&&claims.every(outcome=>outcome.verdict==='support');
  const violated=claims.some(outcome=>outcome.verdict==='refute');
  return {requirement:requirement.key,status:satisfied?'satisfied':'unsatisfied',layers:[{layer:'static',terminal:satisfied?(checks.length?'pass':'judgment'):violated?'violation':'unchecked'}],claims:claims.map(outcome=>({statement:{verdict:outcome.verdict,text:outcome.statement,...(outcome.data!==undefined?{data:outcome.data}:{}),...(outcome.code!==undefined?{code:outcome.code}:{})},...(outcome.pointer!==undefined?{pointer:outcome.pointer}:{})}))};
 });
}

/**
 * The submission and the accepted validation@1 of the handled items, as the generator tool reads them. An item the submission
 * skips needs no checks. The result is `accepted` only the way the Hub accepts a submission: it holds the problems it found.
 */
export function offlineValidation(run:Record<string,unknown>,items:OfflineSubmissionItem[],tree:LockedTree|undefined,textOf?:TextOf){
 const submission={run:run.run,model:'offline-reference',items:items.map(value=>value.handling==='skipped'?{item:value.item,handling:'skipped',reason:value.reason??'skipped offline',slots:{plan:[]}}:{item:value.item,handling:'handled',slots:value.slots})};
 const checked=items.filter(value=>value.handling==='handled').map(value=>({item:value.item,rows:offlineChecks(run,value.item,value.slots,tree,textOf)}));
 const errors:unknown[]=[];
 for(const [index,value] of items.entries()){
  if(value.handling==='skipped')continue;
  errors.push({code:'missing_input',item:value.item,message:'no workbook yet',path:`/items/${index}`,requirement:'workbook_verified'});
 }
 const partitions={delivered:checked.map(value=>({item:value.item,requirements:requirementRows(value.rows)}))};
 const result={schema:'validation@1',run:run.run,submission:sha256(canonicalJson(submission)),acceptance:'accepted',errors,locks:{pack:GENERATOR,pack_digest:run.pack_digest,root:run.root},coverage:{complete:true,examined:items.length,total:items.length},partitions};
 return {submission,result,checked};
}

export interface OfflineDocuments {contract:Uint8Array;profile:Uint8Array;inventory:Uint8Array}
/** The workbook the generator tool would write for the handled items: the same recipes (tools/generate-workbook.ts) and the same writer. */
export function offlineWorkbook(run:Record<string,unknown>,items:OfflineSubmissionItem[],tree:LockedTree|undefined,documents:OfflineDocuments,textOf?:TextOf):{bytes:Uint8Array;recipes:GenerationInput[];problems:Outcome[];submission:unknown;result:unknown}{
 const made=offlineValidation(run,items,tree,textOf);
 const problems=made.checked.flatMap(value=>offlineProblems(value.rows));
 const recipes=satisfiedRecipes({run,result:made.result,submission:made.submission,...documents});
 return {bytes:generateWorkbookSet(recipes),recipes,problems,submission:made.submission,result:made.result};
}

/** The independent reading the Hub's workbook check starts from: the rows of the workbook read back and compared with the recipes they were generated from. */
export function offlineReadback(bytes:Uint8Array,recipes:GenerationInput[]):ReturnType<typeof readWorkbook>{return readWorkbook(coreModel(bytes),recipes);}
