// Reads of trace_spans, with the permission rule of B08 R[4]: an administrator sees every trace, a member only the rows of
// their own calls, steps and usage included. The stored account decides, not the Principal a session kept; a trace a reader
// may not see and a trace that does not exist look the same. A client may reuse a trace id, so the rule holds per row: a
// member reading a shared id sees their own rows of it and no others.
import { TRACE_ORIGIN, type Environment, type StepLevel, type StepType, type TraceOrigin } from '../../contracts/generated/vocabulary.ts';
import type { Principal } from '../records/api.ts';
import { iso, normalizeTime, pageLimit, type Database, type Row } from '../records/db.ts';
import { BACKGROUND_STEPS, type BackgroundStep, type UsageName } from './names.ts';
import type { Usage } from './usage.ts';

const TRACE = /^[0-9a-f]{32}$/;
const USER_ID = /^usr_[0-9a-z]{26}$/;
/** The most steps one read shows; a client reusing a trace id could make it arbitrarily long. */
export const MAX_SHOWN_STEPS = 5000;
const COLUMNS = 'trace_id, span_id, parent_span_id, is_root, name, type, started_at, ended_at, level, status_message, origin, user_id, session_id, run_id, client_name, client_version, client_platform, release, environment, usage';

/**
 * What one read of the 运行状况 page may go through. Traffic decides how many rows a window holds, so each aggregate reads the
 * newest of them up to these bounds and says when it stopped there: a page that reports on load must not add to it.
 */
export const MAX_ROUNDS_READ = 50_000;
export const MAX_ROOTS_READ = 50_000;
export const MAX_RELEASE_CALLS_READ = 10_000;

/** The bounds above; a test sets low ones to reach them with a few rows. */
export interface ReadBounds {
  rounds: number;
  roots: number;
  releaseCalls: number;
}
/** Entries a person connects through; a background round or a CLI command is no client. */
const CLIENT_ORIGINS: readonly TraceOrigin[] = TRACE_ORIGIN.filter((origin) => origin !== 'background' && origin !== 'cli');
/**
 * A live stream lasts as long as its page stays open, and serve-http is an exchange that is no call: any other path (a probe of
 * /healthz), or one on /mcp that gets no call-log line (names.ts). Decision 147: every other MCP root counts, whatever it asked.
 */
const NOT_CALLS = ['stream-console', 'serve-http'];

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
  client_platform: string | null;
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

/** One background task over a window, the root rows of its rounds only: their usage is the whole round's. */
export interface BackgroundTotal {
  name: BackgroundStep;
  /** Rounds that started in the window, at most MAX_ROUNDS_READ: the totals are of those. */
  rounds: number;
  /** The window held more rounds than were read. */
  capped: boolean;
  db_rows: number;
  db_bytes: number;
  /** The median gap between the starts of two rounds of the window: what a timer's period looks like; null with fewer than two. */
  gap_ms: number | null;
  /** The latest round within `retained`, inside or outside the window. */
  last_at: string;
  last_ms: number;
}

export interface BackgroundQuery {
  since: string;
  /** How far back the latest round is looked for: the retention, not the window. */
  retained: string;
}

export interface ClientTotal {
  origin: TraceOrigin;
  client_name: string | null;
  client_platform: string | null;
  /** The latest version the group declared. */
  client_version: string | null;
  calls: number;
  p95_ms: number;
}

export interface ClientTotals {
  rows: ClientTotal[];
  /** Groups the window holds; `rows` is the first `limit` of them. */
  groups: number;
  /** Calls the totals are of: the window's, or its newest MAX_ROOTS_READ. */
  calls: number;
  /** The window held more calls than were read. */
  capped: boolean;
  /** Start of the oldest call read. */
  oldest: string | null;
}

export interface ClientQuery {
  since: string;
  limit: number;
}

export interface ReleaseTotal {
  release: string;
  /** The run's newest MCP call within `retained`; null without one. */
  newest_at: string | null;
  /** MCP calls of the last `windowMs` of that run, at most MAX_RELEASE_CALLS_READ: the p95 is of those. */
  calls: number;
  /** That stretch held more calls than were read. */
  capped: boolean;
  p95_ms: number | null;
}

