// Logical admission charges come from verified records, never from stored cumulative counters. What a version admitted
// is worked out from the records it names and kept in this process by the version's digest; nothing is written back.
import {SpaceVersionBody,SpaceSourceBody,SpaceEntryBody} from '../../contracts/src/spaces.ts';
import {MemoryDocumentBody,MemoryVersionBody} from '../../contracts/src/memory.ts';
import {canonicalize} from './canonical.ts';
import {IntegrityError} from './errors.ts';
import type {Page,Transaction,RecordStore,StoredRecord} from './api.ts';
export interface CapacityHistory {knowledge:number;memory:number;used:number}
export interface CapacityUsage extends CapacityHistory {limit:number;remaining:number;over:number}
export const chargedBytes=(body:unknown)=>Buffer.byteLength(canonicalize(body));
export function safeBytes(value:bigint):number{if(value<0n||value>BigInt(Number.MAX_SAFE_INTEGER))throw new IntegrityError('容量计量超出精确整数范围，须核对计费记录');return Number(value);}
function added(current:readonly string[],previous:readonly string[]){const counts=new Map<string,number>();for(const id of previous)counts.set(id,(counts.get(id)??0)+1);return current.filter(id=>{const count=counts.get(id)??0;if(count){counts.set(id,count-1);return false;}return true;});}
function invalid():never{throw new IntegrityError('容量计费记录不完整，须恢复完整记录后重新核对');}
/**
 * What one version of a space admitted, in bytes: the version record itself, the entries it adds over its parent and the
 * originals it adds. Every record this rests on is named by its digest (the version, its parent, the entries, the source
 * associations and their artifacts), so the charge of a version never changes once it is worked out from them. A page
 * of a personal space worked the whole history out again on every load, two or three times a page: each entry written is
 * one more version, and each version lists every entry, so the bytes read grew with the square of the entries (issue 200).
 * The charge is kept by the space and the version's digest; the list of a space's versions is still asked on every call,
 * and a version not seen before is read and checked as before.
 */
