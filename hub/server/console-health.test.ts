// The 运行状况 page on a temporary PostgreSQL with synthetic rows: who may open it, what it shows, what it says when it does not
// know, and that it stays the same few bounded reads however much the tables hold. No test asserts a duration.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { parse, serialize, type DefaultTreeAdapterMap } from 'parse5';
import type pg from 'pg';
import { openConsole, type ConsoleClient } from '../../tests/acceptance/support/console.ts';
import { healthReader } from '../health/api.ts';
import type { Transaction } from '../records/api.ts';
import { Database, createPool, type Row } from '../records/db.ts';
import { TraceReader, installTraceSink, type SpanRow, type WriterStats } from '../telemetry/api.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { createApp } from './app.ts';
import type { HealthPageSources } from './console/health.ts';
import { wordingProblems } from './console/testing-wording.ts';
import { createTestServer, type TestServer, type TestUser } from './testing.ts';

const NOW = new Date('2026-11-04T08:02:30.000Z');
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const CURRENT = 'aaaaaaaaaaaa';
const PREVIOUS = 'bbbbbbbbbbbb';
const OLDEST = 'cccccccccccc';
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const CRASH = NOW.getTime() - 4 * HOUR_MS;
const iso = (ms: number): string => new Date(ms).toISOString();

let postgres: TemporaryPostgres;
before(async () => { postgres = await startPostgres(); });
after(() => postgres?.stop());

/** The page's reads, each statement with what it returned. */
class RecordingDatabase extends Database {
  readonly statements: { text: string; rows: number }[] = [];
  override async query<R extends Row = Row>(text: string, values: readonly unknown[] = [], tx?: Transaction): Promise<pg.QueryResult<R>> {
    const result = await super.query<R>(text, values, tx);
    this.statements.push({ text, rows: result.rows.length });
    return result;
  }
}

interface World {
  server: TestServer;
  /** What the test writes with. */
  db: Database;
  page: RecordingDatabase;
  admin: ConsoleClient;
  memberUser: TestUser;
  member: ConsoleClient;
  logs: string[];
}

const WRITER: WriterStats = { queued: 38, written: 21_364, dropped: 0, failed: 0, writeDelayP95Ms: 5140, lastBatchMs: 22 };

async function world(t: TestContext, sources: (page: RecordingDatabase) => Partial<HealthPageSources> = () => ({})): Promise<World> {
  const server = await createTestServer({ postgres, now: () => NOW });
  t.after(() => server.close());
  const db = new Database(createPool(server.records.database, 2));
  t.after(() => db.end());
  const page = new RecordingDatabase(createPool(server.records.database, 1));
  t.after(() => page.end());
  await writeFile(join(server.records.dataDir, 'release.json'), JSON.stringify({ schema: 'circle-hub-release@1', id: CURRENT }));
  const logs: string[] = [];
  const observation: HealthPageSources = { health: healthReader(page), traces: new TraceReader(page), writer: () => WRITER, ...sources(page) };
  const app = createApp(server.deps, { codeRoot: server.records.dataDir, log: (line) => logs.push(line), observation });
  t.after(() => app.close());
  const { port } = await app.listen();
  const memberUser = await server.createUser('合成成员');
  return { server, db, page, logs, memberUser, admin: await openConsole({ port }, server.admin.token), member: await openConsole({ port }, memberUser.token) };
}

// ---------------------------------------------------------------- synthetic rows

/** `perInterval` samples in each 5 minutes (or `step` seconds apart) back from `end`, the same values throughout. */
async function samples(db: Database, perInterval: number, boot = 'boot-now', end = NOW.getTime(), intervals = 288, step = 300 / perInterval): Promise<void> {
  await db.query(
    `INSERT INTO resource_samples(sampled_at,boot,interval_ms,process_cpu_ratio,event_loop_utilization,event_loop_delay_p99_ms,event_loop_delay_max_ms,heap_used_bytes,heap_limit_bytes,rss_bytes,gc_pause_ms,sandbox_running,sandbox_limit,sandbox_waiting,sandbox_timeouts,sandbox_queue_full,pool_limit,pool_total,pool_idle,pool_waiting,pool_connection_failures,pg_active_connections,pg_cache_hit_ratio,pg_waiting_locks,pg_deadlocks,data_free_bytes,io_wait_ratio,mcp_sessions,mcp_sessions_by_client,console_streams,requests_in_flight)
     SELECT $1::timestamptz-(i*$2::double precision*interval '1 second'),$3,10000,0.62,0.41,38,120,1009000000,2147483648,1396000000,46,2,8,0,1,0,10,7,4,0,0,5,0.994,0,0,442000000000,0.012,4,'{"client-one":3}',6,3
       FROM generate_series(0,$4::int-1) AS g(i)`,
    [iso(end), step, boot, intervals * perInterval],
  );
}

interface EventRow { at: number; kind: 'start' | 'stop' | 'abnormal_exit'; boot: string | null; release?: string | null; uptime?: number | null; last?: number | null; requests?: unknown; omitted?: number; reports?: unknown }
const event = (db: Database, row: EventRow) => db.query(
  'INSERT INTO process_events(at,kind,boot,pid,release,node_version,heap_limit_bytes,uptime_ms,last_seen_at,requests,requests_omitted,reports) VALUES($1,$2,$3,4242,$4,$5,2147483648,$6,$7,$8,$9,$10)',
  [iso(row.at), row.kind, row.boot, row.release ?? null, 'v24.0.0', row.uptime ?? null, row.last === undefined || row.last === null ? null : iso(row.last), row.requests === undefined ? null : JSON.stringify(row.requests), row.omitted ?? 0, row.reports === undefined ? null : JSON.stringify(row.reports)],
);

const REPORT = { file: 'report.20261104.040230.4242.0.001.json', readable: true, event: 'Allocation failed - JavaScript heap out of memory', trigger: 'OOMError', dumped_at: iso(CRASH), pid: 4242, node_version: 'v24.0.0', heap: { used_bytes: 2_100_000_000, total_bytes: 2_147_000_000, available_bytes: 1000, limit_bytes: 2_147_483_648 }, resource_usage: { rss_bytes: 2_400_000_000, max_rss_bytes: 2_400_000_000, user_cpu_seconds: 512.25, kernel_cpu_seconds: 38.5, free_memory_bytes: 1000, available_memory_bytes: 1000, total_memory_bytes: 1000 } };

/** Starts of older processes, then the crash and the start after it: newest last, as they happened. */
async function events(db: Database, w: Pick<World, 'server' | 'memberUser'>, older: number): Promise<void> {
  await db.query(
    `INSERT INTO process_events(at,kind,boot,pid,release,node_version,heap_limit_bytes) SELECT $1::timestamptz-i*interval '1 minute','start','boot-older-'||i,4242,$2,'v24.0.0',2147483648 FROM generate_series(1,$3::int) AS g(i)`,
    [iso(NOW.getTime() - 6 * DAY_MS), OLDEST, older],
  );
  await event(db, { at: NOW.getTime() - 2 * DAY_MS, kind: 'start', boot: 'boot-previous', release: PREVIOUS });
  await event(db, { at: NOW.getTime() - DAY_MS, kind: 'stop', boot: 'boot-previous', release: PREVIOUS, uptime: DAY_MS });
  await event(db, { at: NOW.getTime() - DAY_MS + MINUTE_MS, kind: 'start', boot: 'boot-crashed', release: CURRENT });
  await event(db, {
    at: CRASH + 24_000, kind: 'abnormal_exit', boot: 'boot-crashed', release: CURRENT, uptime: 20 * HOUR_MS, last: CRASH, reports: [REPORT],
    requests: [
      { trace: null, origin: 'console', name: 'GET /console/overview', user: w.server.admin.user.id, started_at: iso(CRASH - 175_000) },
      { trace: TRACE, origin: 'mcp', name: 'get_nodes', user: w.memberUser.user.id, started_at: iso(CRASH - 15_000) },
    ],
  });
  await event(db, { at: CRASH + 25_000, kind: 'start', boot: 'boot-now', release: CURRENT });
}

