// Lazy command grammar traversal: exact tree edges, only rows at visited command nodes, bounded content batches.
import {commandTokens} from '../../contracts/generated/command-grammar.ts';
import type {TreeNodeBody,RootCatalog} from '../../contracts/src/knowledge.ts';
import {pathSegments,pathOf,treeReference} from '../refs/api.ts';
import {createCatalogView,type CatalogEntry,type CatalogView} from '../rules/api.ts';
import type {ReadRow} from './composition.ts';
import {catalogData} from './produce.ts';
import type {EntryContent} from './digest.ts';
export interface CatalogSelectionInput{
 root:string;selection:{base:string;lines:string[]};declaration:RootCatalog;
 nodeAt(segments:string[]):Promise<{digest:string;node:TreeNodeBody}|null>;
 node(digest:string):Promise<TreeNodeBody|null>;
 rowsAt(path:string):Promise<Map<string,ReadRow>>;
 entries(ids:string[]):Promise<Map<string,EntryContent>>;
}
export async function selectCatalog(input:CatalogSelectionInput):Promise<CatalogView>{
 const {root,selection,declaration}=input;
  // Follow only exact tree edges from complete CLI tokens. Never scan descendants or all catalog rows.
  if(selection.lines.length>128||selection.lines.some(line=>typeof line!=='string'||Buffer.byteLength(line)>8192))throw new RangeError('目录选择超出 128 条命令或每条 8192 字节；拆分计划后重核');
  const base=pathSegments(selection.base),start=await input.nodeAt(base);
  const nodes=new Map<string,TreeNodeBody|null>(),selected=new Map<string,{entry:CatalogEntry;segments:string[]}>();
  const paths=new Set<string>();
  let nodeBytes=start?Buffer.byteLength(JSON.stringify(start.node)):0;
  if(nodeBytes>8*1024*1024)throw new RangeError('目录路径节点超过 8 MiB；拆分目录或计划后重核');
  for(const line of new Set(selection.lines)){
    const tokens=commandTokens(line);if(!tokens)continue;if(tokens.length>128)throw new RangeError('单条命令超过 128 个语法令牌；拆分计划后重核');
    let current=start,segments=[...base];
    for(const token of tokens){
      if(!current||token.quoted)break;
      const edge=current.node.children.find(child=>child.name===token.value);if(!edge)break;
      let node=nodes.get(edge.digest);if(node===undefined){
        if(nodes.size>=4096)throw new RangeError('目录路径超过 4096 个节点；拆分计划后重核');
        node=await input.node(edge.digest);nodeBytes+=node?Buffer.byteLength(JSON.stringify(node)):0;
        if(nodeBytes>8*1024*1024)throw new RangeError('目录路径节点超过 8 MiB；拆分目录或计划后重核');
        nodes.set(edge.digest,node);
      }
      if(!node)throw new Error('锁定目录路径的节点不可读');
      segments=[...segments,token.value];current={digest:edge.digest,node};
      if(node.entries.length)paths.add(pathOf(segments));
    }
  }
  let bytes=0;
  for(const path of paths){
    const rows=await input.rowsAt(path);
    const kept=[...rows.values()].filter(row=>row.kind===declaration.entry_kind&&(declaration.producer===undefined||row.producers.includes(declaration.producer)));
    if(selected.size+kept.length>512)throw new RangeError('所选路径超过 512 个目录条目；拆分计划后重核');
    const contents=new Map<string,EntryContent>(),ids=kept.filter(row=>!row.content).map(row=>row.entry);
    for(let offset=0;offset<ids.length;offset+=128)for(const [id,content]of await input.entries(ids.slice(offset,offset+128)))contents.set(id,content);
    for(const row of kept){const content=row.content??contents.get(row.entry);if(!content)throw new Error('锁定目录条目不可读');const data=catalogData(content.data);if(!data)continue;
      const entry:CatalogEntry={words:data.words,signatures:data.signatures,reference:treeReference(root,path,row.entry)};
      bytes+=Buffer.byteLength(JSON.stringify(entry));if(bytes>1024*1024)throw new RangeError('所选目录超过 1 MiB；拆分计划后重核');
      selected.set(path+'@'+row.entry,{entry,segments:pathSegments(path)});
    }
  }
  return createCatalogView([...selected.values()].map(value=>value.entry),{reference:treeReference(root,selection.base),complete:declaration.complete,caseSensitive:declaration.case_sensitive});
}
