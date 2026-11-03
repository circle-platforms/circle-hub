// Recompute logical admission charges from verified records, never from stored cumulative counters.
import {SpaceVersionBody,SpaceSourceBody,SpaceEntryBody} from '../../contracts/src/spaces.ts';
import {MemoryDocumentBody,MemoryVersionBody} from '../../contracts/src/memory.ts';
import {canonicalize} from './canonical.ts';
import {IntegrityError} from './errors.ts';
import type {Transaction,RecordStore,StoredRecord} from './api.ts';
export interface CapacityHistory {knowledge:number;memory:number;used:number}
export interface CapacityUsage extends CapacityHistory {limit:number;remaining:number;over:number}
export const chargedBytes=(body:unknown)=>Buffer.byteLength(canonicalize(body));
export function safeBytes(value:bigint):number{if(value<0n||value>BigInt(Number.MAX_SAFE_INTEGER))throw new IntegrityError('容量计量超出精确整数范围，须核对计费记录');return Number(value);}
function added(current:readonly string[],previous:readonly string[]){const counts=new Map<string,number>();for(const id of previous)counts.set(id,(counts.get(id)??0)+1);return current.filter(id=>{const count=counts.get(id)??0;if(count){counts.set(id,count-1);return false;}return true;});}
function invalid():never{throw new IntegrityError('容量计费记录不完整，须恢复完整记录后重新核对');}
export async function historyUsage(store:RecordStore,space:string,tx?:Transaction):Promise<CapacityHistory>{
 const versions=await (space==='team'?Promise.resolve([]):store.findMany({kind:'knowledge_space_version',key:'knowledge.space.version',values:[space]},tx));
 const documents=await store.findMany({kind:'memory_document',key:'memory.document.space',values:[space]},tx);
 const memories=await store.findMany({kind:'memory_version',key:'memory.version.space',values:[space]},tx);
 let knowledge=0n,memory=0n;
 const bodies=new Map(versions.map(record=>{const body=SpaceVersionBody.parse(record.body);if(body.space!==space)invalid();return [record.digest,body] as const;}));
 // Deduplicate I/O, not charges: removing then re-adding a reference remains another admission delta.
 const entries=new Map<string,bigint>(),sources=new Map<string,bigint>();
 for(const record of versions){
  const body=bodies.get(record.digest)!,parent=body.parent?bodies.get(body.parent):undefined;if(body.parent&&!parent)invalid();
  for(const id of added(body.entries.map(row=>row.record),parent?.entries.map(row=>row.record)??[]))entries.set(id,(entries.get(id)??0n)+1n);
  for(const id of added(body.sources,parent?.sources??[]))sources.set(id,(sources.get(id)??0n)+1n);
  const free=!body.parent&&!body.entries.length&&!body.sources.length&&!body.products.length&&body.directories.length===1&&body.directories[0]==='/';
  // Cumulative fields are charged only as serialized metadata bytes, never interpreted as a quantity.
  if(!free)knowledge+=BigInt(chargedBytes(record.body));
 }
 const ids=[...new Set([...entries.keys(),...sources.keys()])],batchSize=512;
 for(let offset=0;offset<ids.length;offset+=batchSize){
  const batch=ids.slice(offset,offset+batchSize),records=await store.getMany(batch,tx),artifactIds=new Set<string>();
  for(const id of batch){const record=records.get(id);if(!sources.has(id)||record?.kind!=='knowledge_space_source')continue;const source=SpaceSourceBody.safeParse(record.body);if(source.success&&source.data.space===space)artifactIds.add(source.data.artifact);}
  const artifacts=artifactIds.size?await store.getMany<{size:number;sha256:string}>([...artifactIds],tx):new Map<string,StoredRecord<{size:number;sha256:string}>>();
  for(const id of batch){
   const record=records.get(id),entryCount=entries.get(id),sourceCount=sources.get(id);
   if(entryCount){if(record?.kind!=='knowledge_space_entry'||SpaceEntryBody.parse(record.body).space!==space)invalid();knowledge+=BigInt(chargedBytes(record.body))*entryCount;}
   if(sourceCount){if(record?.kind!=='knowledge_space_source')invalid();const association=SpaceSourceBody.parse(record.body);if(association.space!==space)invalid();const artifact=artifacts.get(association.artifact);if(artifact?.kind!=='source_artifact'||artifact.body.size!==association.size||artifact.body.sha256!==association.sha256)invalid();knowledge+=BigInt(association.size)*sourceCount;}
  }
 }
 const docs=new Set<string>();for(const record of documents){if(MemoryDocumentBody.parse(record.body).space!==space)invalid();docs.add(record.digest);memory+=BigInt(chargedBytes(record.body));}
 for(const record of memories){const body=MemoryVersionBody.parse(record.body);if(body.space!==space||!docs.has(body.document))invalid();memory+=BigInt(chargedBytes(record.body));}
 return {knowledge:safeBytes(knowledge),memory:safeBytes(memory),used:safeBytes(knowledge+memory)};
}