interface Roots { name: string; origin?: string; n: number; every: number; ms?: number; end?: number; client?: string | null; version?: string | null; platform?: string | null; release?: string | null; rows?: number; bytes?: number; steps?: boolean }
function roots(db: Database, row: Roots) {
  return db.query(
    `INSERT INTO trace_spans(trace_id,span_id,is_root,name,type,started_at,ended_at,level,origin,client_name,client_version,client_platform,release,usage)
     SELECT md5(random()::text),substr(md5(random()::text),1,16),$1,$2,'span',at,at+$3::double precision*interval '1 millisecond','default',$4,$5,$6,$7,$8,jsonb_build_object('db.rows',$9::double precision,'db.bytes',$10::double precision)
       FROM (SELECT $11::timestamptz-(i*$12::double precision*interval '1 millisecond') AS at FROM generate_series(0,$13::int-1) AS g(i)) s`,
    [row.steps !== true, row.name, row.ms ?? 10, row.origin ?? 'mcp', row.client ?? null, row.version ?? null, row.platform ?? null, row.release ?? null, row.rows ?? 0, row.bytes ?? 0, iso(row.end ?? NOW.getTime() - 1000), row.every, row.n],
  );
}

/** The traces of a day: every background task, the clients and three releases; `scale` multiplies them all. */
async function traces(db: Database, scale: number): Promise<void> {
  const within = (n: number): number => Math.floor((20 * HOUR_MS) / (n * scale));
  const rows: Roots[] = [
    { name: 'maintain-runs', origin: 'background', n: 12 * scale, every: 60_000 / scale, ms: 11_000, rows: 88_412, bytes: 25_000_000, release: CURRENT },
    { name: 'poll-console', origin: 'background', n: 12 * scale, every: 2000 / scale, ms: 8, rows: 62, bytes: 18_000, release: CURRENT },
    { name: 'project-document', origin: 'background', n: 3 * scale, every: within(3), ms: 6800, rows: 1204, bytes: 3_000_000 },
    { name: 'purge-traces', origin: 'background', n: 4 * scale, every: 3_600_000 / scale, ms: 240 },
    { name: 'get_nodes', n: 12 * scale, every: within(12), ms: 2400, client: 'client-one', version: '1.0', platform: 'os-one', release: CURRENT },
    { name: 'get_nodes', n: 12 * scale, every: within(12), ms: 2200, client: 'client-one', version: '1.0', platform: 'os-two', release: CURRENT },
    { name: 'get_nodes', n: 12 * scale, every: within(12), ms: 1200, client: 'client-two', version: '2.0', release: CURRENT },
    { name: 'list-tools', n: 6 * scale, every: within(6), ms: 300, release: CURRENT },
    { name: 'sync-state', origin: 'sync', n: 12 * scale, every: within(12), ms: 100, client: 'client-one', version: '1.0', platform: 'os-one', release: CURRENT },
    { name: 'serve-overview', origin: 'console', n: 12 * scale, every: within(12), ms: 200, release: CURRENT },
    { name: 'get_nodes', n: 12 * scale, every: within(12), ms: 900, end: NOW.getTime() - DAY_MS - HOUR_MS, client: 'client-one', version: '0.9', platform: 'os-one', release: PREVIOUS },
    { name: 'get_nodes', n: 12 * scale, every: within(12), ms: 900, end: NOW.getTime() - 5 * DAY_MS, client: 'client-one', version: '0.8', platform: 'os-one', release: OLDEST },
    // A step of a round and a step of a call: the table grows, the page reads roots.
    { name: 'read-source', n: 40 * scale, every: within(40), steps: true, release: CURRENT },
  ];
  for (const row of rows) await roots(db, row);
}

async function everything(w: World, scale = 1): Promise<void> {
  await samples(w.db, scale);
  // The five minutes before the crash, at `scale` samples per 10 seconds.
  await samples(w.db, scale, 'boot-crashed', CRASH - 1000, 30, 10 / scale);
  await events(w.db, w, 25 * scale);
  await traces(w.db, scale);
}

// ---------------------------------------------------------------- reading a page

type Node = DefaultTreeAdapterMap['node'];
const walk = (node: Node, visit: (node: Node) => boolean): void => {
  if (visit(node) && 'childNodes' in node) for (const child of node.childNodes) walk(child, visit);
};
/** Everything a reader sees without opening anything; `<title>` elements and read-outs are not on the page. */
function visible(markup: string): string {
  let out = '';
  walk(parse(markup), (node) => {
    if (node.nodeName === '#text') out += (node as DefaultTreeAdapterMap['textNode']).value + ' ';
    const attrs = 'attrs' in node ? node.attrs : [];
    if (['script', 'style', 'title', 'head'].includes(node.nodeName)) return false;
    if (attrs.some((attr) => attr.name === 'data-technical' || attr.name === 'hidden' || (attr.name === 'class' && attr.value.split(' ').includes('ch-tableview')))) return false;
    return !attrs.some((attr) => attr.name === 'role' && attr.value === 'tooltip');
  });
  return out.replace(/\s+/g, ' ');
}

/** The section under a title. */
function section(markup: string, title: string): string {
  let found: string | null = null;
  walk(parse(markup), (node) => {
    if (found === null && 'attrs' in node && node.nodeName === 'section' && visible(serialize(node as DefaultTreeAdapterMap['parentNode'])).trim().startsWith(title)) found = visible(serialize(node as DefaultTreeAdapterMap['parentNode']));
    return found === null;
  });
  assert.ok(found !== null, `the page has a section ${title}`);
  return found;
}

/** The tabs of the page (decision 151): each is an address of its own and reads only what it shows. */
const TABS = ['resources', 'tasks', 'events', 'clients', 'releases', 'self'] as const;
const tabPath = (tab: typeof TABS[number]): string => (tab === 'resources' ? '/console/health' : `/console/health?tab=${tab}`);

async function one(client: ConsoleClient, path: string): Promise<string> {
  const reply = await client.get(path);
  assert.equal(reply.status, 200, reply.body.slice(0, 400));
  return reply.body;
}

/** One address, or the whole place: what its six tabs show, one after the other. */
async function shown(client: ConsoleClient, path?: string): Promise<string> {
  if (path !== undefined) return one(client, path);
  let all = '';
  for (const tab of TABS) all += await one(client, tabPath(tab));
  return all;
}

// ---------------------------------------------------------------- who may open it

