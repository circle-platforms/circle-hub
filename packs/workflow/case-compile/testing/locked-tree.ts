// The locked command tree of a run as the Hub's run export writes it (knowledge/nodes.jsonl: a head line, then one node per
// path with its children and its entries), built from catalog entries: one node per word below /commands and the definitions at
// the node of their words. Test support only, never pack code.
import {createHash} from 'node:crypto';
import {lockedTree,type LockedTree} from '../functions/catalog-selection.ts';
import {pathOf} from '../../../../hub/refs/api.ts';

type Row={[key:string]:any};
export interface FlatCatalog {root:string;complete?:boolean;entries:ReadonlyArray<{words:string[];signatures:unknown[];summary?:string}>}
const sha=(text:string):string=>createHash('sha256').update(text).digest('hex');
export const RUN='run_synthetic';

/** The lines of nodes.jsonl for a catalog: the head, then the nodes of the tree. */
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
   // The canonical path text of the Hub (hub/refs): the export writes the nodes under it.
   segments.push(word);
   const next=pathOf(segments),parent=at(path,'');
   if(!nodes.has(next)){at(next,word);parent.children.push({name:word,path:next,digest:sha('node '+next)});}
   path=next;
  }
  const node=at(path,'');node.level='leaf';
  const id=sha('entry '+entry.words.join(' ')+JSON.stringify(entry.signatures));
  node.entries.push({entry:id,kind:'definition',statement:entry.words.join(' '),reference:`tree:${catalog.root}${path}@${id}`,data:{words:entry.words,signatures:entry.signatures,...(entry.summary!==undefined?{summary:entry.summary}:{})}});
 }
 const rows=[...nodes.values()];
 return [{schema:'run-knowledge@1',run,root:catalog.root,composition:null,nodes:rows.length,entries:rows.reduce((sum,row)=>sum+row.entries.length,0)},...rows];
}
/** The text of knowledge/nodes.jsonl for a catalog. */
export const nodesText=(catalog:FlatCatalog,run:string=RUN):string=>treeLines(catalog,run).map(row=>JSON.stringify(row)).join('\n')+'\n';
/** The tree the local plan check reads, with the catalog's own word on whether it is complete (a real download carries none). */
export function lockedTreeOf(catalog:FlatCatalog,run:string=RUN):LockedTree{
 const tree=lockedTree(treeLines(catalog,run),{run,root:catalog.root});
 if(typeof tree==='string')throw new Error(tree);
 return {...tree,complete:catalog.complete===true};
}
