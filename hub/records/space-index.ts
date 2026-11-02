// Rebuildable full-text projection of immutable space versions. Callers pass authorized version/path scopes before paging.
import type { Transaction } from './api.ts';
import type { Database } from './db.ts';
export interface SpaceSearchRow {
  space: string;
  version: string;
  path: string;
  entry: string;
  record: string;
}
export interface SpaceSearchIndex {
  ready(version: string, path: string, tx?: Transaction): Promise<boolean>;
  complete(version: string, path: string, tx?: Transaction): Promise<void>;
  add(version: string, rows: Array<Omit<SpaceSearchRow, 'version'> & {
    text: string;
  }>, tx?: Transaction): Promise<void>;
  search(text: string, scopes: Array<{
    version: string;
    paths: string[];
  }>, offset: number, limit: number): Promise<SpaceSearchRow[]>;
}
/** Adjacent Unicode character pairs within each word; isolated one-character words retain their token. */
export function knowledgeTokens(text: string): string[] {
  const out = new Set<string>();
  for (const word of text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
    const chars = [...word];
    if (chars.length === 1)
      out.add(word);
    else
      for (let i = 0; i < chars.length - 1; i++)
        out.add(chars[i] + chars[i + 1]);
  }
  return [...out].sort();
}
export class PgSpaceSearchIndex implements SpaceSearchIndex {
  #db: Database;
  constructor(db: Database) { this.#db = db; }
  async ready(version: string, path: string, tx?: Transaction) { return (await this.#db.query(`SELECT 1 FROM knowledge_space_search_ready r WHERE version=$1 AND path=$2 AND row_count=(SELECT count(*) FROM knowledge_space_search s WHERE s.version=$1 AND ($2='/' OR s.path=$2 OR starts_with(s.path,$2||'/')))`, [version, path], tx)).rows.length > 0; }
  async complete(version: string, path: string, tx?: Transaction) { await this.#db.query(`INSERT INTO knowledge_space_search_ready(version,path,row_count) SELECT $1,$2,count(*) FROM knowledge_space_search s WHERE s.version=$1 AND ($2='/' OR s.path=$2 OR starts_with(s.path,$2||'/')) ON CONFLICT DO NOTHING`, [version, path], tx); }
  async add(version: string, rows: Array<Omit<SpaceSearchRow, 'version'> & {
    text: string;
  }>, tx?: Transaction): Promise<void> {
    for (const row of rows)
      await this.#db.query(`INSERT INTO knowledge_space_search(version,space,path,entry,record,tokens)
   VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [version, row.space, row.path, row.entry, row.record, knowledgeTokens(row.text)], tx);
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
   SELECT space,version,path,entry,record FROM knowledge_space_search s WHERE tokens @> $1::text[] AND EXISTS (
    SELECT 1 FROM jsonb_array_elements($2::jsonb) scope, jsonb_array_elements_text(scope->'paths') prefix
    WHERE scope->>'version'=s.version AND (prefix.value='/' OR s.path=prefix.value OR starts_with(s.path,prefix.value||'/'))
   ) ORDER BY space,path,entry OFFSET $3 LIMIT $4`, [tokens, JSON.stringify(scopes), offset, limit]);
    return result.rows;
  }
}
