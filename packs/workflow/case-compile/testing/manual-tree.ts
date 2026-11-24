import type {TreeReader} from '../../../../hub/refs/api.ts';

type Row={[key:string]:any};
export function treeReaderOf(lines:readonly Row[]):TreeReader{
 const [head,...rows]=lines;
 const byPath=new Map<string,Row>(rows.map(row=>[row.path,row]));
 return {
  read:(root,path,entry)=>{
   if(root!==head.root)return null;
   const node=byPath.get(path);if(node===undefined)return null;
   if(entry!==null){
    const found=(node.entries as Row[]).find(row=>row.entry===entry);
    return found===undefined?null:{text:found.statement,mediaType:'text/plain',readTier:'model_readable',grounds:found.fragments??[]};
   }
   const entries=node.entries as Row[];
   return {text:entries.length>0?entries.map(row=>row.statement).join('\n\n'):(node.children as Row[]).map(child=>child.name).join('\n'),mediaType:'text/plain',readTier:'model_readable',grounds:[]};
  },
  readEntry:()=>null,
  hasRoot:root=>root===head.root,
  rootExists:root=>root===head.root,
 };
}