test('six tabs, each an address of its own, and a tab reads only what it shows', async (t) => {
  const reads: string[] = [];
  const counted = <T extends object>(name: string, target: T): T => new Proxy(target, { get: (object, key, receiver) => { const value = Reflect.get(object, key, receiver); return typeof value !== 'function' ? value : (...args: unknown[]) => { reads.push(`${name}.${String(key)}`); return (value as (...a: unknown[]) => unknown).apply(object, args); }; } });
  const w = await world(t, (page) => ({ health: counted('health', healthReader(page)), traces: counted('traces', new TraceReader(page)) }));
  const tabsOf = (body: string) => [...(/<nav class="ch-seg" aria-label="运行状况内容" data-health-tabs>([\s\S]*?)<\/nav>/.exec(body)?.[1] ?? '').matchAll(/<a href="([^"]+)"( aria-current="page")?>([^<]+)/g)].map((match) => [match[1], !!match[2], match[3]]);
  const expected: Record<typeof TABS[number], { label: string; reads: string[] }> = {
    resources: { label: '资源', reads: ['health.summary', 'health.curve', 'health.events'] },
    tasks: { label: '后台任务', reads: ['health.summary', 'traces.background'] },
    events: { label: '崩溃和重启', reads: ['health.summary', 'health.events', 'health.eventCount'] },
    clients: { label: '按客户端', reads: ['health.summary', 'traces.clients'] },
    releases: { label: '按发布', reads: ['health.summary', 'health.releases', 'traces.releases'] },
    self: { label: '观测自身', reads: ['health.summary', 'health.curve'] },
  };
  for (const tab of TABS) {
    reads.length = 0;
    const body = await shown(w.admin, tabPath(tab));
    assert.deepEqual(tabsOf(body), TABS.map((key) => [tabPath(key), key === tab, expected[key].label]), tab);
    assert.match(body, new RegExp(`data-health-tab="${tab}"`));
    assert.deepEqual(reads, expected[tab].reads, `the reads of ${tab}`);
  }
  reads.length = 0;
  assert.match(await shown(w.admin, '/console/health?tab=absent'), /data-health-tab="resources"/, 'an unknown tab is the first');
});

test('运行状况 is an administrator\'s page: listed for them, and a member gets what any other administrators\' page gives', async (t) => {
  const w = await world(t);
  await everything(w);
  const page = await shown(w.admin);
  assert.match(page, /<a class="ch-nav-item" href="\/console\/health" aria-current="page">/);
  const read = w.page.statements.length;
  const refused = await w.member.get('/console/health');
  const other = await w.member.get('/console/admin/resources');
  assert.equal(refused.status, 404);
  assert.equal(refused.status, other.status);
  assert.equal(visible(refused.body), visible(other.body), 'the same neutral page');
  assert.ok(!(await shown(w.member, '/console/overview')).includes('/console/health'), 'and no way there');
  assert.equal(w.page.statements.length, read, 'a refused request reads nothing');
  assert.equal((await w.member.get('/console/health/more')).status, 404);
  assert.equal((await w.admin.get('/console/health/more')).status, 404);
});

test('without a session the page leads to the sign-in and back', async (t) => {
  const w = await world(t);
  const reply = await w.admin.send('/console/health', { method: 'GET', headers: { cookie: 'circle_hub_session=gone' } });
  assert.equal(reply.status, 303);
  assert.match(String(reply.headers.location), /\/console\/login\?next=%2Fconsole%2Fhealth/);
});

// ---------------------------------------------------------------- what it shows

test('six cards, each with its value now and its 24-hour curve', async (t) => {
  const w = await world(t);
  await everything(w);
  const page = await shown(w.admin);
  const cards = page.match(/class="ch-section ch-resource"/g) ?? [];
  assert.equal(cards.length, 6);
  assert.match(section(page, '主线程'), /主线程 120 毫秒 事件循环延迟最大值 · 最近 10 秒 延迟 p99 38 毫秒 · 事件循环利用率 41% · 进程 CPU 62%（一核为 100%）/);
  assert.match(section(page, '主线程'), /近 24 小时 · 延迟最大值（毫秒）/, 'one long stall misses p99');
  assert.match(section(page, '内存'), /内存 962\.3 MB \/ 上限 2\.0 GB 堆已用 · 占上限 47% 常驻内存 1\.3 GB · 垃圾回收暂停 46 毫秒/);
  assert.match(section(page, '沙箱'), /沙箱 2 \/ 上限 8 运行中 排队 0 · 超时累计 1 · 队列满累计 0/);
  assert.match(section(page, '连接池'), /连接池 3 \/ 上限 10 使用中 等待 0 · 连接失败累计 0/);
  assert.match(section(page, '数据库'), /数据库 5 活动连接 缓存命中率 99\.4% · 锁等待 0 · 死锁累计 0/);
  assert.match(section(page, '磁盘和请求'), /磁盘和请求 411\.6 GB 数据文件夹可用空间 处理中的请求 3 · I\/O 等待 1\.2%/);
  assert.match(section(page, '磁盘和请求'), /近 24 小时 · 可用空间（GB）.*近 24 小时 · 处理中的请求/);
  assert.equal(page.match(/class="ch-chart ch-curve"/g)?.length, 10, 'seven of the day, three before the crash');
  assert.doesNotMatch(page, /\sstyle="/, 'the Content-Security-Policy refuses style attributes');
});

test('the curve of a crash marks it, and a table goes with each curve', async (t) => {
  const w = await world(t);
  await everything(w);
  const page = await shown(w.admin);
  assert.match(page, /<text class="value"[^>]*>异常退出<\/text>/);
  assert.equal(page.match(/class="ch-tableview"/g)?.length, 10);
  assert.doesNotMatch(page, /NaN|Infinity|undefined/);
});

test('the read-out of the free disk shows the dip its curve keeps, as its table does', async (t) => {
  const w = await world(t);
  await samples(w.db, 1);
  await w.db.query(`UPDATE resource_samples SET data_free_bytes=1073741824 WHERE sampled_at>$1 AND sampled_at<=$2`, [iso(NOW.getTime() - 5 * HOUR_MS - 300_000), iso(NOW.getTime() - 5 * HOUR_MS)]);
  const page = await shown(w.admin);
  const start = page.indexOf('近 24 小时 · 可用空间（GB）');
  const figure = page.slice(start, page.indexOf('</figure>', start));
  assert.equal(figure.match(/<b>1\.0 GB<\/b>/g)?.length, 1, 'one half hour holds the dip');
  assert.ok((figure.match(/aria-label="[^"]*1\.0 GB 可用空间"/g) ?? []).length === 1, 'and so does what a keyboard reads');
  assert.match(figure, /<b>411\.6 GB<\/b>/, 'the other half hours are as they were');
  assert.match(page, /<td[^>]*>1\.0 GB<\/td>/, 'the table of the hours agrees');
});

test('the background table names what costs most, from the roots of its rounds', async (t) => {
  const w = await world(t);
  await everything(w);
  const background = section(await shown(w.admin), '后台任务');
  assert.match(background, /按近 24 小时读的行数排序 · 合计 1,065,300 行，运行维护占 99\.6%/);
  assert.match(background, /运行维护 maintain-runs 88,412 23\.8 MB 1 分 11\.0 秒/);
  assert.match(background, /控制台实时轮询 poll-console 62 17\.6 KB 2 秒 8 毫秒/);
  assert.match(background, /投影文档 project-document 1,204 2\.9 MB 按需 6\.8 秒/, 'a job run on demand has no interval');
  assert.match(background, /清理追踪 purge-traces 0 0 B 1 小时 240 毫秒/);
  assert.doesNotMatch(background, /read-source/);
  assert.ok(background.indexOf('运行维护 maintain-runs') < background.indexOf('控制台实时轮询'), 'the largest first');
});

test('the crash says what was running, who asked and what the curves did before it', async (t) => {
  const w = await world(t);
  await everything(w);
  const page = await shown(w.admin);
  const crashes = section(page, '崩溃和重启');
  assert.match(crashes, /显示 20 \/ 共 30 · 新的在前/);
  assert.match(crashes, /异常退出 · JavaScript 堆耗尽.*运行 20 小时 0 分 当时在处理 2 个请求/);
  assert.match(crashes, /运行最久的是 GET \/console\/overview ?（管理员），崩溃时已运行 2 分 55 秒。它开始时堆 962\.3 MB，最后一个样本 962\.3 MB。/);
  assert.match(crashes, /当时在处理 2 个请求 显示 2 \/ 共 2 · 先开始的在前/);
  assert.match(crashes, /2 分 55 秒 控制台 GET \/console\/overview 管理员 未知/, 'no traceparent, no trace id: its steps died with the process');
  assert.match(crashes, /15\.0 秒 MCP get_nodes 合成成员/);
  assert.match(crashes, /崩溃报告 崩溃时间 .* 下次启动 .* 最后样本 .* ?（之后没有样本） 运行时长 20 小时 0 分 堆 2\.0 GB \/ 上限 2\.0 GB 常驻内存 2\.2 GB CPU 用户 512\.25 秒，系统 38\.5 秒/);
  assert.match(crashes, /崩溃前 5 分钟 竖线是 GET \/console\/overview 开始的时间/);
  assert.match(page, /崩溃报告 2\.0 GB/, 'the report has a value the samples do not');
});

test('by client: name, declared platform, entry, connections, calls and p95; a name on two platforms is one count of connections', async (t) => {
  const w = await world(t);
  await everything(w);
  const clients = section(await shown(w.admin), '按客户端');
  assert.match(clients, /现在 4 个 MCP 会话、6 个实时推送流/);
  assert.match(clients, /客户端 平台 入口 客户端版本 现在的连接 近 24 小时调用 近 24 小时 p95/);
  assert.match(clients, /client-one os-one MCP 1\.0 3 12 2\.4 秒/);
  assert.match(clients, /client-one os-two MCP 1\.0 同上 12 2\.2 秒/);
  assert.match(clients, /client-two 未知 MCP 2\.0 0 12 1\.2 秒/, 'no platform declared; the sample says it holds no session');
  assert.match(clients, /未声明名字 未知 MCP 未知 1 6 300 毫秒/);
  assert.match(clients, /client-one os-one 同步 1\.0 未知 12 100 毫秒/);
  assert.match(clients, /浏览器 — 控制台 — 6 12 200 毫秒/);
});

test('a client that holds a session and made no call in the window still has a line', async (t) => {
  const w = await world(t);
  await samples(w.db, 1);
  const clients = section(await shown(w.admin), '按客户端');
  assert.match(clients, /client-one 未知 MCP 未知 3 0 无调用/);
});

test('a client named after a member of Object.prototype has its own count of connections, never an inherited one', async (t) => {
  const w = await world(t);
  await samples(w.db, 1);
  const names = ['constructor', 'toString', 'valueOf', '__proto__'];
  for (const client of names) await roots(w.db, { name: 'get_nodes', n: 1, every: 1000, client, version: '1.0' });
  const clients = section(await shown(w.admin), '按客户端');
  for (const name of names) assert.match(clients, new RegExp(`${name} 未知 MCP 1\\.0 0 1 10 毫秒`), name);
  assert.doesNotMatch(clients, /native code|\[object Object\]/);
  await w.db.query(`UPDATE resource_samples SET mcp_sessions_by_client='{"constructor":2,"__proto__":1}'`);
  const open = section(await shown(w.admin), '按客户端');
  assert.match(open, /constructor 未知 MCP 1\.0 2 1 10 毫秒/);
  assert.match(open, /__proto__ 未知 MCP 1\.0 1 1 10 毫秒/);
  await w.db.query(`UPDATE resource_samples SET mcp_sessions_by_client=$1`, [JSON.stringify(Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`client-${index}`, 1])))]);
  assert.match(section(await shown(w.admin), '按客户端'), /constructor 未知 MCP 1\.0 未知 1 10 毫秒/, 'past the bound of the sample');
});

