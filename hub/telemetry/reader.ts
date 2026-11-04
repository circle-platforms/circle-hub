// Reads of trace_spans, with the permission rule of B08 R[4]: an administrator sees every trace, a member only the rows of
// their own calls, steps and usage included. The stored account decides, not the Principal a session kept; a trace a reader
// may not see and a trace that does not exist look the same. A client may reuse a trace id, so the rule holds per row: a
// member reading a shared id sees their own rows of it and no others.
import type { Environment, StepLevel, StepType, TraceOrigin } from '../../contracts/generated/vocabulary.ts';
import type { Principal } from '../records/api.ts';
import { iso, normalizeTime, pageLimit, type Database, type Row } from '../records/db.ts';
import type { UsageName } from './names.ts';
import type { Usage } from './usage.ts';

const TRACE = /^[0-9a-f]{32}$/;
const USER_ID = /^usr_[0-9a-z]{26}$/;
/** The most steps one read shows; a client reusing a trace id could make it arbitrarily long. */
export const MAX_SHOWN_STEPS = 5000;
const COLUMNS = 'trace_id, span_id, parent_span_id, is_root, name, type, started_at, ended_at, level, status_message, origin, user_id, session_id, run_id, client_name, client_version, release, environment, usage';

export interface TraceStep {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  is_root: boolean;
  name: string;
  type: StepType;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  level: StepLevel;
  status_message: string | null;
  origin: TraceOrigin;
  user_id: string | null;
  session_id: string | null;
  run_id: string | null;
  client_name: string | null;
  client_version: string | null;
  release: string | null;
  environment: Environment | null;
  usage: Usage;
}

export interface TraceNode extends TraceStep {
  children: TraceNode[];
}

export interface TraceListQuery {
  origin?: TraceOrigin;
  name?: string;
  /** Only this account's traces; a member asking for another account's gets nothing. */
  userId?: string;
  since?: string;
  minMs?: number;
  limit?: number;
}

export interface TraceDetail {
  trace_id: string;
  /** Usually one; several when a client sent the same trace id with several requests. */
  roots: TraceNode[];
  /** The trace has more steps than MAX_SHOWN_STEPS: the latest are left out. */
  truncated: boolean;
}

export interface TraceTotal {
  origin: TraceOrigin;
  name: string;
  count: number;
  total_ms: number;
  /** The sum of the usage asked for. */
  total: number;
  db_rows: number;
  db_bytes: number;
}

export interface TraceTopQuery {
  by: UsageName;
  since: string;
  limit?: number;
}

function stepOf(row: Row): TraceStep {
  const started = iso(row.started_at);
  const ended = iso(row.ended_at);
  return {
    trace_id: String(row.trace_id),
    span_id: String(row.span_id),
    parent_span_id: row.parent_span_id === null ? null : String(row.parent_span_id),
    is_root: row.is_root === true,
    name: String(row.name),
    type: row.type as StepType,
    started_at: started,
    ended_at: ended,
    duration_ms: Date.parse(ended) - Date.parse(started),
    level: row.level as StepLevel,
    status_message: row.status_message === null ? null : String(row.status_message),
    origin: row.origin as TraceOrigin,
    user_id: row.user_id === null ? null : String(row.user_id),
    session_id: row.session_id === null ? null : String(row.session_id),
    run_id: row.run_id === null ? null : String(row.run_id),
    client_name: row.client_name === null ? null : String(row.client_name),
    client_version: row.client_version === null ? null : String(row.client_version),
    release: row.release === null ? null : String(row.release),
    environment: row.environment as Environment | null,
    usage: row.usage as Usage,
  };
}

/** The steps as trees: a step whose parent is not among them (a root, or a row a member may not see the parent of) starts one. */
function treeOf(steps: readonly TraceStep[]): TraceNode[] {
  const nodes = new Map(steps.map((step) => [step.span_id, { ...step, children: [] as TraceNode[] }]));
  const roots: TraceNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.is_root || node.parent_span_id === null ? undefined : nodes.get(node.parent_span_id);
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
  }
  return roots;
}

