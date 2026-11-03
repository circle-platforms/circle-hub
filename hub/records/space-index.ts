// Rebuildable full-text projection of immutable space versions. Callers pass authorized version/path scopes before paging.
import type { Transaction } from './api.ts';
import type { Database } from './db.ts';
import { RecordsError } from './errors.ts';
export const MAX_SPACE_INDEX_BYTES=64*1024*1024;
export const MAX_ENTRY_INDEX_BYTES=1024*1024;
const entryLimit=(bytes:number)=>new RecordsError(`单条知识索引超过 ${bytes} 字节上限`,{code:'SPACE_INDEX_LIMIT',fix:'缩短或拆分当前条目；需要提高上限时联系管理员调整单条索引限额',detail:{entry_limit_bytes:bytes}});
const spaceLimit=(bytes:number)=>new RecordsError(`当前版本知识索引超过 ${bytes} 字节上限`,{code:'SPACE_INDEX_LIMIT',fix:'撤回或替换当前条目以释放当前索引额度；需要提高上限时联系管理员调整空间索引限额，历史引用仍保留',detail:{space_limit_bytes:bytes}});
/** Advisory lock namespace serializing index writes per space; distinct from every other records lock namespace. */
const SPACE_INDEX_LOCK_SPACE = 730_163;
export interface SpaceSearchRow {
  space: string;
  version: string;
  path: string;
  entry: string;
  record: string;
}
export interface SpaceSearchIndex {
  missing(records:readonly string[],tx?:Transaction):Promise<ReadonlySet<string>>;
  ready(version: string, path: string, tx?: Transaction): Promise<boolean>;
  complete(version: string, path: string, tx?: Transaction): Promise<void>;
  add(version: string, rows: Array<Omit<SpaceSearchRow, 'version'> & {
    text?: string;
  }>, tx?: Transaction,quotaSpace?:string): Promise<void>;
  search(text: string, scopes: Array<{
    version: string;
    paths: string[];
    excludeRecords?:string[];
  }>, offset: number, limit: number): Promise<SpaceSearchRow[]>;
}
/** Adjacent Unicode character pairs within each word; isolated one-character words retain their token. */
export function knowledgeTokens(text: string,byteLimit=MAX_ENTRY_INDEX_BYTES): string[] {
  const out = new Set<string>();
  let bytes=64;
  const add=(token:string)=>{if(!out.has(token)){bytes+=Buffer.byteLength(token)+4;if(bytes>byteLimit)throw entryLimit(byteLimit);out.add(token);}};
  for (const word of text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
    let previous:string|undefined,paired=false;
    for(const char of word){if(previous!==undefined){add(previous+char);paired=true;}previous=char;}
    if(!paired)add(word);
  }
  return [...out].sort();
}
export class PgSpaceSearchIndex implements SpaceSearchIndex {
  #db: Database;#entryBytes:number;#spaceBytes:number;
  constructor(db: Database,limits:{entryBytes?:number;spaceBytes?:number}={}) { this.#db = db;this.#entryBytes=limits.entryBytes??MAX_ENTRY_INDEX_BYTES;this.#spaceBytes=limits.spaceBytes??MAX_SPACE_INDEX_BYTES;if(![this.#entryBytes,this.#spaceBytes].every(value=>Number.isSafeInteger(value)&&value>0))throw new TypeError('index limits must be positive bytes'); }
  async missing(records:readonly string[],tx?:Transaction):Promise<ReadonlySet<string>>{
    if(!records.length)return new Set();
    const rows=await this.#db.query<{record:string}>('SELECT record FROM knowledge_space_search_documents WHERE record=ANY($1::text[])',[records],tx);
    const known=new Set(rows.rows.map(row=>row.record));return new Set(records.filter(record=>!known.has(record)));
  }
  async ready(version: string, path: string, tx?: Transaction) {
    const state=(await this.#db.query<{ready:boolean}>(`SELECT row_count=(SELECT count(*) FROM knowledge_space_search s WHERE s.version=$1 AND ($2='/' OR s.path=$2 OR starts_with(s.path,$2||'/'))) AS ready FROM knowledge_space_search_ready r WHERE version=$1 AND path=$2`,[version,path],tx)).rows[0];
    if(!state||state.ready)return state?.ready??false;
    // A damaged projection can be rebuilt. Reconcile only this incomplete version, never the space's history.
    await this.#db.transaction(async transaction=>{
      const scopes=await this.#db.query<{quota_space:string}>('SELECT quota_space FROM knowledge_space_search_totals WHERE version=$1 ORDER BY quota_space',[version],transaction);
      for(const {quota_space} of scopes.rows)await this.#db.query('SELECT pg_advisory_xact_lock($1, hashtext($2))',[SPACE_INDEX_LOCK_SPACE,quota_space],transaction);
      await this.#db.query(`UPDATE knowledge_space_search_totals t SET token_bytes=COALESCE((SELECT sum(d.token_bytes) FROM knowledge_space_search s JOIN knowledge_space_search_documents d ON d.record=s.record WHERE s.version=t.version AND s.quota_space=t.quota_space),0) WHERE t.version=$1`,[version],transaction);
    },tx);
    return false;
  }
  async complete(version: string, path: string, tx?: Transaction) { await this.#db.query(`INSERT INTO knowledge_space_search_ready(version,path,row_count) SELECT $1,$2,count(*) FROM knowledge_space_search s WHERE s.version=$1 AND ($2='/' OR s.path=$2 OR starts_with(s.path,$2||'/')) ON CONFLICT DO NOTHING`, [version, path], tx); }
  async add(version:string,rows:Array<Omit<SpaceSearchRow,'version'>&{text?:string}>,tx?:Transaction,quotaSpace?:string):Promise<void>{
    if(!rows.length)return;
    await this.#db.transaction(async transaction=>{
      const scopes=[...new Set(rows.map(row=>quotaSpace??row.space))].sort();
      for(const scope of scopes)await this.#db.query('SELECT pg_advisory_xact_lock($1, hashtext($2))',[SPACE_INDEX_LOCK_SPACE,scope],transaction);
      const missing=new Set(await this.missing(rows.map(row=>row.record),transaction));
      for(const row of rows){
        if(!missing.has(row.record))continue;
        if(row.text===undefined)throw new RecordsError('缺少待重建的知识搜索内容');
        const tokens=knowledgeTokens(row.text,this.#entryBytes),bytes=64+tokens.reduce((sum,token)=>sum+Buffer.byteLength(token)+4,0);
        if(bytes>this.#entryBytes)throw entryLimit(this.#entryBytes);
        await this.#db.query('INSERT INTO knowledge_space_search_documents(record,tokens,token_bytes) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[row.record,tokens,bytes],transaction);
        missing.delete(row.record);
      }
      const documents=await this.#db.query<{token_bytes:string}>('SELECT token_bytes::text FROM knowledge_space_search_documents WHERE record=ANY($1::text[])',[[...new Set(rows.map(row=>row.record))]],transaction);
      if(documents.rows.some(row=>Number(row.token_bytes)>this.#entryBytes))throw entryLimit(this.#entryBytes);
      for(let at=0;at<rows.length;at+=500){
        // Only newly inserted current-version references add to this version's counter; history is never summed here.
        const totals=await this.#db.query<{quota_space:string;bytes:string}>(`WITH inserted AS (
          INSERT INTO knowledge_space_search(version,space,path,entry,record,quota_space)
          SELECT $1,r.space,r.path,r.entry,r.record,COALESCE($3::text,r.space)
          FROM jsonb_to_recordset($2::jsonb) AS r(space text,path text,entry text,record text)
          ON CONFLICT DO NOTHING RETURNING quota_space,record
        ), increments AS (
          SELECT i.quota_space,$1::text AS version,sum(d.token_bytes) AS bytes FROM inserted i
          JOIN knowledge_space_search_documents d ON d.record=i.record GROUP BY i.quota_space
        ) INSERT INTO knowledge_space_search_totals(quota_space,version,token_bytes)
          SELECT quota_space,version,bytes FROM increments
          ON CONFLICT(quota_space,version) DO UPDATE SET token_bytes=knowledge_space_search_totals.token_bytes+EXCLUDED.token_bytes
          RETURNING quota_space,token_bytes::text AS bytes`,[version,JSON.stringify(rows.slice(at,at+500).map(({space,path,entry,record})=>({space,path,entry,record}))),quotaSpace??null],transaction);
        if(totals.rows.some(row=>Number(row.bytes)>this.#spaceBytes))throw spaceLimit(this.#spaceBytes);
      }
    },tx);
  }
  async search(text: string, scopes: Array<{
    version: string;
    paths: string[];
  }>, offset: number, limit: number): Promise<SpaceSearchRow[]> {
    const tokens = knowledgeTokens(text);
    if (!tokens.length || !scopes.length)
      return [];
    const result = await this.#db.query<{
      space: string;
      version: string;
      path: string;
      entry: string;
      record: string;
    }>(`
   SELECT s.space,s.version,s.path,s.entry,s.record FROM knowledge_space_search s JOIN knowledge_space_search_documents d ON d.record=s.record WHERE d.tokens @> $1::text[] AND EXISTS (
    SELECT 1 FROM jsonb_array_elements($2::jsonb) scope, jsonb_array_elements_text(scope->'paths') prefix
    WHERE scope->>'version'=s.version AND NOT COALESCE((scope->'excludeRecords') ? s.record,false) AND (prefix.value='/' OR s.path=prefix.value OR starts_with(s.path,prefix.value||'/'))
   ) ORDER BY space,path,entry OFFSET $3 LIMIT $4`, [tokens, JSON.stringify(scopes), offset, limit]);
    return result.rows;
  }
}