test('by release: the p95 of each over the end of its own run, what changed, and the id out of the way', async (t) => {
  const w = await world(t);
  await everything(w);
  const page = await shown(w.admin);
  const releases = section(page, '按发布');
  assert.match(releases, /MCP 调用 · 每次部署运行的最后 24 小时，只算 14 天保留期内/);
  assert.match(releases, /发布 运行时段 调用 p95 比上一个发布 发布号/);
  assert.match(releases, /部署 当前 已运行 23 小时 59 分 42 2\.4 秒 慢了 1\.5 秒/);
  assert.match(releases, /运行 24 小时 0 分 12 900 毫秒 没有变化/);
  assert.match(releases, /12 900 毫秒 未知/, 'the release before the oldest is past the retention');
  assert.ok(!visible(page).includes(CURRENT), 'a release id stays behind 查看');
});

test('an exchange on /mcp that is no call adds no client, no call and nothing to a p95', async (t) => {
  const w = await world(t);
  await event(w.db, { at: NOW.getTime() - HOUR_MS, kind: 'start', boot: 'boot-now', release: CURRENT });
  const client = { client: 'client-one', version: '1.0', platform: 'os-one', release: CURRENT };
  await roots(w.db, { name: 'get_nodes', n: 20, every: 1000, ms: 2000, ...client });
  await roots(w.db, { name: 'handle-mcp', n: 1, every: 1000, ms: 2000, ...client });
  await roots(w.db, { name: 'serve-http', n: 80, every: 1000, ms: 1, ...client });
  await roots(w.db, { name: 'serve-http', n: 40, every: 1000, ms: 1, release: CURRENT });
  const page = await shown(w.admin);
  const clients = section(page, '按客户端');
  assert.match(clients, /client-one os-one MCP 1\.0 未知 21 2\.0 秒/);
  assert.doesNotMatch(clients, /未声明名字/, 'every client that called declared a name');
  assert.match(section(page, '按发布'), /已运行 1 小时 0 分 21 2\.0 秒/);
});

test('going back to an earlier release: a line of its own that comes first, and every line compares with the run below it', async (t) => {
  const w = await world(t);
  await event(w.db, { at: NOW.getTime() - 3 * DAY_MS, kind: 'start', boot: 'boot-first', release: CURRENT });
  await event(w.db, { at: NOW.getTime() - 2 * DAY_MS, kind: 'stop', boot: 'boot-first', release: CURRENT, uptime: DAY_MS });
  await event(w.db, { at: NOW.getTime() - 2 * DAY_MS, kind: 'start', boot: 'boot-between', release: PREVIOUS });
  await event(w.db, { at: NOW.getTime() - HOUR_MS, kind: 'stop', boot: 'boot-between', release: PREVIOUS, uptime: 2 * DAY_MS - HOUR_MS });
  await event(w.db, { at: NOW.getTime() - HOUR_MS, kind: 'start', boot: 'boot-now', release: CURRENT });
  await roots(w.db, { name: 'get_nodes', n: 12, every: MINUTE_MS, ms: 2400, end: NOW.getTime() - 2 * DAY_MS - HOUR_MS, release: CURRENT });
  await roots(w.db, { name: 'get_nodes', n: 12, every: MINUTE_MS, ms: 900, end: NOW.getTime() - 2 * HOUR_MS, release: PREVIOUS });
  await roots(w.db, { name: 'get_nodes', n: 12, every: MINUTE_MS, ms: 400, end: NOW.getTime() - 1000, release: CURRENT });
  const releases = section(await shown(w.admin), '按发布');
  assert.match(releases, /部署 当前 已运行 1 小时 0 分 12 400 毫秒 快了 500 毫秒/);
  assert.match(releases, /部署 运行 47 小时 0 分 12 900 毫秒 快了 1\.5 秒/, 'the run it replaced, though that release came back');
  assert.match(releases, /部署 运行 24 小时 0 分 12 2\.4 秒 未知/);
  assert.ok(releases.indexOf('当前') < releases.indexOf('47 小时 0 分'), 'the release running now comes first');
  assert.equal(releases.split('当前').length, 2, 'only the run that is going on is the current one');
});

