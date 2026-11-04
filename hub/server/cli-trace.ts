// `circle-hub trace`: reads the traces (B08, decision 146), for administrators. list shows traces by their root step, show
// one trace's step tree with its usage, top the totals per step name, so a background loop that reads a lot ranks itself.
// Output is Chinese and made safe for a terminal; --json gives the same data. The rows hold no inputs or outputs.
import { parseArgs } from 'node:util';
import { TRACE_ORIGIN, isTraceOrigin, labelOf } from '../../contracts/generated/vocabulary.ts';
import type { HubConfig } from '../config/index.ts';
import type { Principal, User } from '../records/api.ts';
import { USAGE_NAMES, isUsageName, openTraceReader, type TraceNode, type TraceReader, type TraceStep, type UsageName } from '../telemetry/api.ts';
import { jsonSafe } from './assemble/terminal.ts';
import { CliError, UsageError } from './errors.ts';

export const TRACE_USAGE = `trace list [--origin ${TRACE_ORIGIN.join('|')}] [--name <名字>] [--user <用户>] [--since <ISO时间>] [--min-ms <毫秒>] [--limit <条数>] [--json] [--as <管理员>] | show <追踪号> [--json] [--as <管理员>] | top [--by <用量名>] [--since <ISO时间>] [--limit <条数>] [--json] [--as <管理员>]（默认按 db.rows 排最近 24 小时；一个步骤的用量含它的子步骤）`;

const DEFAULT_TOP: UsageName = 'db.rows';
const DAY_MS = 24 * 3600 * 1000;
const MAX_LIMIT = 500;

export interface TraceCommandSession {
  ctx: { io: { stdout(line: string): void } };
  out(line: string): void;
  config(): HubConfig;
  viewer(as: string | undefined): Promise<Principal>;
  user(nameOrId: string): Promise<User>;
  names(): Promise<Map<string, string>>;
}

type Flags = Record<string, { type: 'string' | 'boolean' }>;

function parse<T extends Flags>(args: readonly string[], options: T, positionals: number) {
  let parsed;
  try {
    parsed = parseArgs({ args: [...args], options: { json: { type: 'boolean' }, as: { type: 'string' }, ...options }, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (parsed.positionals.length !== positionals) throw new UsageError(`需要 ${positionals} 个参数，给了 ${parsed.positionals.length} 个`);
  return parsed;
}

function sinceOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new UsageError('--since 不是时间，例如 2026-11-04T08:00:00Z');
  return new Date(time).toISOString();
}

function limitOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > MAX_LIMIT) throw new UsageError(`--limit 要 1 到 ${MAX_LIMIT} 的整数`);
  return Number(value);
}

function minMsOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value)) throw new UsageError('--min-ms 要非负整数');
  return Number(value);
}

const plain = (value: number): string => String(Math.round(value * 1000) / 1000);

/** The usage in the order of the list, without what is zero. */
function usageText(step: TraceStep): string {
  return USAGE_NAMES.flatMap((name) => (step.usage[name] ? [`${name}=${plain(step.usage[name])}`] : [])).join(' ');
}

const levelText = (step: TraceStep): string => (step.level === 'default' ? '' : labelOf('step_level', step.level));

function listLine(step: TraceStep, names: ReadonlyMap<string, string>): string {
  const user = step.user_id === null ? '—' : names.get(step.user_id) ?? step.user_id;
  return [step.started_at, step.trace_id, labelOf('trace_origin', step.origin), step.name, `${plain(step.duration_ms)} 毫秒`, user, [levelText(step), step.status_message].filter(Boolean).join(' ') || '—', usageText(step) || '—'].join('\t');
}

function treeLines(node: TraceNode, depth: number, lines: string[]): void {
  const said = [levelText(node), node.status_message].filter(Boolean).join(' ');
  lines.push(`${'  '.repeat(depth)}${node.name}（${labelOf('step_type', node.type)}）${plain(node.duration_ms)} 毫秒${said ? `；${said}` : ''}${node.type === 'event' ? '' : `；${usageText(node) || '没有用量'}`}`);
  for (const child of node.children) treeLines(child, depth + 1, lines);
}

function rootHeader(root: TraceNode, names: ReadonlyMap<string, string>): string {
  const client = root.client_name === null ? null : `客户端声明 ${root.client_name}${root.client_version === null ? '' : ` ${root.client_version}`}${root.client_platform === null ? '' : `（${root.client_platform}）`}`;
  return [
    `入口 ${labelOf('trace_origin', root.origin)}`,
    `开始 ${root.started_at}`,
    root.user_id === null ? null : `用户 ${names.get(root.user_id) ?? root.user_id}`,
    root.session_id === null ? null : `会话 ${root.session_id}`,
    root.run_id === null ? null : `运行 ${root.run_id}`,
    client,
    root.release === null ? null : `发布 ${root.release}`,
    root.environment === null ? null : `环境 ${labelOf('environment', root.environment)}`,
  ].filter(Boolean).join('，');
}

