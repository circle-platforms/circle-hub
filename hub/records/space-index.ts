// Rebuildable full-text projection of immutable space versions. Callers pass authorized version/path scopes before paging.
import type { Transaction } from './api.ts';
import type { Database } from './db.ts';
import { RecordsError } from './errors.ts';
export const MAX_SPACE_INDEX_BYTES=64*1024*1024;
export const MAX_PRODUCT_INDEX_BYTES=1024*1024*1024;
export const MAX_ENTRY_INDEX_BYTES=1024*1024;
/** A quota scope with this prefix is a product mount, which only a sync writes; every other scope is a space members write to. */
export const PRODUCT_QUOTA_PREFIX='product:';
/** One multi-row statement holds at most this many documents or token bytes (a larger document goes alone), so that serializing it stays a short hold of the event loop. */
const STATEMENT_ROWS=500,STATEMENT_BYTES=1024*1024;
const entryLimit=(bytes:number)=>new RecordsError(`单条知识索引超过 ${bytes} 字节上限`,{code:'SPACE_INDEX_LIMIT',fix:'缩短或拆分当前条目；需要提高上限时联系管理员调整单条索引限额',detail:{entry_limit_bytes:bytes}});
const spaceLimit=(bytes:number)=>new RecordsError(`当前版本知识索引超过 ${bytes} 字节上限`,{code:'SPACE_INDEX_LIMIT',fix:'撤回或替换当前条目以释放当前索引额度；需要提高上限时联系管理员调整空间索引限额，历史引用仍保留',detail:{space_limit_bytes:bytes}});
// Nobody reading a product can withdraw or change its entries: the remedy is the administrator's, and the build then goes on by itself (D05 R[8]).
const productLimit=(bytes:number)=>new RecordsError(`当前版本知识索引超过 ${bytes} 字节上限`,{code:'SPACE_INDEX_LIMIT',fix:'由管理员调高 CIRCLE_HUB_MAX_PRODUCT_INDEX_BYTES 并重启 Hub，后台随后从停下的地方接着建；产品内容不能在这里撤回',detail:{space_limit_bytes:bytes}});
const productEntryLimit=(bytes:number)=>new RecordsError(`单条知识索引超过 ${bytes} 字节上限`,{code:'SPACE_INDEX_LIMIT',fix:'由管理员调高 CIRCLE_HUB_MAX_ENTRY_INDEX_BYTES 并重启 Hub，后台随后从停下的地方接着建；产品内容不能在这里修改',detail:{entry_limit_bytes:bytes}});
/** Advisory lock namespace serializing index writes per space; distinct from every other records lock namespace. */
const SPACE_INDEX_LOCK_SPACE = 730_163;
export interface SpaceSearchRow {
  space: string;
  version: string;
  path: string;
  entry: string;
  record: string;
}
/** The tokens of one entry record and what they count against the limits. */
export interface SpaceSearchDocument {
  tokens: string[];
  bytes: number;
}
/** One version at one path, with the scope its bytes count against. */
export interface SpaceIndexScope {
  version: string;
  path: string;
  quotaSpace: string;
}
/** What a search may rely on, from stored rows alone. Neither ready nor refused: the version is still to be built. */
export interface SpaceIndexState {
  ready: boolean;
  /** The limit this version passed, while that limit stands; the build is not tried again. A ready version passed it in a repair, and only a round's proof of damage holds it to that. */
  refused: RecordsError|null;
}
export interface SpaceSearchIndex {
  missing(records:readonly string[],tx?:Transaction):Promise<ReadonlySet<string>>;
  /** Of these rows of a version, the ones that have their reference already, as `pathKey`; what a resumed build skips. */
  present(version:string,rows:readonly {path:string;entry:string}[],tx?:Transaction):Promise<ReadonlySet<string>>;
  /** The state of each scope, in order, in one statement that reads no document: the only thing a search asks. */
  states(scopes:readonly SpaceIndexScope[],tx?:Transaction):Promise<SpaceIndexState[]>;
  /** Counts the version's references against its ready row and repairs the counter of a damaged one: a build's check, never a search's. */
  ready(version: string, path: string, tx?: Transaction): Promise<boolean>;
  complete(version: string, path: string, tx?: Transaction): Promise<void>;
  /** Remembers the limit a build of this version passed: `states` reports it until the limit rises. */
  refuse(version:string,quotaSpace:string,error:RecordsError,tx?:Transaction):Promise<void>;
  /** The document of a text, for a caller that tokenizes outside the transaction of `add`. */
  document(text:string):SpaceSearchDocument;
  add(version: string, rows: Array<Omit<SpaceSearchRow, 'version'> & {
    text?: string;
    document?: SpaceSearchDocument;
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
/** The key of a row in what `present` returns. */
export const pathKey=(row:{path:string;entry:string}):string=>row.path+'\0'+row.entry;
export class PgSpaceSearchIndex implements SpaceSearchIndex {
  #db: Database;#entryBytes:number;#spaceBytes:number;#productBytes:number;
  constructor(db: Database,limits:{entryBytes?:number;spaceBytes?:number;productBytes?:number}={}) { this.#db = db;this.#entryBytes=limits.entryBytes??MAX_ENTRY_INDEX_BYTES;this.#spaceBytes=limits.spaceBytes??MAX_SPACE_INDEX_BYTES;this.#productBytes=limits.productBytes??MAX_PRODUCT_INDEX_BYTES;if(![this.#entryBytes,this.#spaceBytes,this.#productBytes].every(value=>Number.isSafeInteger(value)&&value>0))throw new TypeError('index limits must be positive bytes'); }
  #limit(quotaSpace:string):number{return quotaSpace.startsWith(PRODUCT_QUOTA_PREFIX)?this.#productBytes:this.#spaceBytes;}
  #passed(quotaSpace:string):RecordsError{const bytes=this.#limit(quotaSpace);return quotaSpace.startsWith(PRODUCT_QUOTA_PREFIX)?productLimit(bytes):spaceLimit(bytes);}
  #entryPassed(quotaSpace:string):RecordsError{return quotaSpace.startsWith(PRODUCT_QUOTA_PREFIX)?productEntryLimit(this.#entryBytes):entryLimit(this.#entryBytes);}
  async missing(records:readonly string[],tx?:Transaction):Promise<ReadonlySet<string>>{
    if(!records.length)return new Set();
    // The ones absent, not the ones there: a new version of a large product shares nearly all its documents.
    const rows=await this.#db.query<{record:string}>('SELECT w.record FROM unnest($1::text[]) AS w(record) WHERE NOT EXISTS(SELECT 1 FROM knowledge_space_search_documents d WHERE d.record=w.record)',[records],tx);
    return new Set(rows.rows.map(row=>row.record));
  }
  async present(version:string,rows:readonly {path:string;entry:string}[],tx?:Transaction):Promise<ReadonlySet<string>>{
    if(!rows.length)return new Set();
    const found=await this.#db.query<{path:string;entry:string}>(`SELECT s.path,s.entry FROM unnest($2::text[],$3::text[]) AS w(path,entry)
      JOIN knowledge_space_search s ON s.version=$1 AND s.path=w.path AND s.entry=w.entry`,[version,rows.map(row=>row.path),rows.map(row=>row.entry)],tx);
    return new Set(found.rows.map(pathKey));
  }
  async states(scopes:readonly SpaceIndexScope[],tx?:Transaction):Promise<SpaceIndexState[]>{
    if(!scopes.length)return [];
    const found=await this.#db.query<{ready:boolean;space_bytes:string|null;entry_bytes:string|null}>(`SELECT r.version IS NOT NULL AS ready,t.refused_space_bytes::text AS space_bytes,t.refused_entry_bytes::text AS entry_bytes
      FROM unnest($1::text[],$2::text[],$3::text[]) WITH ORDINALITY AS w(version,path,quota_space,n)
      LEFT JOIN knowledge_space_search_ready r ON r.version=w.version AND r.path=w.path
      LEFT JOIN knowledge_space_search_totals t ON t.version=w.version AND t.quota_space=w.quota_space ORDER BY w.n`,[scopes.map(scope=>scope.version),scopes.map(scope=>scope.path),scopes.map(scope=>scope.quotaSpace)],tx);
    return found.rows.map((row,at)=>{
      // A limit that rose since ends the refusal without any write: the next round simply builds on.
      const quota=scopes[at].quotaSpace,entry=row.entry_bytes!==null&&Number(row.entry_bytes)>=this.#entryBytes,space=row.space_bytes!==null&&Number(row.space_bytes)>=this.#limit(quota);
      return {ready:row.ready,refused:entry?this.#entryPassed(quota):space?this.#passed(quota):null};
    });
  }
  async refuse(version:string,quotaSpace:string,error:RecordsError,tx?:Transaction):Promise<void>{
    const detail=error.detail as {space_limit_bytes?:number;entry_limit_bytes?:number}|null|undefined;
    await this.#db.query(`INSERT INTO knowledge_space_search_totals(quota_space,version,token_bytes,refused_space_bytes,refused_entry_bytes) VALUES($1,$2,0,$3,$4)
      ON CONFLICT(quota_space,version) DO UPDATE SET refused_space_bytes=EXCLUDED.refused_space_bytes,refused_entry_bytes=EXCLUDED.refused_entry_bytes`,[quotaSpace,version,detail?.space_limit_bytes??null,detail?.entry_limit_bytes??null],tx);
  }
  document(text:string):SpaceSearchDocument{
    const tokens=knowledgeTokens(text,this.#entryBytes);
    return {tokens,bytes:64+tokens.reduce((sum,token)=>sum+Buffer.byteLength(token)+4,0)};
  }
  /** In record order, so that two writers meet on the same keys in the same order, and in bounded multi-row statements. */
  async #putDocuments(documents:ReadonlyMap<string,SpaceSearchDocument>,tx:Transaction):Promise<void>{
    const records=[...documents.keys()].sort();
    for(let at=0;at<records.length;){
      const chunk=[];let bytes=0;
      for(;at<records.length&&chunk.length<STATEMENT_ROWS;at++){
        const document=documents.get(records[at])!;
        if(chunk.length&&bytes+document.bytes>STATEMENT_BYTES)break;
        bytes+=document.bytes;chunk.push({record:records[at],tokens:document.tokens,token_bytes:document.bytes});
      }
      await this.#db.query(`INSERT INTO knowledge_space_search_documents(record,tokens,token_bytes)
        SELECT r.record,r.tokens,r.token_bytes FROM jsonb_to_recordset($1::jsonb) AS r(record text,tokens text[],token_bytes bigint) ON CONFLICT DO NOTHING`,[JSON.stringify(chunk)],tx);
    }
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
  async add(version:string,rows:Array<Omit<SpaceSearchRow,'version'>&{text?:string;document?:SpaceSearchDocument}>,tx?:Transaction,quotaSpace?:string):Promise<void>{
    if(!rows.length)return;
    await this.#db.transaction(async transaction=>{
      const scopes=[...new Set(rows.map(row=>quotaSpace??row.space))].sort();
      for(const scope of scopes)await this.#db.query('SELECT pg_advisory_xact_lock($1, hashtext($2))',[SPACE_INDEX_LOCK_SPACE,scope],transaction);
      // A row that brings its document needs no look: the insert leaves one that exists. Text is tokenized only when it must be.
      const records=[...new Set(rows.map(row=>row.record))],missing=await this.missing([...new Set(rows.filter(row=>row.document===undefined).map(row=>row.record))],transaction),documents=new Map<string,SpaceSearchDocument>();
      for(const row of rows){
        if(documents.has(row.record)||row.document===undefined&&!missing.has(row.record))continue;
        if(row.document===undefined&&row.text===undefined)throw new RecordsError('缺少待重建的知识搜索内容');
        const document=row.document??this.document(row.text!);
        if(document.bytes>this.#entryBytes)throw entryLimit(this.#entryBytes);
        documents.set(row.record,document);
      }
      await this.#putDocuments(documents,transaction);
      const largest=await this.#db.query<{bytes:string}>('SELECT COALESCE(max(token_bytes),0)::text AS bytes FROM knowledge_space_search_documents WHERE record=ANY($1::text[])',[records],transaction);
      if(Number(largest.rows[0].bytes)>this.#entryBytes)throw entryLimit(this.#entryBytes);
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
        const passed=totals.rows.find(row=>Number(row.bytes)>this.#limit(row.quota_space));
        if(passed)throw this.#passed(passed.quota_space);
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
