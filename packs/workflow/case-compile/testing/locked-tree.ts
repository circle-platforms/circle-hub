import {createHash} from 'node:crypto';
import {lockedTree,type LockedTree} from '../functions/catalog-selection.ts';
import {pathOf} from '../../../../hub/refs/api.ts';

type Row={[key:string]:any};
export interface ManualNode {words:string[];entries:ReadonlyArray<{statement:string;fragments?:string[]}>}
export interface FlatCatalog {root:string;complete?:boolean;entries:ReadonlyArray<{words:string[];signatures:unknown[];summary?:string}>;manual?:ReadonlyArray<ManualNode>}
const sha=(text:string):string=>createHash('sha256').update(text).digest('hex');
export const RUN='run_synthetic';
export const manualEntryDigest=(words:readonly string[],statement:string):string=>sha('manual entry '+pathOf(['manual',...words])+'\n'+statement);

export function treeLines(catalog:FlatCatalog,run:string=RUN):Row[]{
 const nodes=new Map<string,Row>();
 const at=(path:string,name:string):Row=>{
  let found=nodes.get(path);
  if(found===undefined){found={path,reference:`tree:${catalog.root}${path}`,name,level:'trunk',digest:sha('node '+path),children:[],entries:[]};nodes.set(path,found);}
  return found;
 };
 const top=at('/','');
 at('/commands','commands');top.children.push({name:'commands',path:'/commands',digest:sha('node /commands')});
 for(const entry of catalog.entries){
  let path='/commands';
  const segments=['commands'];
  for(const word of entry.words){
   segments.push(word);
   const next=pathOf(segments),parent=at(path,'');
   if(!nodes.has(next)){at(next,word);parent.children.push({name:word,path:next,digest:sha('node '+next)});}
   path=next;
  }
  const node=at(path,'');node.level='leaf';
  const id=sha('entry '+entry.words.join(' ')+JSON.stringify(entry.signatures));
  node.entries.push({entry:id,kind:'definition',statement:entry.words.join(' '),reference:`tree:${catalog.root}${path}@${id}`,data:{words:entry.words,signatures:entry.signatures,...(entry.summary!==undefined?{summary:entry.summary}:{})}});
 }
 if(catalog.manual?.length){
  at('/manual','manual');top.children.push({name:'manual',path:'/manual',digest:sha('node /manual')});
  for(const manual of catalog.manual){
   let path='/manual';
   const segments=['manual'];
   for(const word of manual.words){
    segments.push(word);
    const next=pathOf(segments),parent=at(path,'');
    if(!nodes.has(next)){at(next,word);parent.children.push({name:word,path:next,digest:sha('node '+next)});}
    path=next;
   }
   const node=at(path,'');node.level='leaf';
   for(const entry of manual.entries){
    const id=manualEntryDigest(manual.words,entry.statement);
    node.entries.push({entry:id,kind:'behaviour',statement:entry.statement,reference:`tree:${catalog.root}${path}@${id}`,data:{},...(entry.fragments!==undefined?{fragments:entry.fragments}:{})});
   }
  }
 }
 const rows=[...nodes.values()];
 return [{schema:'run-knowledge@1',run,root:catalog.root,composition:null,nodes:rows.length,entries:rows.reduce((sum,row)=>sum+row.entries.length,0)},...rows];
}
export const nodesText=(catalog:FlatCatalog,run:string=RUN):string=>treeLines(catalog,run).map(row=>JSON.stringify(row)).join('\n')+'\n';
export function lockedTreeOf(catalog:FlatCatalog,run:string=RUN):LockedTree{
 const tree=lockedTree(treeLines(catalog,run),{run,root:catalog.root});
 if(typeof tree==='string')throw new Error(tree);
 return {...tree,complete:catalog.complete===true};
}