async function withReader<T>(session: TraceCommandSession, read: (reader: TraceReader) => Promise<T>): Promise<T> {
  const { reader, close } = openTraceReader(session.config().database);
  try {
    return await read(reader);
  } finally {
    await close().catch(() => {});
  }
}

async function administrator(session: TraceCommandSession, as: string | undefined): Promise<Principal> {
  const viewer = await session.viewer(as);
  if (viewer.role !== 'admin') throw new CliError('只有管理员能读运行观测', '用管理员的操作令牌执行这一条命令');
  return viewer;
}

const json = (session: TraceCommandSession, value: unknown): number => {
  session.ctx.io.stdout(jsonSafe(JSON.stringify(value, null, 2)));
  return 0;
};

export async function traceCommand(session: TraceCommandSession, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === 'list') {
    const { values } = parse(rest, { origin: { type: 'string' }, name: { type: 'string' }, user: { type: 'string' }, since: { type: 'string' }, 'min-ms': { type: 'string' }, limit: { type: 'string' } }, 0);
    const origin = values.origin;
    if (origin !== undefined && !isTraceOrigin(origin)) throw new UsageError(`--origin 只能是 ${TRACE_ORIGIN.map((code) => `${code}（${labelOf('trace_origin', code)}）`).join('、')}`);
    const since = sinceOf(values.since);
    const limit = limitOf(values.limit);
    const minMs = minMsOf(values['min-ms']);
    const by = await administrator(session, values.as);
    const userId = values.user === undefined ? undefined : (await session.user(values.user)).id;
    const traces = await withReader(session, (reader) => reader.list(by, {
      ...(origin === undefined ? {} : { origin }),
      ...(values.name === undefined ? {} : { name: values.name }),
      ...(userId === undefined ? {} : { userId }),
      ...(since === undefined ? {} : { since }),
      ...(minMs === undefined ? {} : { minMs }),
      ...(limit === undefined ? {} : { limit }),
    }));
    if (values.json === true) return json(session, { traces });
    if (traces.length === 0) session.out('没有符合条件的追踪');
    const names = await session.names();
    for (const trace of traces) session.out(listLine(trace, names));
    return 0;
  }
  if (sub === 'show') {
    const { values, positionals } = parse(rest, {}, 1);
    const by = await administrator(session, values.as);
    const trace = await withReader(session, (reader) => reader.show(by, positionals[0]));
    if (trace === null) throw new CliError(`没有追踪 ${positionals[0]}`, '追踪号来自 trace list，诊断数据只保留 14 天');
    if (values.json === true) return json(session, trace);
    const names = await session.names();
    session.out(`追踪 ${trace.trace_id}`);
    for (const root of trace.roots) {
      session.out(rootHeader(root, names));
      const lines: string[] = [];
      treeLines(root, 0, lines);
      for (const line of lines) session.out(line);
    }
    if (trace.truncated) session.out('步骤太多，后面的没有显示');
    return 0;
  }
  if (sub === 'top') {
    const { values } = parse(rest, { by: { type: 'string' }, since: { type: 'string' }, limit: { type: 'string' } }, 0);
    const usage = values.by ?? DEFAULT_TOP;
    if (!isUsageName(usage)) throw new UsageError(`--by 只能是 ${USAGE_NAMES.join('、')}`);
    const since = sinceOf(values.since) ?? new Date(Date.now() - DAY_MS).toISOString();
    const limit = limitOf(values.limit);
    const by = await administrator(session, values.as);
    const totals = await withReader(session, (reader) => reader.top(by, { by: usage, since, ...(limit === undefined ? {} : { limit }) }));
    if (values.json === true) return json(session, { by: usage, since, totals });
    if (totals.length === 0) session.out(`${since} 以来没有追踪`);
    const asked = usage === 'db.rows' || usage === 'db.bytes' ? null : usage;
    for (const row of totals) session.out([labelOf('trace_origin', row.origin), row.name, `${row.count} 次`, `耗时 ${plain(row.total_ms)} 毫秒`, `db.rows=${plain(row.db_rows)}`, `db.bytes=${plain(row.db_bytes)}`, ...(asked === null ? [] : [`${asked}=${plain(row.total)}`])].join('\t'));
    return 0;
  }
  throw new UsageError('trace 的子命令是 list、show 或 top');
}