test('a release that came back after a short run of another keeps its two runs apart: each counts its own calls, and the one between compares with what it replaced', async (t) => {
  const w = await world(t);
  await event(w.db, { at: NOW.getTime() - 3 * HOUR_MS, kind: 'start', boot: 'boot-first', release: CURRENT });
  await event(w.db, { at: NOW.getTime() - 2 * HOUR_MS, kind: 'stop', boot: 'boot-first', release: CURRENT, uptime: HOUR_MS });
  await event(w.db, { at: NOW.getTime() - 2 * HOUR_MS, kind: 'start', boot: 'boot-between', release: PREVIOUS });
  await event(w.db, { at: NOW.getTime() - 10 * MINUTE_MS, kind: 'stop', boot: 'boot-between', release: PREVIOUS, uptime: 110 * MINUTE_MS });
  await event(w.db, { at: NOW.getTime() - 10 * MINUTE_MS, kind: 'start', boot: 'boot-now', release: CURRENT });
  await roots(w.db, { name: 'get_nodes', n: 12, every: MINUTE_MS, ms: 2400, end: NOW.getTime() - 2 * HOUR_MS - MINUTE_MS, release: CURRENT });
  await roots(w.db, { name: 'get_nodes', n: 12, every: MINUTE_MS, ms: 900, end: NOW.getTime() - HOUR_MS, release: PREVIOUS });
  await roots(w.db, { name: 'get_nodes', n: 5, every: MINUTE_MS, ms: 400, end: NOW.getTime() - 1000, release: CURRENT });
  const releases = section(await shown(w.admin), '按发布');
  assert.match(releases, /部署 当前 已运行 10 分 0 秒 5 400 毫秒 快了 500 毫秒/, 'only the calls of this run, though the earlier ones are within 24 hours');
  assert.match(releases, /部署 运行 1 小时 50 分 12 900 毫秒 快了 1\.5 秒/, 'against what it replaced, not what came after it');
  assert.match(releases, /部署 运行 1 小时 0 分 12 2\.4 秒 未知/);
});

test('the release running now always has its line, however many releases came between', async (t) => {
  const w = await world(t);
  const others = ['dddddddddddd', 'eeeeeeeeeeee', 'ffffffffffff', '000000000000', '111111111111', '222222222222'];
  await event(w.db, { at: NOW.getTime() - 9 * DAY_MS, kind: 'start', boot: 'boot-first', release: CURRENT });
  for (const [index, release] of others.entries()) await event(w.db, { at: NOW.getTime() - (8 - index) * DAY_MS, kind: 'start', boot: `boot-${release}`, release });
  await event(w.db, { at: NOW.getTime() - HOUR_MS, kind: 'start', boot: 'boot-now', release: CURRENT });
  await roots(w.db, { name: 'get_nodes', n: 3, every: 1000, release: CURRENT });
  const returned = section(await shown(w.admin), '按发布');
  assert.match(returned, /部署 当前 已运行 1 小时 0 分 3 10 毫秒/);
  assert.match(returned, /显示 5 \/ 共 8/);
});

test('a process whose start the database refused is a run of its own, and every run below keeps what it replaced', async (t) => {
  const w = await world(t);
  const [fourth, fifth] = ['dddddddddddd', 'eeeeeeeeeeee'];
  const ran: [string, number, number][] = [[fourth, 5, 2400], [CURRENT, 4, 900], [PREVIOUS, 3, 400], [fifth, 2, 200]];
  for (const [release, days, ms] of ran) {
    await event(w.db, { at: NOW.getTime() - days * DAY_MS, kind: 'start', boot: `boot-${days}`, release });
    await event(w.db, { at: NOW.getTime() - (days - 1) * DAY_MS, kind: 'stop', boot: `boot-${days}`, release, uptime: DAY_MS });
    await roots(w.db, { name: 'get_nodes', n: 12, every: MINUTE_MS, ms, end: NOW.getTime() - (days - 1) * DAY_MS - HOUR_MS, release });
  }
  // The process serving the page started at NOW, and its release ran before: only its start is missing.
  await roots(w.db, { name: 'get_nodes', n: 3, every: 1000, ms: 100, end: NOW.getTime() + 3000, release: CURRENT });
  const releases = section(await shown(w.admin), '按发布');
  assert.match(releases, /部署 当前 已运行 0 毫秒 3 100 毫秒 快了 100 毫秒/, 'its own calls, not those of its earlier run, and against what ran last');
  assert.match(releases, /12 200 毫秒 快了 200 毫秒/);
  assert.match(releases, /12 400 毫秒 快了 500 毫秒/, 'what it replaced is the earlier run of the release that is running now');
  assert.match(releases, /12 900 毫秒 快了 1\.5 秒/);
  assert.match(releases, /12 2\.4 秒 未知/);
  assert.equal(releases.split('当前').length, 2, 'that earlier run has ended');
});

test('a deploy after a process that outlived the retention compares with it, and that row says how long it ran', async (t) => {
  const w = await world(t);
  await event(w.db, { at: NOW.getTime() - HOUR_MS, kind: 'stop', boot: 'boot-long', release: PREVIOUS, uptime: 20 * DAY_MS });
  await event(w.db, { at: NOW.getTime() - HOUR_MS, kind: 'start', boot: 'boot-now', release: CURRENT });
  await roots(w.db, { name: 'get_nodes', n: 12, every: MINUTE_MS, ms: 900, end: NOW.getTime() - 2 * HOUR_MS, release: PREVIOUS });
  await roots(w.db, { name: 'get_nodes', n: 12, every: MINUTE_MS, ms: 2400, release: CURRENT });
  const releases = section(await shown(w.admin), '按发布');
  assert.match(releases, /部署 当前 已运行 1 小时 0 分 12 2\.4 秒 慢了 1\.5 秒/);
  assert.match(releases, /部署 运行到 [^；]+；只算保留期内 12 900 毫秒 未知/);
  assert.doesNotMatch(releases, /运行 0 毫秒/, 'its ending says how long it ran');
});

test('a release with no release before it in the events does not blame the retention alone', async (t) => {
  const w = await world(t);
  await event(w.db, { at: NOW.getTime() - HOUR_MS, kind: 'start', boot: 'boot-now', release: CURRENT });
  await roots(w.db, { name: 'get_nodes', n: 3, every: 1000, release: CURRENT });
  const page = await shown(w.admin);
  assert.match(page, /title="进程事件里没有上一个发布：已过 14 天保留期，或恢复备份时清空了"/);
  assert.deepEqual(wordingProblems(page), []);
});

test('observation itself: the writer of this process and the samples of the day', async (t) => {
  const w = await world(t);
  await everything(w);
  const observed = section(await shown(w.admin), '观测自身');
  assert.match(observed, /写入的计数从本次启动算起/);
  assert.match(observed, /写入延迟 p95 5\.1 秒 每 5 秒或攒够 500 行写一次 队列 38 行 上限 10,000 行 丢弃 0 行 队列满时丢弃 写入失败 0 行/);
  assert.match(observed, /已写入 21,364 行 每批写入耗时 22 毫秒 最近一批 没有写入的样本 0 个 近 24 小时 读取失败的样本 0 个 近 24 小时/);
});

