// The runtime environments on the console with a scripted dispatch view: each state derived from the facts the journal
// establishes (可用, 使用中, 已冻结 by an unconfirmed result or an unrestored bed, 已停用, 未知 when not read), the reported
// version and the latest dispatch, the actions each state offers, the read-only interface beside the facts, and the task
// page naming the environment of its dispatch step. Administrators only.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { after, before, describe, test } from 'node:test';
import type { EnvironmentCalls, EnvironmentFacts, EnvironmentReadiness } from '../dispatch/api.ts';
import type { DispatchView, ExecutorView, JobView } from './api.ts';
import { environmentState } from './console/connections.ts';
import { testConsoleCredentials, createTestServer, type TestServer, type TestUser } from './testing.ts';

let server: TestServer;
let counter = 0;
const RUN = 'run_00000000000000000000000077';
const job = (n: number): string => String(n).repeat(64).slice(0, 64);
const id = (n: number): string => `exe_${String(n).padStart(26, '0')}`;
const state = (facts: Partial<EnvironmentFacts> = {}): EnvironmentFacts => ({
  executor: 'x', enabled: true, registration: { digest: 'd'.repeat(64), decided_at: '2026-11-01T00:00:00.000Z' }, known: { occupancy: true, latest: true, version: true },
  holding: [], bed_hold: null, latest: null, reported_version: null, missing: [], ...facts,
});
const environments: ExecutorView[] = [
  { id: id(1), target: '合成运行环境甲', endpoint: 'https://192.0.2.10:8443/mcp', enabled: true, resources: ['synthetic/a'], state: state({ reported_version: 'gateway 2.4.1', latest: { job: job(1), run: RUN, at: '2026-11-01T08:00:00.000Z', outcome: 'effective', frozen: false } }) },
  { id: id(2), target: '合成运行环境乙', endpoint: 'https://192.0.2.11:8443/mcp', enabled: true, resources: ['synthetic/b'], state: state({ holding: [{ job: job(2), run: null, frozen: false, outcome: 'issued', phase: 'intent' }] }) },
  { id: id(3), target: '合成运行环境丙', endpoint: 'https://192.0.2.12:8443/mcp', enabled: true, resources: ['synthetic/c'], state: state({ holding: [{ job: job(3), run: RUN, frozen: true, outcome: 'unknown', phase: 'unknown' }], known: { occupancy: true, latest: false, version: false }, missing: ['最近派发暂不可读', '执行器版本暂不可读'] }) },
  { id: id(4), target: '合成运行环境丁', endpoint: 'https://192.0.2.13:8443/mcp', enabled: true, resources: ['synthetic/d'], state: state({ bed_hold: { job: job(4), bed: 'synthetic-bed' } }) },
  { id: id(5), target: '合成运行环境戊', endpoint: 'https://192.0.2.14:8443/mcp', enabled: false, resources: [], state: state() },
  { id: id(6), target: '合成运行环境己', endpoint: 'https://192.0.2.15:8443/mcp', enabled: true, resources: [] },
  { id: id(7), target: '合成运行环境庚', endpoint: 'https://192.0.2.16:8443/mcp', enabled: true, resources: [], state: state({ known: { occupancy: false, latest: true, version: true }, holding: null, missing: ['占用该运行环境的作业暂不可读'] }) },
];
const calls: EnvironmentCalls = { executor: id(1), since: '2026-10-31T12:00:00.000Z', until: '2026-11-01T12:00:00.000Z', calls: 3, results: { completed: 3, error: 0, unknown: 0 }, median_ms: 120, slowest_ms: 500, last_at: '2026-11-01T11:00:00.000Z', partial: false };
environments[0].calls_24h = calls;
environments[1].calls_24h = { ...calls, executor: id(2), calls: 0, median_ms: null, slowest_ms: null, last_at: null };
environments[2].calls_24h = { ...calls, executor: id(3), partial: true };
const jobsByRun = new Map<string, JobView[]>();
const readinessByTarget = new Map<string, EnvironmentReadiness>();
const readinessCalls: Array<[string, string]> = [];
const instant = '2026-11-14T00:00:00.000Z';
function blockedReadiness(target: string, executor?: string): EnvironmentReadiness {
  return {
    target,
    observed_at: instant,
    executors: [{
      ordinal: 1,
      ...(executor === undefined ? {} : { executor }),
      checks: [
        { condition: 'manifest', label: '清单原件可读且摘要一致', satisfied: false, observed_at: instant, references: [], missing_fact: '受权读取的原件字节与登记摘要不一致', next_action: '请管理员核对该项声明与可读依据后重读' },
        { condition: 'baseline.0', label: '基线登记（第 1 项）', satisfied: false, observed_at: instant, references: [], missing_fact: '该声明探针没有基线登记', next_action: '请管理员按声明探针登记基线后重读；本报告不进行现场比较' },
        { condition: 'evidence.0.0', label: '认证证据原件（第 1 组，第 1 项）', satisfied: null, observed_at: instant, references: [], missing_fact: '原件未取得；不存在、无权或读取策略未放行均不能当作已核对', next_action: '请管理员核对该项声明与可读依据后重读' },
      ],
      occupancy: [],
      baseline_registrations: [],
    }],
    limitations: ['仅本地只读观察，未连接网关或设备，未读取秘密值，不是预订或上机许可'],
  };
}
const view: DispatchView = {
  executors: async (by) => {
    if (by.role !== 'admin') throw new Error('只有启用中的管理员能操作执行器和作业');
    return environments;
  },
  jobs: async (_by, run) => jobsByRun.get(run) ?? [],
  readiness: async (by, target) => {
    readinessCalls.push([by.id, target]);
    const found = readinessByTarget.get(target);
    if (found) return found;
    throw new Error('private://secret-host/password');
  },
};

