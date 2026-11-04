// `circle-hub db top`: the statements PostgreSQL spent the most on, from pg_stat_statements. The extension lives in the
// `postgres` maintenance database (postgres.ts), which the application role may not connect to, so this runs on the host
// through the superuser connector. pg_stat_statements keeps statements with their constants replaced by placeholders.
import { PlatformError } from './errors.ts';
import type { PostgresControl } from './postgres.ts';
import { withSession } from './sql.ts';

/** `--by`: what each order means in pg_stat_statements. */
export const STATEMENT_ORDERS = { total_ms: 'total_exec_time', rows: 'rows', calls: 'calls' } as const;
export type StatementOrder = keyof typeof STATEMENT_ORDERS;
export const isStatementOrder = (value: string): value is StatementOrder => Object.hasOwn(STATEMENT_ORDERS, value);
export const DEFAULT_TOP_LIMIT = 20;
const QUERY_CHARACTERS = 300;
/** object_not_in_prerequisite_state: the view exists, but the library was not preloaded when PostgreSQL started. */
const NOT_LOADED = '55000';

export interface TopStatement {
  calls: number;
  rows: number;
  total_ms: number;
  mean_ms: number;
  /** Shared blocks found in the cache and read from disk. */
  blocks_hit: number;
  blocks_read: number;
  query: string;
}

export type TopStatements = { available: true; statements: TopStatement[] } | { available: false; reason: string; hint: string };

const MISSING: TopStatements = {
  available: false,
  reason: 'postgres 维护库里没有 pg_stat_statements 扩展，读不到语句统计',
  hint: '这个发布的 PostgreSQL 二进制没有带这个模块时就是这样；带了的话重启数据库后会自动建好：circle-hub db stop，然后 circle-hub db start',
};
const NOT_PRELOADED: TopStatements = {
  available: false,
  reason: 'pg_stat_statements 扩展在，但 PostgreSQL 启动时没有预加载它，读不到语句统计',
  hint: '重启数据库后生效：circle-hub db stop，然后 circle-hub db start',
};

export async function topStatements(control: Pick<PostgresControl, 'connector' | 'status' | 'target'>, by: StatementOrder, limit: number): Promise<TopStatements> {
  if (!(await control.status()).running) throw new PlatformError('数据库没在运行，读不到语句统计', '先运行 circle-hub db start');
  return withSession(control.connector, 'postgres', async (session) => {
    const [found] = await session.query("SELECT pg_catalog.to_regclass('public.pg_stat_statements') IS NOT NULL AS installed");
    if (found?.installed !== true) return MISSING;
    try {
      const rows = await session.query(
        `SELECT s.calls::pg_catalog.text AS calls,s.rows::pg_catalog.text AS rows,s.total_exec_time AS total_ms,s.mean_exec_time AS mean_ms,
                s.shared_blks_hit::pg_catalog.text AS blocks_hit,s.shared_blks_read::pg_catalog.text AS blocks_read,
                pg_catalog.left(pg_catalog.regexp_replace(s.query,'\\s+',' ','g'),${QUERY_CHARACTERS}) AS query
           FROM public.pg_stat_statements s JOIN pg_catalog.pg_database d ON d.oid=s.dbid
          WHERE d.datname=$1
          ORDER BY s.${STATEMENT_ORDERS[by]} DESC LIMIT $2`,
        [control.target.database, limit],
      );
      return {
        available: true,
        statements: rows.map((row) => ({
          calls: Number(row.calls),
          rows: Number(row.rows),
          total_ms: Number(row.total_ms),
          mean_ms: Number(row.mean_ms),
          blocks_hit: Number(row.blocks_hit),
          blocks_read: Number(row.blocks_read),
          query: String(row.query),
        })),
      };
    } catch (error) {
      if ((error as { code?: unknown }).code === NOT_LOADED) return NOT_PRELOADED;
      throw error;
    }
  });
}

const ORDER_TEXT: Readonly<Record<StatementOrder, string>> = { total_ms: '累计耗时', rows: '读出行数', calls: '调用次数' };

export function statementLines(database: string, by: StatementOrder, statements: readonly TopStatement[]): string[] {
  if (statements.length === 0) return [`数据库 ${database} 还没有语句统计`];
  return [
    `数据库 ${database} 按${ORDER_TEXT[by]}排序的前 ${statements.length} 条语句（统计从 PostgreSQL 的统计重置算起，常量已换成占位符）：`,
    ...statements.flatMap((statement, index) => {
      const blocks = statement.blocks_hit + statement.blocks_read;
      const hit = blocks === 0 ? '未读块' : `缓存命中 ${((statement.blocks_hit / blocks) * 100).toFixed(1)}%`;
      return [`${index + 1}. 累计 ${statement.total_ms.toFixed(1)} 毫秒，调用 ${statement.calls} 次，平均 ${statement.mean_ms.toFixed(2)} 毫秒，读出 ${statement.rows} 行，${hit}`, `   ${statement.query}`];
    }),
  ];
}