test('the slowest queries are a note for now, and alerts are not on the page', async (t) => {
  const w = await world(t);
  await everything(w);
  const page = await shown(w.admin);
  assert.match(section(page, '最慢的查询'), /circle-hub db top/);
  assert.doesNotMatch(visible(page), /告警/);
});

// ---------------------------------------------------------------- what it does not know

test('a reading that failed is 未知, the curve breaks there, and the card says how many samples it lost', async (t) => {
  const w = await world(t);
  await everything(w);
  await w.db.query(`UPDATE resource_samples SET pool_limit=NULL,pool_total=NULL,pool_idle=NULL,pool_waiting=NULL,pool_connection_failures=NULL,failed_reads=ARRAY['pool'] WHERE sampled_at>$1`, [iso(NOW.getTime() - 3 * HOUR_MS)]);
  await w.db.query(`UPDATE resource_samples SET mcp_sessions=NULL,mcp_sessions_by_client=NULL,console_streams=NULL WHERE sampled_at>$1`, [iso(NOW.getTime() - 3 * HOUR_MS)]);
  const page = await shown(w.admin);
  const pool = section(page, '连接池');
  assert.match(pool, /连接池 未知 使用中 等待 未知 · 连接失败累计 未知 近 24 小时 36 个样本读取失败/);
  assert.doesNotMatch(pool, /上限/, 'a limit nobody read is not shown as 0');
  assert.match(page, /class="gapband"/);
  assert.match(section(page, '观测自身'), /读取失败的样本 36 个/);
  const clients = section(page, '按客户端');
  assert.match(clients, /连接数未知，调用量和 p95 来自追踪，不受影响/);
  assert.match(clients, /client-one os-one MCP 1\.0 未知 12 2\.4 秒/);
});

test('delay tables name milliseconds and disclose all three aggregation intervals without duplicating maximum',async t=>{
 const w=await world(t);await samples(w.db,1);const page=await shown(w.admin);let main='';
 walk(parse(page),node=>{if('attrs' in node&&node.nodeName==='section'){const markup=serialize(node as DefaultTreeAdapterMap['parentNode']);if(visible(markup).trim().startsWith('主线程'))main=markup;}return !main;});assert.ok(main);
 assert.match(main,/延迟最大值（毫秒）/);assert.doesNotMatch(main,/延迟最大值（最大）/);assert.match(main,/每 5 分钟取最大值/);assert.match(main,/每 30 分钟/);assert.match(main,/表格每小时/);
 assert.match(main,/<td class="num">120<\/td>/);
});

test('a value the sample never had is 未知, however the other readings went', async (t) => {
  const w = await world(t);
  await samples(w.db, 1);
  await w.db.query('UPDATE resource_samples SET event_loop_delay_max_ms=NULL,event_loop_delay_p99_ms=NULL,process_cpu_ratio=NULL,data_free_bytes=NULL,io_wait_ratio=NULL,heap_limit_bytes=NULL');
  const page = await shown(w.admin);
  assert.match(section(page, '主线程'), /主线程 未知 事件循环延迟最大值 · 最近 10 秒 延迟 p99 未知 · 事件循环利用率 41% · 进程 CPU 未知/);
  assert.match(section(page, '内存'), /内存 962\.3 MB 堆已用 · 占上限 未知/);
  assert.match(section(page, '磁盘和请求'), /磁盘和请求 未知 数据文件夹可用空间 处理中的请求 3 · I\/O 等待 未知/);
});

test('a crash nobody can account for says so, and does not say that nothing was running', async (t) => {
  const w = await world(t);
  await event(w.db, { at: CRASH + 24_000, kind: 'abnormal_exit', boot: 'boot-crashed', release: CURRENT, uptime: 20 * HOUR_MS, last: CRASH, reports: [] });
  const crashes = section(await shown(w.admin), '崩溃和重启');
  assert.match(crashes, /异常退出 运行 20 小时 0 分 没有崩溃报告 当时在处理什么： ?未知/);
  assert.match(crashes, /当时在处理什么： ?未知 ?。在途请求日志里没有这个进程，这不等于当时没有请求；服务器重启会清掉这个日志。/);
  assert.match(crashes, /崩溃时间 未知 ?（最后一次活动 /);
  assert.match(crashes, /这个进程崩溃之前 5 分钟没有样本。/);
});

test('a crash with nothing running says that, and one known only from its report has no process to sample', async (t) => {
  const w = await world(t);
  await event(w.db, { at: CRASH + 24_000, kind: 'abnormal_exit', boot: null, reports: null, requests: [] });
  const crashes = section(await shown(w.admin), '崩溃和重启');
  assert.match(crashes, /当时没有在处理的请求/);
  assert.match(crashes, /崩溃报告文件夹读不出来，有没有报告： ?未知/);
  assert.equal(w.page.statements.filter(({ text }) => text.includes('boot=$5')).length, 0);
});

test('a request older than the curves is told as that: no heap of the curves is its start, and no line is promised', async (t) => {
  const w = await world(t);
  await samples(w.db, 1, 'boot-crashed', CRASH - 1000, 30, 10);
  const crash = async (seconds: number): Promise<void> => {
    await w.db.query('DELETE FROM process_events');
    await event(w.db, { at: CRASH + 24_000, kind: 'abnormal_exit', boot: 'boot-crashed', uptime: 20 * HOUR_MS, last: CRASH, reports: [REPORT], requests: [{ trace: null, origin: 'mcp', name: 'get_nodes', user: w.memberUser.user.id, started_at: iso(CRASH - seconds * 1000) }] });
  };
  await crash(720);
  const page = await shown(w.admin);
  const crashes = section(page, '崩溃和重启');
  assert.match(crashes, /运行最久的是 get_nodes ?（合成成员），崩溃时已运行 12 分 0 秒。它在崩溃前 5 分钟之前开始，开始时堆 ?未知 ?，最后一个样本 962\.3 MB。/);
  assert.match(crashes, /崩溃前 5 分钟 get_nodes ?开始于 .*，早于这 5 分钟，图上没有它的竖线。/);
  assert.doesNotMatch(crashes, /它开始时堆 962|竖线是/);
  assert.doesNotMatch(page, /请求开始/);
  assert.deepEqual(wordingProblems(page), []);
  await crash(302);
  const rounded = await shown(w.admin);
  assert.match(section(rounded, '崩溃和重启'), /图上没有它的竖线/, 'a start just before the window is not rounded onto its edge');
  assert.doesNotMatch(rounded, /请求开始/);
  await crash(300);
  const edge = await shown(w.admin);
  assert.match(section(edge, '崩溃和重启'), /它开始时堆 962\.3 MB，最后一个样本 962\.3 MB。.*竖线是 get_nodes ?开始的时间/);
  assert.match(edge, /请求开始/, 'the first moment of the window is on the curves');
});

test('with its samples unreadable a request older than the window still says when it started', async (t) => {
  const w = await world(t, (page) => {
    const health = healthReader(page);
    return { health: { ...health, curve: async (by, query) => { if (query.boot !== undefined) throw new Error('synthetic refused read'); return health.curve(by, query); } } };
  });
  await samples(w.db, 1);
  await event(w.db, { at: CRASH + 24_000, kind: 'abnormal_exit', boot: 'boot-crashed', uptime: 20 * HOUR_MS, last: CRASH, reports: [], requests: [{ trace: null, origin: 'mcp', name: 'get_nodes', user: null, started_at: iso(CRASH - 720_000) }] });
  const crashes = section(await shown(w.admin), '崩溃和重启');
  assert.match(crashes, /它在崩溃前 5 分钟之前开始，开始时堆 ?未知 ?。/);
  assert.match(crashes, /这次没有读出崩溃之前的样本/);
});