export interface ReleaseQuery {
  /** A release can run twice with another between, and only the time tells the calls of its runs apart. */
  runs: readonly { release: string; from: string; until: string | null }[];
  retained: string;
  /** The stretch of each run that counts, back from its newest call, so that two runs compare like with like. */
  windowMs: number;
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
    client_platform: row.client_platform === null ? null : String(row.client_platform),
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
  readonly #bounds: ReadBounds;

  constructor(db: Database, bounds: Partial<ReadBounds> = {}) {
    this.#db = db;
    this.#bounds = { rounds: MAX_ROUNDS_READ, roots: MAX_ROOTS_READ, releaseCalls: MAX_RELEASE_CALLS_READ, ...bounds };
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

  /**
   * What the background tasks cost: one row per task with a round in the retention, the largest reader first. Administrators
   * only, like everything below: a task belongs to nobody. Runs off trace_spans_root_names, one range per task.
   */
  async background(principal: Principal, query: BackgroundQuery): Promise<BackgroundTotal[]> {
    if ((await this.#viewer(principal))?.admin !== true) return [];
    const rows = await this.#db.query(
      `SELECT n.name, a.rounds, a.db_rows, a.db_bytes, a.gap_ms, l.started_at AS last_at, l.ms AS last_ms
         FROM unnest($1::text[]) AS n(name)
         JOIN LATERAL (
           SELECT t.started_at, extract(epoch FROM t.ended_at - t.started_at)::double precision * 1000 AS ms
             FROM trace_spans t WHERE t.is_root AND t.name = n.name AND t.started_at >= $3 ORDER BY t.started_at DESC LIMIT 1
         ) l ON true
         CROSS JOIN LATERAL (
           SELECT count(*)::bigint AS rounds, coalesce(sum((r.usage->>'db.rows')::double precision), 0) AS db_rows, coalesce(sum((r.usage->>'db.bytes')::double precision), 0) AS db_bytes,
                  percentile_disc(0.5) WITHIN GROUP (ORDER BY r.gap) AS gap_ms
             FROM (SELECT w.usage, extract(epoch FROM w.started_at - lag(w.started_at) OVER (ORDER BY w.started_at))::double precision * 1000 AS gap
                     FROM (SELECT t.usage, t.started_at FROM trace_spans t WHERE t.is_root AND t.name = n.name AND t.started_at >= $2 ORDER BY t.started_at DESC LIMIT $4) w) r
         ) a
        ORDER BY a.db_rows DESC, n.name`,
      [BACKGROUND_STEPS, normalizeTime(query.since, 'since'), normalizeTime(query.retained, 'retained'), this.#bounds.rounds],
    );
    return rows.rows.map((row) => ({
      name: row.name as BackgroundStep,
      rounds: Number(row.rounds),
      capped: Number(row.rounds) >= this.#bounds.rounds,
      db_rows: Number(row.db_rows),
      db_bytes: Number(row.db_bytes),
      gap_ms: row.gap_ms === null ? null : Number(row.gap_ms),
      last_at: iso(row.last_at),
      last_ms: Number(row.last_ms),
    }));
  }

  /** Calls by client and declared platform since a time, entry by entry, the most used first. Runs off trace_spans_roots. */
  async clients(principal: Principal, query: ClientQuery): Promise<ClientTotals> {
    if ((await this.#viewer(principal))?.admin !== true) return { rows: [], groups: 0, calls: 0, capped: false, oldest: null };
    const rows = (await this.#db.query(
      `WITH recent AS (
         SELECT origin, client_name, client_version, client_platform, started_at, extract(epoch FROM ended_at - started_at)::double precision * 1000 AS ms
           FROM trace_spans
          WHERE is_root AND started_at >= $1 AND origin = ANY($2::text[]) AND name <> ALL($3::text[])
          ORDER BY started_at DESC LIMIT $4
       ), totals AS (
         SELECT origin, client_name, client_platform, count(*)::bigint AS calls, percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) AS p95_ms,
                (array_agg(client_version ORDER BY started_at DESC) FILTER (WHERE client_version IS NOT NULL))[1] AS client_version
           FROM recent GROUP BY origin, client_name, client_platform
       )
       SELECT t.origin, t.client_name, t.client_platform, t.client_version, t.calls, t.p95_ms, count(*) OVER () AS groups, s.calls AS read, s.oldest
         FROM totals t CROSS JOIN (SELECT count(*)::bigint AS calls, min(started_at) AS oldest FROM recent) s
        ORDER BY array_position($2::text[], t.origin), sum(t.calls) OVER (PARTITION BY t.origin, t.client_name) DESC, t.client_name NULLS LAST, t.calls DESC, t.client_platform NULLS LAST
        LIMIT $5`,
      [normalizeTime(query.since, 'since'), CLIENT_ORIGINS, NOT_CALLS, this.#bounds.roots, pageLimit(query.limit)],
    )).rows;
    const first = rows[0];
    return {
      rows: rows.map((row) => ({
        origin: row.origin as TraceOrigin,
        client_name: row.client_name === null ? null : String(row.client_name),
        client_platform: row.client_platform === null ? null : String(row.client_platform),
        client_version: row.client_version === null ? null : String(row.client_version),
        calls: Number(row.calls),
        p95_ms: Number(row.p95_ms),
      })),
      groups: first === undefined ? 0 : Number(first.groups),
      calls: first === undefined ? 0 : Number(first.read),
      capped: first !== undefined && Number(first.read) >= this.#bounds.roots,
      oldest: first === undefined ? null : iso(first.oldest),
    };
  }

  /** The MCP calls of the given runs, each over its last stretch, in the order asked. Runs off trace_spans_mcp_releases. */
  async releases(principal: Principal, query: ReleaseQuery): Promise<ReleaseTotal[]> {
    if ((await this.#viewer(principal))?.admin !== true || query.runs.length === 0) return [];
    const rows = await this.#db.query(
      `SELECT r.release, n.newest_at, w.calls, w.p95_ms
         FROM unnest($1::text[], $6::timestamptz[], $7::timestamptz[]) WITH ORDINALITY AS r(release, began, until, position)
         LEFT JOIN LATERAL (
           SELECT t.started_at AS newest_at FROM trace_spans t
            WHERE t.is_root AND t.origin = 'mcp' AND t.release = r.release AND t.started_at >= $2 AND t.started_at >= r.began AND t.started_at < coalesce(r.until, 'infinity') AND t.name <> ALL($5::text[])
            ORDER BY t.started_at DESC LIMIT 1
         ) n ON true
         LEFT JOIN LATERAL (
           SELECT count(*)::bigint AS calls, percentile_cont(0.95) WITHIN GROUP (ORDER BY c.ms) AS p95_ms
             FROM (SELECT extract(epoch FROM t.ended_at - t.started_at)::double precision * 1000 AS ms FROM trace_spans t
                    WHERE t.is_root AND t.origin = 'mcp' AND t.release = r.release AND t.started_at >= $2 AND t.started_at >= r.began AND t.started_at < coalesce(r.until, 'infinity') AND t.name <> ALL($5::text[])
                      AND t.started_at > n.newest_at - $3::double precision * interval '1 millisecond'
                    ORDER BY t.started_at DESC LIMIT $4) c
         ) w ON true
        ORDER BY r.position`,
      [query.runs.map((run) => run.release), normalizeTime(query.retained, 'retained'), query.windowMs, this.#bounds.releaseCalls, NOT_CALLS, query.runs.map((run) => normalizeTime(run.from, 'from')), query.runs.map((run) => (run.until === null ? null : normalizeTime(run.until, 'until')))],
    );
    return rows.rows.map((row) => ({
      release: String(row.release),
      newest_at: row.newest_at === null ? null : iso(row.newest_at),
      calls: Number(row.calls),
      capped: Number(row.calls) >= this.#bounds.releaseCalls,
      p95_ms: row.p95_ms === null ? null : Number(row.p95_ms),
    }));
  }
}
