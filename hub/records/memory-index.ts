// Mutable, rebuildable memory heads and incremental counters; records remain append-only.
import type {MemoryStatus} from '../../contracts/generated/vocabulary.ts';
import type {Database} from './db.ts';
import type {Transaction} from './api.ts';
export interface MemoryHead {document:string;space:string;version:string;path:string;state:MemoryStatus;bytes:number}
export interface MemoryIndex {
 readonly limits:{documentBytes:number;spaceBytes:number};
 heads(space?:string,tx?:Transaction):Promise<MemoryHead[]>;
 usage(space:string,tx?:Transaction):Promise<{active:number;history:number}>;
 apply(head:MemoryHead,historyBytes:number,tx:Transaction):Promise<void>;
 rebuild(space:string,heads:readonly MemoryHead[],history:number,tx:Transaction):Promise<void>;
}
export class PgMemoryIndex implements MemoryIndex{
 #db:Database;readonly limits:{documentBytes:number;spaceBytes:number};
 constructor(db:Database,limits={documentBytes:24000,spaceBytes:48000}){this.#db=db;this.limits=limits;}
 async heads(space?:string,tx?:Transaction):Promise<MemoryHead[]>{const rows=await this.#db.query<{document:string;space:string;version:string;path:string;state:MemoryStatus;bytes:string}>(`SELECT document,space,version,path,state,bytes::text FROM memory_heads${space===undefined?'':' WHERE space=$1'} ORDER BY document`,space===undefined?[]:[space],tx);return rows.rows.map(row=>({...row,bytes:Number(row.bytes)}));}
 async usage(space:string,tx?:Transaction){const row=(await this.#db.query<{active:string;history:string}>('SELECT active_bytes::text AS active,history_bytes::text AS history FROM memory_space_usage WHERE space=$1',[space],tx)).rows[0];return {active:Number(row?.active??0),history:Number(row?.history??0)};}
 async apply(head:MemoryHead,historyBytes:number,tx:Transaction){
  const old=(await this.heads(head.space,tx)).find(h=>h.document===head.document);if(old?.version===head.version)return;
  if(old&&old.space!==head.space)throw new TypeError('memory identity cannot change spaces');
  const delta=(head.state==='enabled'?head.bytes:0)-(old?.state==='enabled'?old.bytes:0);
  await this.#db.query('INSERT INTO memory_heads(document,space,version,path,state,bytes) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(document) DO UPDATE SET version=$3,path=$4,state=$5,bytes=$6',[head.document,head.space,head.version,head.path,head.state,head.bytes],tx);
  await this.#db.query('INSERT INTO memory_space_usage(space,active_bytes,history_bytes) VALUES($1,0,0) ON CONFLICT DO NOTHING',[head.space],tx);
  await this.#db.query('UPDATE memory_space_usage SET active_bytes=active_bytes+$2,history_bytes=history_bytes+$3 WHERE space=$1',[head.space,delta,historyBytes],tx);
 }
 async rebuild(space:string,heads:readonly MemoryHead[],history:number,tx:Transaction){
  for(const head of heads){if(head.space!==space)throw new TypeError('memory rebuild changes identity');await this.#db.query('INSERT INTO memory_heads(document,space,version,path,state,bytes) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(document) DO UPDATE SET version=$3,path=$4,state=$5,bytes=$6',[head.document,space,head.version,head.path,head.state,head.bytes],tx);}
  const active=heads.reduce((n,h)=>n+(h.state==='enabled'?h.bytes:0),0);
  await this.#db.query('INSERT INTO memory_space_usage(space,active_bytes,history_bytes) VALUES($1,$2,$3) ON CONFLICT(space) DO UPDATE SET active_bytes=$2,history_bytes=$3',[space,active,history],tx);
 }
}