test('an unusual reason is shown as it stands, as what the report said', async (t) => {
  const w = await world(t);
  await event(w.db, { at: CRASH, kind: 'abnormal_exit', boot: 'boot-crashed', reports: [{ ...REPORT, event: 'Something <new> happened' }], requests: [] });
  const page = await shown(w.admin);
  assert.match(page, /<span data-evidence>Something &lt;new&gt; happened<\/span>/);
});

test('a fresh install says what will appear here, and its zeros are real ones', async (t) => {
  const w = await world(t, () => ({ writer: () => ({ queued: 0, written: 0, dropped: 0, failed: 0, writeDelayP95Ms: null, lastBatchMs: null }) }));
  const page = await shown(w.admin);
  assert.match(visible(page), /近 24 小时没有样本 · Hub 服务运行后每 10 秒写一个/);
  for (const line of ['近 24 小时没有资源样本', '还没有后台任务的记录', '还没有进程事件', '还没有客户端连接', '还没有发布的调用记录']) assert.ok(visible(page).includes(line), line);
  assert.doesNotMatch(page, /class="ch-chart ch-curve"/);
  assert.match(section(page, '观测自身'), /写入延迟 p95 未知 还没有写入过 队列 0 行/);
  assert.deepEqual(wordingProblems(page), []);
});

test('a read that fails leaves its part 未知 and the rest of the page as it is; the reason goes to the log', async (t) => {
  const w = await world(t, (page) => {
    const traces = new TraceReader(page);
    return { traces: new Proxy(traces, { get: (target, name) => (name === 'background' ? async () => { throw new Error('synthetic refused read'); } : (Reflect.get(target, name) as (...args: unknown[]) => unknown).bind(target)) }) };
  });
  await everything(w);
  const page = await shown(w.admin);
  assert.match(section(page, '后台任务'), /未知 · 这次没有读出后台任务，原因记在服务日志；刷新页面重读。这不是没有数据。/);
  assert.match(section(page, '按客户端'), /client-one os-one/);
  assert.equal(page.match(/class="ch-section ch-resource"/g)?.length, 6);
  assert.ok(w.logs.some((line) => line.includes('运行状况页读取失败（后台任务）') && line.includes('synthetic refused read')));
  assert.ok(!page.includes('synthetic refused read'), 'the reason is for the log');
});

test('a failed read of the curves leaves the count of failed samples 未知, and only the read that holds it decides', async (t) => {
  /** Fails the read of the day's curves or of the summary; everything else reads as usual. */
  const failing = (what: 'curve' | 'summary') => (page: RecordingDatabase): Partial<HealthPageSources> => {
    const health = healthReader(page);
    return { health: { ...health, [what]: async () => { throw new Error('synthetic refused read'); } } };
  };
  const curve = await world(t, failing('curve'));
  await everything(curve);
  const observed = section(await shown(curve.admin), '观测自身');
  assert.match(observed, /读取失败的样本 未知 个/);
  assert.match(observed, /没有写入的样本 0 个/, 'that number comes from the summary, which was read');
  assert.ok(curve.logs.some((line) => line.includes('运行状况页读取失败（曲线）')));

  const summary = await world(t, failing('summary'));
  await everything(summary);
  await summary.db.query(`UPDATE resource_samples SET failed_reads=ARRAY['pool'] WHERE sampled_at>$1`, [iso(NOW.getTime() - HOUR_MS)]);
  const known = section(await shown(summary.admin), '观测自身');
  assert.match(known, /读取失败的样本 12 个/);
  assert.match(known, /没有写入的样本 未知 个/);
});

test('a Hub that was given no readers says 未知 everywhere, never 0', async (t) => {
  const server = await createTestServer({ postgres, now: () => NOW });
  t.after(() => server.close());
  const admin = await openConsole(server, server.admin.token);
  const page = await shown(admin);
  assert.match(section(page, '沙箱'), /沙箱 未知 运行中 排队 未知 · 超时累计 未知 · 队列满累计 未知/);
  assert.match(section(page, '观测自身'), /写入延迟 p95 未知 .* 队列 未知 行 .* 丢弃 未知 行/);
  for (const name of ['后台任务', '崩溃和重启', '按客户端', '按发布']) assert.match(section(page, name), /未知 · 这次没有读出/);
  assert.deepEqual(wordingProblems(page), []);
});

// ---------------------------------------------------------------- nothing silently cut

test('what does not fit is counted: 显示 N / 共 M', async (t) => {
  const w = await world(t);
  await everything(w);
  const requests = Array.from({ length: 200 }, (_, index) => ({ trace: null, origin: 'mcp', name: 'get_nodes', user: null, started_at: iso(CRASH - 1000 - index) }));
  await event(w.db, { at: CRASH + 30_000, kind: 'abnormal_exit', boot: null, reports: [], requests, omitted: 57 });
  for (let index = 0; index < 34; index += 1) await roots(w.db, { name: 'get_nodes', n: 1, every: 1000, client: `client-extra-${index}` });
  for (const [index, release] of ['dddddddddddd', 'eeeeeeeeeeee', 'ffffffffffff', '000000000000'].entries()) await event(w.db, { at: NOW.getTime() - (index + 7) * DAY_MS, kind: 'start', boot: `boot-release-${index}`, release });
  const page = await shown(w.admin);
  assert.match(section(page, '崩溃和重启'), /显示 20 \/ 共 257 · 先开始的在前/);
  assert.match(section(page, '崩溃和重启'), /当时在处理 257 个请求/);
  assert.match(section(page, '按客户端'), /显示 30 \/ 共 40/);
  assert.match(section(page, '按发布'), /显示 5 \/ 共 7/);
});

test('a crash loop does not make the count of events long', async (t) => {
  const w = await world(t);
  await w.db.query(`INSERT INTO process_events(at,kind,boot,pid) SELECT $1::timestamptz-i*interval '1 second','start','boot-loop-'||i,4242 FROM generate_series(1,10002) AS g(i)`, [iso(NOW.getTime())]);
  assert.match(section(await shown(w.admin), '崩溃和重启'), /显示 20 \/ 共 10,000 以上/);
});

test('a client past the rows shown or past the read bound is not a client with no calls: its calls are 未知', async (t) => {
  const quiet = /client-one 未知 MCP 未知 3 未知 未知/;
  const cut = await world(t);
  await samples(cut.db, 1);
  for (let index = 0; index < 31; index += 1) await roots(cut.db, { name: 'get_nodes', n: 2, every: 1000, client: `client-extra-${index}` });
  await roots(cut.db, { name: 'initialize', n: 1, every: 1000, client: 'client-one', end: NOW.getTime() - HOUR_MS });
  const page = await shown(cut.admin);
  assert.match(page, /title="这个客户端的调用不在读到的范围里"/);
  assert.doesNotMatch(page, /近 24 小时没有调用/);
  assert.deepEqual(wordingProblems(page), []);
  const shownRows = section(page, '按客户端');
  assert.match(shownRows, /显示 30 \/ 共 32/);
  assert.match(shownRows, quiet);
  assert.doesNotMatch(shownRows, /无调用/);

  const bound = await world(t, (page) => ({ traces: new TraceReader(page, { roots: 5 }) }));
  await samples(bound.db, 1);
  await roots(bound.db, { name: 'initialize', n: 1, every: 1000, client: 'client-one', end: NOW.getTime() - HOUR_MS });
  await roots(bound.db, { name: 'get_nodes', n: 6, every: 1000, client: 'client-two' });
  const bounded = section(await shown(bound.admin), '按客户端');
  assert.match(bounded, /只算最新的 50,000 次/);
  assert.match(bounded, quiet);
  assert.doesNotMatch(bounded, /无调用/);
});

