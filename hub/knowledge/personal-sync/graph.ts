// Validate the scoped object graph separately from evidence eligibility. Original byte objects remain verbatim.
import {SyncObjectKindSchema,type SyncObjectKind} from '../../../contracts/generated/vocabulary.ts';
import type {PersonalSyncObject} from '../../../contracts/src/sync.ts';
import {mergePersonalSyncHeads} from '../../../contracts/src/sync-merge.ts';
import {PROTOCOL_CODES,type ProtocolCode} from '../../../contracts/generated/protocol.ts';
import {RecordsError} from '../../records/api.ts';
const k=SyncObjectKindSchema.enum;
export type SyncItem={kind:SyncObjectKind;item_id:string;heads:string[]};
export const syncKey=(item:Pick<SyncItem,'kind'|'item_id'>)=>item.kind+':'+item.item_id;
const fail=(code:ProtocolCode='SYNC_OBJECT_INVALID'):never=>{throw new RecordsError(PROTOCOL_CODES[code].when,{code});};
export class SyncGraph{
 readonly nodes=new Map<string,{kind:SyncObjectKind;item_id?:string;target_kind?:SyncObjectKind;parents:string[]}>();
 readonly #load:(id:string)=>Promise<PersonalSyncObject|null>;
 constructor(load:(id:string)=>Promise<PersonalSyncObject|null>){this.#load=load;}
 async get(id:string):Promise<PersonalSyncObject>{const value=await this.#load(id);return value??fail('SYNC_OBJECT_MISSING');}
 async validate(root:string):Promise<void>{
  const visiting=new Set<string>();
  const walk=async(id:string,depth:number):Promise<void>=>{
   if(visiting.has(id))return fail();if(this.nodes.has(id))return;if(depth>4096||this.nodes.size+visiting.size>100000)return fail('SYNC_BATCH_LIMIT');visiting.add(id);
   const object=await this.get(id),body=object.body,parents='parents'in body?body.parents:[];
   for(const parent of parents){await walk(parent,depth+1);const previous=this.nodes.get(parent)!;
    if(object.kind===k.snapshot?previous.kind!==k.snapshot:!('item_id'in body)||previous.item_id!==body.item_id||(previous.target_kind??previous.kind)!==(object.kind===k.deletion?object.body.target_kind:object.kind))return fail();
   }
   if(object.kind===k.source_revision)for(const child of object.body.chunks){await walk(child,depth+1);if(this.nodes.get(child)!.kind!==k.bytes)return fail();}
   if(object.kind===k.entry_revision)for(const ground of object.body.grounds){const source='source'in ground?ground.source:'entry'in ground?ground.entry:null;if(source){await walk(source,depth+1);if(this.nodes.get(source)!.kind!==('entry'in ground?k.entry_revision:k.source_revision))return fail();}await walk(ground.quotation,depth+1);if(this.nodes.get(ground.quotation)!.kind!==k.bytes)return fail();}
   if(object.kind===k.inventory_page)for(const item of object.body.items)for(const head of item.heads){await walk(head,depth+1);const node=this.nodes.get(head)!;const revision=await this.get(head);if(node.item_id!==item.item_id||(node.kind===k.deletion?revision.kind!==k.deletion||revision.body.target_kind!==item.kind:node.kind!==item.kind))return fail();}
   if(object.kind===k.snapshot)for(const page of object.body.pages){await walk(page,depth+1);if(this.nodes.get(page)!.kind!==k.inventory_page)return fail();}
   visiting.delete(id);this.nodes.set(id,{kind:object.kind,target_kind:object.kind===k.deletion?object.body.target_kind:undefined,item_id:'item_id'in body?body.item_id:undefined,parents:[...parents]});
  };await walk(root,0);if(this.nodes.get(root)?.kind!==k.snapshot)return fail();
 }
 async items(root:string|null):Promise<SyncItem[]>{if(!root)return [];const object=await this.get(root);if(object.kind!==k.snapshot)return fail();const items=new Map<string,SyncItem>(),ids=new Set<string>();
  for(const id of object.body.pages){const page=await this.get(id);if(page.kind!==k.inventory_page)return fail();for(const item of page.body.items){const key=syncKey(item);if(items.has(key)||ids.has(item.item_id))return fail();items.set(key,item);ids.add(item.item_id);}}
  if(items.size>10000)return fail('SYNC_BATCH_LIMIT');return [...items.values()].sort((a,b)=>syncKey(a)<syncKey(b)?-1:1);
 }
 ancestor(parent:string,head:string):boolean{const seen=new Set<string>(),todo=[head];while(todo.length){const id=todo.pop()!;if(id===parent)return true;if(seen.has(id))continue;seen.add(id);todo.push(...this.nodes.get(id)?.parents??[]);}return false;}
 checkAdvance(previous:readonly SyncItem[],next:readonly SyncItem[]){const rows=new Map(next.map(i=>[syncKey(i),i]));for(const item of previous){const row=rows.get(syncKey(item));if(!row||item.heads.some(h=>!row.heads.some(n=>this.ancestor(h,n))))return fail('SYNC_VERSION_CONFLICT');}
  const revisions=new Map([...this.nodes].filter(([,n])=>n.item_id).map(([id,n])=>[id,{item_id:n.item_id!,parents:n.parents}]));
  for(const row of next){const pruned=mergePersonalSyncHeads(row.heads,[],revisions);if(pruned.length!==row.heads.length)return fail();}
 }
}
