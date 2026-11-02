// Portable ancestry merge: no clocks, locale comparison, arrival order or semantic selection.
export interface SyncRevisionNode {item_id:string;parents:readonly string[]}
export function mergePersonalSyncHeads(left:readonly string[],right:readonly string[],nodes:ReadonlyMap<string,SyncRevisionNode>):string[]{
 const all=[...new Set([...left,...right])].sort();
 const ancestor=(target:string,head:string)=>{const seen=new Set<string>(),pending=[head];while(pending.length){const id=pending.pop()!;if(id===target)return true;if(seen.has(id))continue;seen.add(id);const node=nodes.get(id);if(!node)throw new TypeError('Missing revision ancestor');pending.push(...node.parents);}return false;};
 for(const id of all)if(!nodes.has(id))throw new TypeError('Missing revision');
 return all.filter(id=>!all.some(other=>other!==id&&nodes.get(other)!.item_id===nodes.get(id)!.item_id&&ancestor(id,other)));
}
