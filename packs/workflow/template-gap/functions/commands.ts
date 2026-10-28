import type { CommandIdentity } from '../../../../contracts/generated/shared-interfaces.ts';
import { readCommandIdentity, commandKey, rememberIdentity } from './command-identity.ts';
import { authorClassification } from './classification.ts';
// Command membership is read only from the admitted index; category membership uses the existing template matcher.
import { MAX_EVIDENCE, type Template } from './template.ts';
import { compareText, type CaseIndex } from './index.ts';
import type { DocumentCases } from './cases.ts';
import type { CaseCategory, CaseRevisionNodes, CategoryFact, CommandCoverage, Skip } from './types.ts';
export function caseCategories(template: Template, cases: DocumentCases, facts?: CategoryFact[]): CaseCategory[] {
  return authorClassification(template, cases.cases).cases.map(c => ({ id: c.id, visit: c.visit, categories: c.categories, status: c.status })).sort((a,b)=>compareText(a.id,b.id));
}
/** One shared ancestor graph, with non-header leaf text omitted; never duplicate a long label per case. */
export function caseRevisionNodes(cases: DocumentCases): CaseRevisionNodes {
  const needed = new Set<number>();
  for (const record of cases.cases) {
    for (let at = record.visit; at !== -1 && !needed.has(at); at = cases.nodes.parents[at]!) needed.add(at);
  }
  return { texts: cases.nodes.texts.map((text, at) => needed.has(at) ? text : ''), parents: Array.from(cases.nodes.parents) };
}
export function indexedCommands(index: CaseIndex | null, document: string): string[] {
  if (!index) return [];
  return [...new Set((Object.hasOwn(index.keys, document) ? index.keys[document]! : []).flatMap(d => index.entries[d]!.data.commands as string[]))].sort(compareText);
}
export function commandCoverage(template: Template, document: string, cases: CaseCategory[], index: CaseIndex | null, skips: Skip[], uploaded = false, lock: { root?: unknown; build?: unknown } = {}, caseRule: 'marked' | 'tagged' = 'marked', nodes?: CaseRevisionNodes): CommandCoverage {
  const revision=(title:string,labels:string[])=>JSON.stringify([title,...labels]);
  const rows=new Map<string,{identities:Map<string,CommandIdentity>; references:Set<string>;revisions:Set<string>;title:string;labels:string[];legacy:boolean;missingIdentities:boolean;missingTreeRoot:boolean}>();
  if(index&&!uploaded)for(const digest of Object.hasOwn(index.keys,document)?index.keys[document]!:[]){
    const e=index.entries[digest]!,key=e.data.node as string;let row=rows.get(key);
    if(!row){row={identities:new Map(),references:new Set(),revisions:new Set(),title:e.data.title as string,labels:e.data.path_labels as string[],legacy:false,missingIdentities:false,missingTreeRoot:false};rows.set(key,row);}
    const identities=e.data.command_identities;
    if(!Array.isArray(identities))row.missingIdentities=true;
    if(typeof e.data.command_tree_root!=='string')row.missingTreeRoot=true;
    if(row.missingIdentities||row.missingTreeRoot)row.legacy=true;
    else for(const value of identities as unknown[]){const identity=readCommandIdentity(value,e.data.command_tree_root as string);if(identity)rememberIdentity(row.identities,identity);else{row.legacy=true;row.missingIdentities=true;}}
    row.references.add(e.reference);row.revisions.add(revision(e.data.title as string,e.data.path_labels as string[]));
  }
  const sameRevision=(fact:CaseCategory,row:{title:string;labels:string[]})=>{
    if(!nodes||nodes.texts[fact.visit]!==row.title)return false;let at=nodes.parents[fact.visit]!;
    for(let i=row.labels.length-1;i>=0;i--){if(at<0||nodes.texts[at]!==row.labels[i])return false;at=nodes.parents[at]!;}return at===-1;
  };
  const unmatched:string[]=[];
  const matched=(caseRule==='marked'?cases:[]).flatMap(fact=>{const row=rows.get(fact.id.slice(document.length+1));if(!row||!fact.id.startsWith(`${document}:`)||row.revisions.size!==1||!sameRevision(fact,row)){unmatched.push(fact.id);return [];}return[{fact,row}];});
  const currentKeys=new Set(cases.map(c=>c.id.slice(document.length+1)));
  const orphaned=caseRule==='marked'?[...rows.keys()].filter(k=>!currentKeys.has(k)).sort(compareText):[];
  const pending_identities=[...new Map(unmatched.flatMap(id=>[...(rows.get(id.slice(document.length+1))?.identities??new Map<string,CommandIdentity>())])).values()];
  const identities=new Map<string,CommandIdentity>();
  for(const m of matched.filter(m=>!m.row.legacy))for(const identity of m.row.identities.values())rememberIdentity(identities,identity);
  const pending_commands=[...new Set(pending_identities.map(i=>i.path))].sort(compareText);
  const pending_skips=skips.filter(s=>s.command!==undefined&&!identities.has(commandKey(s.command))&&pending_identities.some(i=>commandKey(i)===commandKey(s.command!)));
  const categories=template.categories.filter(c=>c.group==='command');
  const commands=(uploaded||caseRule!=='marked'?[]:[...identities].sort(([a],[b])=>compareText(a,b))).map(([key,identity])=>{
    const chosen=matched.filter(m=>!m.row.legacy&&m.row.identities.has(key));
    const skipped=categories.flatMap(c=>{const skip=skips.find(s=>s.category===c.id&&(s.command===undefined||commandKey(s.command)===key));return skip?[{...skip}]:[];});
    const facts=categories.map(c=>{const evidence=chosen.filter(m=>m.fact.status==='classified'&&m.fact.categories.includes(c.id)).sort((a,b)=>compareText(a.fact.id,b.fact.id));return{id:c.id,label:c.label,group:c.group,required:true,present:evidence.length>0,count:evidence.length,evidence:evidence.slice(0,MAX_EVIDENCE).map(m=>m.fact.id),references:[...new Set(evidence.slice(0,MAX_EVIDENCE).flatMap(m=>[...m.row.references]))].sort(compareText)};});
    const unclassified=chosen.filter(m=>m.fact.status!=='classified').map(m=>m.fact.id).sort(compareText);
    const unseen=facts.filter(c=>!c.present&&!skipped.some(s=>s.category===c.id)).map(c=>c.id);
    return{command:identity.path,identity,caseCount:chosen.length,categories:facts,unclassified,potential_missing:unclassified.length?unseen:[],missing:unclassified.length?[]:unseen,skipped,references:[...new Set(chosen.flatMap(m=>[...m.row.references]))].sort(compareText)};
  });
  const missingTreeRoots=matched.filter(m=>m.row.missingTreeRoot).map(m=>m.fact.id).sort(compareText);
  return{case_rule:caseRule,rule_mismatch:caseRule!=='marked',bound:index!==null,uploaded,documentIndexed:index!==null&&Object.hasOwn(index.keys,document),root:index?.build.root??(typeof lock.root==='string'?lock.root:null),build:index?.build.build??(typeof lock.build==='string'?lock.build:null),caseCount:cases.length,matchedCases:matched.length,unmatched:unmatched.sort(compareText),orphaned,pending_commands,pending_identities,pending_skips,commandlessCases:matched.filter(m=>!m.row.legacy&&m.row.identities.size===0).length,truncated:index?.truncated??false,skippedSources:index?.skipped??0,cutKeys:index?.cut_keys??[],unplacedRoot:null,notes:index?.notes??[],missing_identities:matched.filter(m=>m.row.missingIdentities).map(m=>m.fact.id).sort(compareText),...(missingTreeRoots.length?{missing_tree_roots:missingTreeRoots}:{}),unclassified:cases.filter(c=>c.status!=='classified').map(c=>c.id).sort(compareText),commands};
}
