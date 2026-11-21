import CHECKS from '../checks.json' with {type:'json'};
import REQUIREMENTS from '../requirements.json' with {type:'json'};
import * as checkModule from '../functions/checks.ts';
import * as subjectModule from '../functions/subject.ts';
import {checkInput,notRunReason,problemsOf,type BoundaryProblem} from '../functions/plan-boundary.ts';
import {isRecord,type Outcome} from '../functions/text.ts';
import {selectCatalog} from '../../../../hub/knowledge/catalog-selection.ts';
import {pathOf} from '../../../../hub/refs/api.ts';

type Row={[key:string]:any};
const MODULES:Record<string,Record<string,unknown>>={'functions/checks.ts':checkModule,'functions/subject.ts':subjectModule};
export const DECLARATION={id:'commands@1',entry_kind:'definition',producer:'command-tree',complete:true,case_sensitive:true};
export const ENGINE_LIMIT='目录选择必须声明路径和至多 128 条完整命令，每条至多 8192 字节；拆分计划后重核';
export const ENGINE_UNREADABLE='缺锁定目录的所选路径；管理员修复目录读取后原样重交，不用整棵目录代替';

export type HubView={entries:Row[];complete:boolean}|{missing:string};

export function hubStore(lines:readonly Row[]):Pick<Parameters<typeof selectCatalog>[0],'nodeAt'|'node'|'rowsAt'|'entries'>{
 const [,...rows]=lines;
 const byPath=new Map<string,Row>(rows.map(row=>[row.path,row])),byDigest=new Map<string,Row>(rows.map(row=>[row.digest,row]));
 const body=(node:Row)=>({name:node.name,height:0,level:node.level,children:node.children.map((child:Row)=>({name:child.name,digest:child.digest})),entries:node.entries.map((entry:Row)=>entry.entry)});
 const rowOf=(path:string,entry:Row)=>({path,entry:entry.entry,kind:entry.kind,producers:Array.isArray(entry.data?.signatures)?['command-tree']:['manual'],content:{kind:entry.kind,statement:entry.statement,data:entry.data,applicability:null}});
 return {
  nodeAt:async segments=>{const node=byPath.get(segments.length?pathOf(segments):'/');return node?{digest:node.digest,node:body(node) as never}:null;},
  node:async digest=>{const node=byDigest.get(digest);return node?body(node) as never:null;},
  rowsAt:async path=>new Map((byPath.get(path)?.entries??[]).map((entry:Row)=>[entry.entry,rowOf(path,entry) as never])),
  entries:async ids=>new Map(ids.map(id=>{for(const node of byPath.values())for(const entry of node.entries)if(entry.entry===id)return [id,rowOf(node.path,entry).content as never] as const;throw new Error('no such entry');})),
 };
}

export async function hubView(lines:readonly Row[],selection:unknown,declaration:Row=DECLARATION):Promise<HubView>{
 if(!isRecord(selection)||typeof selection.base!=='string'||!Array.isArray(selection.lines)||selection.lines.length>128||selection.lines.some(line=>typeof line!=='string'||Buffer.byteLength(line)>8192))return {missing:ENGINE_LIMIT};
 try{
  const view=await selectCatalog({root:lines[0].root,selection:selection as {base:string;lines:string[]},declaration:declaration as never,...hubStore(lines)});
  return {entries:JSON.parse(JSON.stringify(view.entries())),complete:view.complete};
 }catch(error){
  return {missing:error instanceof RangeError?error.message:ENGINE_UNREADABLE};
 }
}

export interface HubSide {problems:BoundaryProblem[];selections:Array<{check:string;lines:string[];view:HubView}>}
export async function hubSide(run:Record<string,unknown>,item:string,slots:unknown,tree:readonly Row[]):Promise<HubSide>{
 const row=(Array.isArray(run.items)?run.items:[]).find(value=>isRecord(value)&&value.id===item);
 if(!isRecord(row))throw new Error(`the frozen run has no item ${item}`);
 const problems:BoundaryProblem[]=[],selections:HubSide['selections']=[],views=new Map<string,Promise<{lines:string[];view:HubView}>>(),asked=new Set<string>();
 for(const check of CHECKS.checks){
  if(notRunReason(check)!==null)continue;
  if('interpreter' in check)continue;
  const fn=(check as unknown as {function:{module:string;export?:string}}).function,subject=(check as unknown as {subject:{module:string;export:string}}).subject;
  const bare=checkInput(run,row,slots);
  let raw=bare;
  const select=(check as {catalog_select?:{module:string;export:string}}).catalog_select;
  if('catalog' in check&&select!==undefined){
   const key=JSON.stringify(select);
   if(!views.has(key))views.set(key,(async()=>{const answer=(MODULES[select.module][select.export] as (value:unknown)=>unknown)(JSON.parse(JSON.stringify(bare)));return {lines:isRecord(answer)&&Array.isArray(answer.lines)?answer.lines as string[]:[],view:await hubView(tree,answer)};})());
   const {lines,view}=await views.get(key)!;
   if(!asked.has(key)){asked.add(key);selections.push({check:check.id,lines,view});}
   raw=checkInput(run,row,slots,'entries' in view?{entries:view.entries,complete:view.complete}:{entries:[],complete:false,missing:view.missing});
  }
  const requirement=REQUIREMENTS.requirements.find(value=>(value.checks as string[]).includes(check.id))?.key;
  const built=(MODULES[subject.module][subject.export] as (value:unknown)=>unknown)(raw);
  const outcomes=(MODULES[fn.module][fn.export??'default'] as (value:unknown)=>Outcome[])({check:check.id,subject:built,context:{run:run.run,requirement,pack:'case-compile',sets:{}},sources:{},unread_sources:[]});
  problems.push(...outcomes.filter(outcome=>outcome.verdict!=='support').flatMap(problemsOf));
 }
 return {problems,selections};
}