const CHARGE_LIMIT=65536;
const charges=new Map<string,bigint>();
/** Drops the charges kept, for a test that counts the reads. */
export function forgetCapacityCharges():void{charges.clear();}
const BATCH=512;
async function many<B>(store:RecordStore,ids:readonly string[],tx?:Transaction):Promise<Map<string,StoredRecord<B>>>{
 const out=new Map<string,StoredRecord<B>>(),unique=[...new Set(ids)];
 for(let offset=0;offset<unique.length;offset+=BATCH)for(const [id,record] of await store.getMany<B>(unique.slice(offset,offset+BATCH),tx))out.set(id,record);
 return out;
}
/** The charge of each of `digests`, versions of `space` not worked out before: read with their parents, entries and originals. */
async function versionCharges(store:RecordStore,space:string,digests:readonly string[],tx?:Transaction,listed?:ReadonlyMap<string,StoredRecord<unknown>>):Promise<Map<string,bigint>>{
 // `listed` holds the versions a store without a digest listing already read by kind: they are not read a second time.
 const records=new Map<string,StoredRecord<unknown>>(listed??[]),bodies=new Map<string,SpaceVersionBody>();
 for(const [id,record] of await many<unknown>(store,digests.filter(digest=>!records.has(digest)),tx))records.set(id,record);
 const versionOf=(digest:string):SpaceVersionBody=>{
  let body=bodies.get(digest);if(body)return body;
  const record=records.get(digest);if(!record||!listed?.has(digest)&&record.kind!=='knowledge_space_version')invalid();
  body=SpaceVersionBody.parse(record.body);if(body.space!==space)invalid();bodies.set(digest,body);return body;
 };
 for(const digest of digests)versionOf(digest);
 // A parent outside this batch is read for its lists alone; its own charge was, or will be, worked out with its own parent.
 const parents=[...new Set(digests.flatMap(digest=>{const parent=bodies.get(digest)!.parent;return parent&&!records.has(parent)?[parent]:[];}))];
 for(const [id,record] of await many<unknown>(store,parents,tx))records.set(id,record);
 const addedOf=new Map<string,{entries:string[];sources:string[]}>(),ids=new Set<string>();
 for(const digest of digests){
  const body=bodies.get(digest)!,parent=body.parent?versionOf(body.parent):undefined;
  // Deduplicate I/O, not charges: removing then re-adding a reference remains another admission delta.
  const entries=added(body.entries.map(row=>row.record),parent?.entries.map(row=>row.record)??[]),sources=added(body.sources,parent?.sources??[]);
  addedOf.set(digest,{entries,sources});for(const id of [...entries,...sources])ids.add(id);
 }
 const admitted=await many<unknown>(store,[...ids],tx),artifactIds=new Set<string>();
 for(const {sources} of addedOf.values())for(const id of sources){const record=admitted.get(id);if(record?.kind!=='knowledge_space_source')continue;const source=SpaceSourceBody.safeParse(record.body);if(source.success&&source.data.space===space)artifactIds.add(source.data.artifact);}
 const artifacts=artifactIds.size?await many<{size:number;sha256:string}>(store,[...artifactIds],tx):new Map<string,StoredRecord<{size:number;sha256:string}>>();
 const out=new Map<string,bigint>();
 for(const digest of digests){
  const body=bodies.get(digest)!,{entries,sources}=addedOf.get(digest)!;
  const free=!body.parent&&!body.entries.length&&!body.sources.length&&!body.products.length&&body.directories.length===1&&body.directories[0]==='/';
  // Cumulative fields are charged only as serialized metadata bytes, never interpreted as a quantity.
  let charge=free?0n:BigInt(chargedBytes(records.get(digest)!.body));
  for(const id of entries){const record=admitted.get(id);if(record?.kind!=='knowledge_space_entry'||SpaceEntryBody.parse(record.body).space!==space)invalid();charge+=BigInt(chargedBytes(record.body));}
  for(const id of sources){const record=admitted.get(id);if(record?.kind!=='knowledge_space_source')invalid();const association=SpaceSourceBody.parse(record.body);if(association.space!==space)invalid();const artifact=artifacts.get(association.artifact);if(artifact?.kind!=='source_artifact'||artifact.body.size!==association.size||artifact.body.sha256!==association.sha256)invalid();charge+=BigInt(association.size);}
  out.set(digest,charge);
 }
 return out;
}
/** The versions of a space by digest, without a body where the store can list them so; otherwise the records it read. */
async function versionsOf(store:RecordStore,space:string,tx?:Transaction):Promise<{digests:string[];listed?:Map<string,StoredRecord<unknown>>}>{
 if(!store.findDigests){const records=await store.findMany({kind:'knowledge_space_version',key:'knowledge.space.version',values:[space]},tx);return {digests:records.map(record=>record.digest),listed:new Map(records.map(record=>[record.digest,record]))};}
 const digests:string[]=[];let cursor:string|null=null;
 do{const page:Page<string>=await store.findDigests({kind:'knowledge_space_version',key:'knowledge.space.version',value:space,limit:500,cursor},tx);digests.push(...page.items);cursor=page.next;}while(cursor!==null);
 return {digests};
}
export async function historyUsage(store:RecordStore,space:string,tx?:Transaction):Promise<CapacityHistory>{
 const {digests:versions,listed}=await versionsOf(store,space,tx);
 const documents=await store.findMany({kind:'memory_document',key:'memory.document.space',values:[space]},tx);
 const memories=await store.findMany({kind:'memory_version',key:'memory.version.space',values:[space]},tx);
 let knowledge=0n,memory=0n;
 const key=(digest:string)=>space+'\n'+digest,unknown=versions.filter(digest=>!charges.has(key(digest)));
 const worked=unknown.length?await versionCharges(store,space,unknown,tx,listed):new Map<string,bigint>();
 for(const [digest,charge] of worked){charges.set(key(digest),charge);if(charges.size>CHARGE_LIMIT)charges.delete(charges.keys().next().value!);}
 for(const digest of versions){const charge=worked.get(digest)??charges.get(key(digest));if(charge===undefined)invalid();knowledge+=charge;}
 const docs=new Set<string>();for(const record of documents){if(MemoryDocumentBody.parse(record.body).space!==space)invalid();docs.add(record.digest);memory+=BigInt(chargedBytes(record.body));}
 for(const record of memories){const body=MemoryVersionBody.parse(record.body);if(body.space!==space||!docs.has(body.document))invalid();memory+=BigInt(chargedBytes(record.body));}
 return {knowledge:safeBytes(knowledge),memory:safeBytes(memory),used:safeBytes(knowledge+memory)};
}
