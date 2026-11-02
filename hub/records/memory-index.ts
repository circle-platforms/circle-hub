// Mutable, rebuildable memory heads and incremental counters; records remain append-only.
import type {MemoryStatus} from '../../contracts/generated/vocabulary.ts';
import type {Database} from './db.ts';
import type {Transaction} from './api.ts';
export interface MemoryHead {document:string;space:string;version:string;path:string;state:MemoryStatus;bytes:number;contextBytes:number}
interface MemoryLimits {documentBytes:number;spaceBytes:number;spaceDocuments:number}
type StoredHead=Omit<MemoryHead,'bytes'|'contextBytes'>&{bytes:string;context_bytes:string};
const headOf=({context_bytes,...row}:StoredHead):MemoryHead=>({...row,bytes:Number(row.bytes),contextBytes:Number(context_bytes)});
export interface MemoryIndex {
 readonly limits:MemoryLimits;
 heads(space?:string,tx?:Transaction):Promise<MemoryHead[]>;
 usage(space:string,tx?:Transaction):Promise<{active:number;history:number;activeDocuments:number}>;
 apply(head:MemoryHead,historyBytes:number,tx:Transaction):Promise<void>;
 replacePersonal?(space:string,epoch:string,heads:readonly MemoryHead[],tx:Transaction):Promise<void>;
 rebuild(space:string,heads:readonly MemoryHead[],history:number,tx:Transaction):Promise<void>;
}
export class PgMemoryIndex implements MemoryIndex{
 #db:Database;readonly limits:MemoryLimits;
 constructor(db:Database,limits:{documentBytes:number;spaceBytes:number;spaceDocuments?:number}={documentBytes:24000,spaceBytes:48000}){this.#db=db;this.limits={...limits,spaceDocuments:limits.spaceDocuments??20};}
 async heads(space?:string,tx?:Transaction):Promise<MemoryHead[]>{const rows=await this.#db.query<StoredHead>(`SELECT document,space,version,path,state,bytes::text,context_bytes::text FROM memory_heads${space===undefined?'':' WHERE space=$1'} ORDER BY document`,space===undefined?[]:[space],tx);return rows.rows.map(headOf);}
 async replacePersonal(space:string,epoch:string,heads:readonly MemoryHead[],tx:Transaction){await this.#db.query('SELECT hub_replace_personal_memory($1,$2,$3::jsonb)',[space,epoch,JSON.stringify(heads)],tx);}
 async usage(space:string,tx?:Transaction){const row=(await this.#db.query<{active:string;history:string;documents:string}>('SELECT active_bytes::text AS active,history_bytes::text AS history,active_documents::text AS documents FROM memory_space_usage WHERE space=$1',[space],tx)).rows[0];const reserved=(await this.#db.query(`SELECT r.bytes,r.documents FROM personal_sync_memory_reservations r JOIN personal_spaces s ON (s.owner,s.epoch)=(r.owner,r.epoch) WHERE r.owner=$1 AND s.mode='hub'`,[space],tx)).rows[0];return {active:Number(row?.active??0)+Number(reserved?.bytes??0),history:Number(row?.history??0),activeDocuments:Number(row?.documents??0)+Number(reserved?.documents??0)};}
 async apply(head:MemoryHead,historyBytes:number,tx:Transaction){
  const stored=(await this.#db.query<StoredHead>('SELECT document,space,version,path,state,bytes::text,context_bytes::text FROM memory_heads WHERE document=$1',[head.document],tx)).rows[0],old=stored?headOf(stored):undefined;if(old?.version===head.version)return;
  if(old&&old.space!==head.space)throw new TypeError('memory identity cannot change spaces');
  const delta=(head.state==='enabled'?head.contextBytes:0)-(old?.state==='enabled'?old.contextBytes:0),documents=Number(head.state==='enabled')-Number(old?.state==='enabled');
  await this.#db.query('INSERT INTO memory_heads(document,space,version,path,state,bytes,context_bytes) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(document) DO UPDATE SET version=$3,path=$4,state=$5,bytes=$6,context_bytes=$7',[head.document,head.space,head.version,head.path,head.state,head.bytes,head.contextBytes],tx);
  await this.#db.query('INSERT INTO memory_space_usage(space,active_bytes,history_bytes) VALUES($1,0,0) ON CONFLICT DO NOTHING',[head.space],tx);
  await this.#db.query('UPDATE memory_space_usage SET active_bytes=active_bytes+$2,history_bytes=history_bytes+$3,active_documents=active_documents+$4 WHERE space=$1',[head.space,delta,historyBytes,documents],tx);
 }
 async rebuild(space:string,heads:readonly MemoryHead[],history:number,tx:Transaction){
  for(const head of heads){if(head.space!==space)throw new TypeError('memory rebuild changes identity');await this.#db.query('INSERT INTO memory_heads(document,space,version,path,state,bytes,context_bytes) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(document) DO UPDATE SET version=$3,path=$4,state=$5,bytes=$6,context_bytes=$7',[head.document,space,head.version,head.path,head.state,head.bytes,head.contextBytes],tx);}
  const active=heads.reduce((n,h)=>n+(h.state==='enabled'?h.contextBytes:0),0),documents=heads.filter(h=>h.state==='enabled').length;
  await this.#db.query('INSERT INTO memory_space_usage(space,active_bytes,history_bytes,active_documents) VALUES($1,$2,$3,$4) ON CONFLICT(space) DO UPDATE SET active_bytes=$2,history_bytes=$3,active_documents=$4',[space,active,history,documents],tx);
 }
}