test('with every call read, a client holding a session and no row made no call, past the rows of other entries too', async (t) => {
  const w = await world(t);
  await samples(w.db, 1);
  for (let index = 0; index < 31; index += 1) await roots(w.db, { name: 'sync-state', origin: 'sync', n: 1, every: 1000, client: `client-extra-${index}` });
  const clients = section(await shown(w.admin), '按客户端');
  assert.match(clients, /显示 30 \/ 共 31/);
  assert.match(clients, /client-one 未知 MCP 未知 3 0 无调用/, 'MCP rows come first: only rows of another entry were cut');
});

test('an aggregate that stops at its bound says so and from when', async (t) => {
  const w = await world(t, (page) => ({ traces: new TraceReader(page, { rounds: 3, roots: 5, releaseCalls: 2 }) }));
  await everything(w);
  const page = await shown(w.admin);
  assert.match(section(page, '后台任务'), /超过 50,000 轮的任务只算最新的 50,000 轮/);
  assert.match(section(page, '后台任务'), /3 以上/);
  assert.match(section(page, '按客户端'), /近 24 小时的调用超过 50,000 次，只算最新的 50,000 次，从 .* 起/);
  assert.match(section(page, '按发布'), /2 以上/);
});

// ---------------------------------------------------------------- opening a crash

test('one crash is open at a time: the newest, or the one asked for, and only its samples are read', async (t) => {
  const w = await world(t);
  await samples(w.db, 1, 'boot-a', CRASH - 1000, 30, 10);
  await samples(w.db, 1, 'boot-b', NOW.getTime() - HOUR_MS - 1000, 30, 10);
  await event(w.db, { at: CRASH, kind: 'abnormal_exit', boot: 'boot-a', last: CRASH, reports: [], requests: [{ trace: null, origin: 'console', name: 'GET /console/first', user: null, started_at: iso(CRASH - 5000) }] });
  await event(w.db, { at: NOW.getTime() - HOUR_MS, kind: 'abnormal_exit', boot: 'boot-b', last: NOW.getTime() - HOUR_MS, reports: [], requests: [{ trace: null, origin: 'console', name: 'GET /console/second', user: null, started_at: iso(NOW.getTime() - HOUR_MS - 5000) }] });
  const newest = await shown(w.admin);
  assert.equal(newest.match(/<details class="ch-event"/g)?.length, 1);
  assert.match(visible(newest), /GET \/console\/second/);
  assert.doesNotMatch(visible(newest), /GET \/console\/first/);
  const seq = /href="([^"]*event=(\d+)[^"]*)"/.exec(newest);
  assert.ok(seq, 'the other crash is a link');
  const other = await shown(w.admin, seq[1]!.replace(/&amp;/g, '&'));
  assert.equal(other.match(/<details class="ch-event"/g)?.length, 1);
  assert.match(visible(other), /GET \/console\/first/);
  assert.doesNotMatch(visible(other), /GET \/console\/second/);
  assert.equal((await w.admin.get('/console/health?event=999999')).status, 200, 'an event that is not listed opens the newest');
  assert.equal((await w.admin.get('/console/health?event=not-a-number')).status, 200);
});

// ---------------------------------------------------------------- what stays out of the main screen

test('hashes and long ids stay behind 查看', async (t) => {
  const w = await world(t);
  await everything(w);
  const page = await shown(w.admin);
  const main = visible(page);
  for (const id of [TRACE, CURRENT, PREVIOUS, OLDEST, REPORT.file, 'boot-crashed', w.memberUser.user.id]) assert.ok(!main.includes(id), id);
  assert.ok(page.includes(TRACE) && page.includes(CURRENT), 'they are one click away');
});

test('a name a client declared is escaped and marked as what it reported', async (t) => {
  const w = await world(t);
  await roots(w.db, { name: 'get_nodes', n: 1, every: 1000, client: '<script>client', version: '1<b>', platform: '<img src=x>' });
  const page = await shown(w.admin);
  assert.doesNotMatch(page, /<script>client|<img src=x>/);
  assert.match(page, /<span data-evidence>&lt;img src=x&gt;<\/span>/);
});

test('every state keeps to the console\'s wording', async (t) => {
  const w = await world(t);
  await everything(w);
  await event(w.db, { at: NOW.getTime() - 1000, kind: 'abnormal_exit', boot: null, reports: [], requests: null });
  const page = await shown(w.admin);
  assert.deepEqual(wordingProblems(page), []);
  await w.db.query(`UPDATE resource_samples SET pool_total=NULL,failed_reads=ARRAY['pool','postgres']`);
  assert.deepEqual(wordingProblems(await shown(w.admin)), []);
});

// ---------------------------------------------------------------- the page is not a burden itself

interface Cost { queries: number; rows: number; statements: { text: string; rows: number }[] }

/** What one view of the page cost, from the usage of its own trace. */
async function cost(w: World): Promise<Cost> {
  const rows: SpanRow[] = [];
  const uninstall = installTraceSink({ push: (row) => rows.push(row) });
  try {
    w.page.statements.length = 0;
    await shown(w.admin);
    // The root ends just after its answer; this waits for the row, it measures nothing.
    for (let index = 0; index < 500 && !rows.some((row) => row.is_root && row.name === 'serve-health'); index += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  } finally {
    uninstall();
  }
  const root = rows.find((row) => row.is_root && row.name === 'serve-health');
  assert.ok(root, 'the page is a trace of its own');
  return { queries: root.usage['db.queries'] ?? 0, rows: root.usage['db.rows'] ?? 0, statements: [...w.page.statements] };
}

const count = async (db: Database, table: string): Promise<number> => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;

test('statements and rows stay the same when the tables hold six times more', async (t) => {
  const small = await world(t);
  await everything(small);
  await shown(small.admin);
  const before = await cost(small);

  const large = await world(t);
  await everything(large, 6);
  await shown(large.admin);
  const after = await cost(large);

  for (const table of ['resource_samples', 'trace_spans', 'process_events']) {
    const [few, many] = [await count(small.db, table), await count(large.db, table)];
    assert.ok(many >= few * 5, `${table}: ${few} rows, then ${many}`);
  }
  assert.equal(after.queries, before.queries, 'the same statements');
  assert.equal(after.rows, before.rows, 'the same rows');
  assert.deepEqual(after.statements.map(({ text, rows }) => [text.slice(0, 60), rows]), before.statements.map(({ text, rows }) => [text.slice(0, 60), rows]));
  assert.ok(before.queries <= 30, `${before.queries} statements`);
  assert.ok(before.rows <= 500, `${before.rows} rows`);
});

test('every read of the page has its window or its limit, and none returns more than a curve', async (t) => {
  const w = await world(t);
  await everything(w, 2);
  const { statements } = await cost(w);
  assert.ok(statements.length >= 10);
  for (const { text, rows } of statements) {
    assert.ok(rows <= 288, `${rows} rows: ${text.slice(0, 80)}`);
    const account = /FROM users WHERE id = \$1$/.test(text);
    assert.ok(account || /\bLIMIT\b/.test(text) || /sampled_at>=\$1/.test(text), `no bound: ${text.slice(0, 120)}`);
  }
  assert.ok(statements.filter(({ text }) => text.includes('trace_spans')).every(({ text }) => /started_at >= \$\d/.test(text)), 'a trace is always read by its time');
});