export class TraceReader {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async #viewer(principal: Principal): Promise<{ id: string; admin: boolean } | null> {
    const id = typeof principal?.id === 'string' && USER_ID.test(principal.id) ? principal.id : null;
    if (id === null) return null;
    const row = (await this.#db.query('SELECT id, role, disabled FROM users WHERE id = $1', [id])).rows[0];
    return row === undefined || row.disabled === true ? null : { id: String(row.id), admin: row.role === 'admin' };
  }

  /** Traces, newest first: their root steps, whose usage is the whole trace's. */
  async list(principal: Principal, query: TraceListQuery = {}): Promise<TraceStep[]> {
    const viewer = await this.#viewer(principal);
    if (viewer === null) return [];
    if (!viewer.admin && query.userId !== undefined && query.userId !== viewer.id) return [];
    const values: unknown[] = [];
    const conditions = ['is_root'];
    const add = (sql: string, value: unknown): void => {
      values.push(value);
      conditions.push(sql.replace('?', `$${values.length}`));
    };
    const user = viewer.admin ? query.userId : viewer.id;
    if (user !== undefined) add('user_id = ?', user);
    if (query.origin !== undefined) add('origin = ?', query.origin);
    if (query.name !== undefined) add('name = ?', query.name);
    if (query.since !== undefined) add('started_at >= ?', normalizeTime(query.since, 'since'));
    if (query.minMs !== undefined) add(`ended_at - started_at >= ?::double precision * interval '1 millisecond'`, query.minMs);
    values.push(pageLimit(query.limit));
    const rows = await this.#db.query(`SELECT ${COLUMNS} FROM trace_spans WHERE ${conditions.join(' AND ')} ORDER BY started_at DESC LIMIT $${values.length}`, values);
    return rows.rows.map(stepOf);
  }

  /** One trace's step tree with its usage, or null when it does not exist or the reader may not see it. */
  async show(principal: Principal, traceId: string): Promise<TraceDetail | null> {
    if (typeof traceId !== 'string' || !TRACE.test(traceId)) return null;
    const viewer = await this.#viewer(principal);
    if (viewer === null) return null;
    const values: unknown[] = [traceId, MAX_SHOWN_STEPS + 1];
    if (!viewer.admin) values.push(viewer.id);
    const rows = (await this.#db.query(`SELECT ${COLUMNS} FROM trace_spans WHERE trace_id = $1 ${viewer.admin ? '' : 'AND user_id = $3'} ORDER BY started_at, ended_at DESC LIMIT $2`, values)).rows;
    if (rows.length === 0) return null;
    return { trace_id: traceId, roots: treeOf(rows.slice(0, MAX_SHOWN_STEPS).map(stepOf)), truncated: rows.length > MAX_SHOWN_STEPS };
  }

  /**
   * Totals per step name since a time, the largest first. A step's usage includes its children's, so the lines of one trace
   * overlap: each line is what that name cost, and they do not add up.
   */
  async top(principal: Principal, query: TraceTopQuery): Promise<TraceTotal[]> {
    const viewer = await this.#viewer(principal);
    if (viewer === null) return [];
    const values: unknown[] = [normalizeTime(query.since, 'since'), query.by, pageLimit(query.limit)];
    if (!viewer.admin) values.push(viewer.id);
    const number = (name: string): string => `coalesce(sum((usage->>${name})::double precision), 0)`;
    const rows = await this.#db.query(
      `SELECT origin, name, count(*)::bigint AS count, coalesce(sum(extract(epoch FROM ended_at - started_at) * 1000), 0)::double precision AS total_ms,
              ${number('$2')} AS total, ${number(`'db.rows'`)} AS db_rows, ${number(`'db.bytes'`)} AS db_bytes
         FROM trace_spans WHERE started_at >= $1 AND type <> 'event' ${viewer.admin ? '' : 'AND user_id = $4'}
        GROUP BY origin, name ORDER BY total DESC, total_ms DESC, name LIMIT $3`,
      values,
    );
    return rows.rows.map((row) => ({
      origin: row.origin as TraceOrigin,
      name: String(row.name),
      count: Number(row.count),
      total_ms: Number(row.total_ms),
      total: Number(row.total),
      db_rows: Number(row.db_rows),
      db_bytes: Number(row.db_bytes),
    }));
  }
}