before(async () => {
  server = await createTestServer();
  server.deps.dispatch = view;
  readinessByTarget.set('合成运行环境甲', blockedReadiness('合成运行环境甲', id(1)));
});
after(async () => {
  await server?.close();
});

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function send(path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: server.port, path, method: options.method ?? 'GET', headers: { host: `127.0.0.1:${server.port}`, ...options.headers }, setHost: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const valueOf = (header: string | undefined): string => (header ?? '').split(';')[0].split('=').slice(1).join('=');
const cookieOf = (reply: Reply, name: string): string | undefined => ([] as string[]).concat(reply.headers['set-cookie'] ?? []).find((value) => value.startsWith(`${name}=`));

async function signIn(token: string): Promise<string> {
  const page = await send('/console/login');
  const nonce = /name="csrf" value="([^"]+)"/.exec(page.body)![1];
  const reply = await send('/console/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `circle_hub_login=${valueOf(cookieOf(page, 'circle_hub_login'))}`, origin: `http://127.0.0.1:${server.port}` },
    body: new URLSearchParams({ ...testConsoleCredentials(token), csrf: nonce }).toString(),
  });
  assert.equal(reply.status, 303, reply.body);
  return `circle_hub_session=${valueOf(cookieOf(reply, 'circle_hub_session'))}`;
}

async function member(): Promise<TestUser> {
  counter += 1;
  const user = await server.createUser(`环境成员${counter}`);
  await server.assign(user.principal, 'review');
  return user;
}

