// Rebuildable full-text projection of immutable space versions. Callers pass authorized version/path scopes before paging.
import type { Transaction } from './api.ts';
import type { Database } from './db.ts';
import { PROTOCOL_CODES } from '../../contracts/generated/protocol.ts';
import { RecordsError } from './errors.ts';
export const MAX_SPACE_INDEX_BYTES=64*1024*1024;
export const MAX_ENTRY_INDEX_BYTES=1024*1024;
const limit=()=>new RecordsError(PROTOCOL_CODES.SPACE_INDEX_LIMIT.when,{code:'SPACE_INDEX_LIMIT',fix:PROTOCOL_CODES.SPACE_INDEX_LIMIT.fix});
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
  }>, tx?: Transaction): Promise<void>;
  search(text: string, scopes: Array<{
    version: string;
    paths: string[];
  }>, offset: number, limit: number): Promise<SpaceSearchRow[]>;
}
/** Adjacent Unicode character pairs within each word; isolated one-character words retain their token. */
export function knowledgeTokens(text: string,byteLimit=MAX_ENTRY_INDEX_BYTES): string[] {
  const out = new Set<string>();
  let bytes=64;
  const add=(token:string)=>{if(!out.has(token)){bytes+=Buffer.byteLength(token)+4;if(bytes>byteLimit)throw limit();out.add(token);}};
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
  async ready(version: string, path: string, tx?: Transaction) { return (await this.#db.query(`SELECT 1 FROM knowledge_space_search_ready r WHERE version=$1 AND path=$2 AND row_count=(SELECT count(*) FROM knowledge_space_search s WHERE s.version=$1 AND ($2='/' OR s.path=$2 OR starts_with(s.path,$2||'/')))`, [version, path], tx)).rows.length > 0; }
  async complete(version: string, path: string, tx?: Transaction) { await this.#db.query(`INSERT INTO knowledge_space_search_ready(version,path,row_count) SELECT $1,$2,count(*) FROM knowledge_space_search s WHERE s.version=$1 AND ($2='/' OR s.path=$2 OR starts_with(s.path,$2||'/')) ON CONFLICT DO NOTHING`, [version, path], tx); }
  async add(version: string, rows: Array<Omit<SpaceSearchRow, 'version'> & {
    text?: string;
  }>, tx?: Transaction): Promise<void> {
    if(!rows.length)return;
    await this.#db.transaction(async transaction=>{
      const spaces=[...new Set(rows.map(row=>row.space))].sort();
      for(const space of spaces)await this.#db.query("SELECT pg_advisory_xact_lock(hashtextextended('knowledge-space-index:'||$1,0))",[space],transaction);
      const missing=new Set(await this.missing(rows.map(row=>row.record),transaction));
      for(const row of rows){if(!missing.has(row.record))continue;if(row.text===undefined)throw new RecordsError('缺少待重建的知识搜索内容');
        const tokens=knowledgeTokens(row.text,this.#entryBytes),bytes=64+tokens.reduce((sum,token)=>sum+Buffer.byteLength(token)+4,0);
        await this.#db.query('INSERT INTO knowledge_space_search_documents(record,tokens,token_bytes) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[row.record,tokens,bytes],transaction);
        missing.delete(row.record);
      }
      for(const space of spaces){const records=rows.filter(row=>row.space===space).map(row=>row.record);
        const size=await this.#db.query<{bytes:string}>(`SELECT COALESCE(sum(token_bytes),0)::text AS bytes FROM knowledge_space_search_documents
          WHERE record IN (SELECT record FROM knowledge_space_search WHERE space=$1 UNION SELECT unnest($2::text[]))`,[space,records],transaction);
        if(Number(size.rows[0].bytes)>this.#spaceBytes)throw limit();
      }
      for(let at=0;at<rows.length;at+=500)await this.#db.query(`INSERT INTO knowledge_space_search(version,space,path,entry,record)
        SELECT $1,r.space,r.path,r.entry,r.record FROM jsonb_to_recordset($2::jsonb) AS r(space text,path text,entry text,record text) ON CONFLICT DO NOTHING`,[version,JSON.stringify(rows.slice(at,at+500).map(({space,path,entry,record})=>({space,path,entry,record})))],transaction);
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
    WHERE scope->>'version'=s.version AND (prefix.value='/' OR s.path=prefix.value OR starts_with(s.path,prefix.value||'/'))
   ) ORDER BY space,path,entry OFFSET $3 LIMIT $4`, [tokens, JSON.stringify(scopes), offset, limit]);
    return result.rows;
  }
}