describe('test environments tab', () => {
  test('admin catalog empty state is explicit; deep-link inspector still offers disposition and bed-hold', async () => {
    const page = (await send('/console/connections?tab=environments', { headers: { cookie: await signIn(server.admin.token) } })).body;
    assert.match(page, /请管理员配置测试环境目录/);
    assert.match(page, /data-test-environments="unwired"/);
    assert.match(page, /data-live="environment.status"/, 'the environments refresh on their events');
    assert.doesNotMatch(page, /登记测试环境执行器|type="file"/);
    const frozen=(await send('/console/connections?environment='+id(3),{headers:{cookie:await signIn(server.admin.token)}})).body;
    assert.match(frozen,/处置派发结果/);
    assert.match(frozen, new RegExp(`circle-hub job status ${job(3)}`), 'the disposition starts from the job status on the command line');
    assert.match(frozen, new RegExp(`href="/console/runs/${RUN}">查看任务`), 'and its task is one link away');
    assert.match(frozen, /测试环境/);
    const held=(await send('/console/connections?environment='+id(4),{headers:{cookie:await signIn(server.admin.token)}})).body;
    assert.match(held,/确认已恢复/);
    assert.match(held, new RegExp(`circle-hub bed hold clear ${id(4)}`), 'the dialog gives the command for the administrator');
  });

  test('members do not see the admin catalog; retired JSON API stays unavailable', async () => {
    const memberPage = await send('/console/connections?tab=environments', { headers: { cookie: await signIn((await member()).token) } });
    assert.equal(memberPage.status, 200);
    assert.doesNotMatch(memberPage.body, /gateway 2\.4\.1|192\.0\.2\.10|bed-register|请管理员配置测试环境目录/);
    assert.match(memberPage.body, /只读就绪报告|尚无已分配的测试环境|只读报告未知|我能做的事/);
    const retired = await send('/console/api/environments', { headers: { cookie: await signIn(server.admin.token) } });
    assert.equal(retired.status, 404);
    assert.equal(JSON.parse(retired.body).code, 'SOURCE_UNAVAILABLE');
  });

  test('environmentState still derives occupancy labels from dispatch facts', () => {
    assert.equal(environmentState(environments[0]!).code, 'available');
    assert.equal(environmentState(environments[1]!).code, 'in_use');
    assert.equal(environmentState(environments[2]!).code, 'frozen');
    assert.equal(environmentState(environments[4]!).code, 'deactivated');
    assert.equal(environmentState(environments[5]!).code, 'unknown');
  });

  test('readiness reports show blocked manifest baseline and evidence checks without inventing links or secrets', async () => {
    readinessCalls.length = 0;
    const page = (await send('/console/connections?tab=environments', { headers: { cookie: await signIn(server.admin.token) } })).body;
    assert.match(page, /data-environment-readiness/);
    assert.match(page, /data-condition="manifest"/);
    assert.match(page, /清单原件可读且摘要一致/);
    assert.match(page, /受权读取的原件字节与登记摘要不一致/);
    assert.match(page, /data-condition="baseline\.0"/);
    assert.match(page, /该声明探针没有基线登记/);
    assert.match(page, /data-condition="evidence\.0\.0"/);
    assert.match(page, /原件未取得/);
    assert.match(page, /exe_0{25}1/);
    assert.ok(readinessCalls.some((call) => call[1] === '合成运行环境甲'));
    assert.doesNotMatch(page, /href="[^"]*src:/);
    assert.doesNotMatch(page, /private:\/\/|password=|secret-host/i);
  });

  test('unwired readiness stays unknown on the environments tab', async () => {
    const previous = view.readiness;
    delete view.readiness;
    const page = (await send('/console/connections?tab=environments', { headers: { cookie: await signIn(server.admin.token) } })).body;
    assert.match(page, /只读报告未知/);
    assert.match(page, /报告尚未接线/);
    view.readiness = previous;
  });

  test('failed readiness reads stay unknown and never echo private exception text', async () => {
    readinessByTarget.clear();
    const page = (await send('/console/connections?tab=environments', { headers: { cookie: await signIn(server.admin.token) } })).body;
    assert.match(page, /只读报告未知/);
    assert.doesNotMatch(page, /private:\/\/secret-host\/password|secret-host|password/);
    readinessByTarget.set('合成运行环境甲', blockedReadiness('合成运行环境甲', id(1)));
  });

  test('a task names the environment of its dispatch step and the state it is in', async () => {
    const owner = await member();
    const client = await server.client(owner.token);
    const uploaded = await client.call('upload_file', { file_path: Buffer.from(`合成文档 ${counter}`).toString('base64') });
    const started = await client.call('start_run', { pack: 'review', inputs: { subject: { reference: String(uploaded.structuredContent.reference) } } });
    await client.close();
    const run = (started.structuredContent.run as { run: string }).run;
    jobsByRun.set(run, [
      { job: job(3), executor: id(3), outcome: 'unknown', frozen: true, phase: 'unknown' },
      // Sent and not yet answered: the job status counts it frozen, the environment holds it without a disposition request.
      { job: job(2), executor: id(2), outcome: 'unknown', frozen: true, phase: 'intent' },
      { job: job(9), outcome: 'not_dispatched', frozen: false, phase: 'boundary_refused' },
    ]);
    // The dispatch step is part of the execution process, the 过程 tab of the task page (decision 151).
    const page = (await send(`/console/runs/${run}?tab=process`, { headers: { cookie: await signIn(server.admin.token) } })).body;
    assert.match(page, /运行环境 合成运行环境丙（当前已冻结） · 运行环境已冻结，不可重发/);
    assert.match(page, /运行环境 合成运行环境乙（当前使用中） · 等待派发结果中，不可重发/);
    assert.equal(page.split('以表格查看')[1].match(/运行环境 合成运行环境/g)?.length, 2, 'a job whose reservation names no environment names none');
  });
});
