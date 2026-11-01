// The runtime environments on the console with a scripted dispatch view: each state derived from the facts the journal
// establishes (可用, 使用中, 已冻结 by an unconfirmed result or an unrestored bed, 已停用, 未知 when not read), the reported
// version and the latest dispatch, the actions each state offers, the read-only interface beside the facts, and the task
// page naming the environment of its dispatch step. Administrators only.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { uiLabelOf, type EnvironmentState } from '../../contracts/generated/vocabulary.ts';
import type { EnvironmentCalls, EnvironmentFacts } from '../dispatch/api.ts';
import type { DispatchView, ExecutorView, JobView } from './api.ts';
import { createTestServer, type TestServer, type TestUser } from './testing.ts';

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
const view: DispatchView = {
  executors: async (by) => {
    if (by.role !== 'admin') throw new Error('只有启用中的管理员能操作执行器和作业');
    return environments;
  },
  jobs: async (_by, run) => jobsByRun.get(run) ?? [],
};

before(async () => {
  server = await createTestServer();
  server.deps.dispatch = view;
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
    body: new URLSearchParams({ token, csrf: nonce }).toString(),
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

/** The row of an environment's table on the connections page. */
const rowOf = (page: string, target: string): string => {
  const at = page.indexOf(`<b>${target}</b>`);
  assert.ok(at >= 0, target);
  return page.slice(at, page.indexOf('</tr>', at));
};

describe('runtime environments', () => {
  test('the connections page shows each state with why, the reported version, the latest dispatch and what each state offers', async () => {
    const page = (await send('/console/connections', { headers: { cookie: await signIn(server.admin.token) } })).body;
    assert.match(rowOf(page, '合成运行环境甲'), /可用/);
    assert.match(rowOf(page, '合成运行环境甲'), /gateway 2\.4\.1/);
    assert.match(page, /响应时间/);
    assert.match(rowOf(page, '合成运行环境甲'), /3 次.+中位 120 毫秒 · 最慢 500 毫秒/);
    assert.match(rowOf(page, '合成运行环境乙'), /近 24 小时无调用/);
    assert.match(rowOf(page, '合成运行环境丙'), /至少 3 次/);
    assert.match(rowOf(page, '合成运行环境己'), /暂不可用/);
    assert.match(rowOf(page, '合成运行环境甲'), new RegExp(`/console/runs/${RUN}`), 'the latest dispatch leads to its task');
    assert.match(rowOf(page, '合成运行环境乙'), /使用中/);
    assert.match(rowOf(page, '合成运行环境乙'), new RegExp(`作业 ${job(2).slice(0, 12)}（效果结局：已发出）`));
    assert.match(rowOf(page, '合成运行环境乙'), /未上报/, 'a session that reported no version');
    assert.match(rowOf(page, '合成运行环境乙'), /尚无派发/);
    assert.match(rowOf(page, '合成运行环境丙'), /已冻结/);
    assert.match(rowOf(page, '合成运行环境丙'), /派发结果未确认，等待处置中/);
    assert.equal(rowOf(page, '合成运行环境丙').match(/>未知</g)?.length, 2, 'a version and a latest dispatch not read are unknown, not none');
    assert.doesNotMatch(rowOf(page, '合成运行环境丙'), /未上报|尚无派发/);
    assert.match(rowOf(page, '合成运行环境丙'), /处置派发结果/);
    assert.match(page, new RegExp(`circle-hub job status ${job(3)}`), 'the disposition starts from the job status on the command line');
    assert.match(rowOf(page, '合成运行环境丙'), new RegExp(`href="/console/runs/${RUN}">查看任务`), 'and its task is one link away');
    assert.match(rowOf(page, '合成运行环境丁'), /已冻结/);
    assert.match(rowOf(page, '合成运行环境丁'), new RegExp(`作业 ${job(4).slice(0, 12)} 结束后运行环境未恢复（synthetic-bed），等待管理员确认中`));
    assert.match(rowOf(page, '合成运行环境丁'), /确认已恢复/);
    assert.match(page, new RegExp(`circle-hub bed hold clear ${id(4)}`), 'the dialog gives the command for the administrator');
    assert.match(rowOf(page, '合成运行环境戊'), /已停用/);
    assert.match(rowOf(page, '合成运行环境己'), /未知/);
    assert.match(rowOf(page, '合成运行环境庚'), /未知/);
    assert.match(rowOf(page, '合成运行环境庚'), /占用该运行环境的作业暂不可读/);
    assert.match(page, /可用 \/ 全部；使用中 1，已冻结 2，已停用 1，未知 2/);
    assert.match(page, /data-live="environment.status"/, 'the environments refresh on their events');
  });

  test('the interface gives the derived state beside the facts; members get the neutral answer', async () => {
    const body = JSON.parse((await send('/console/api/environments', { headers: { cookie: await signIn(server.admin.token) } })).body);
    assert.equal(body.wired, true);
    assert.deepEqual(body.environments.map((e: { status: string }) => e.status), ['available', 'in_use', 'frozen', 'frozen', 'deactivated', 'unknown', 'unknown']);
    assert.deepEqual(body.environments.map((e: { status: EnvironmentState; status_label: string }) => e.status_label === uiLabelOf('environment_state', e.status)), Array(7).fill(true), 'each status comes with its interface term');
    const unknown = body.environments.find((e: { id: string }) => e.id === id(6));
    assert.equal(unknown.state, null, 'not read');
    assert.deepEqual(unknown.status_detail, ['占用与冻结状态暂不可读']);
    assert.equal(body.environments[0].state.reported_version, 'gateway 2.4.1');
    assert.deepEqual(body.environments[0].calls_24h, { ...calls, results_label: { completed: '完成', error: '报错', unknown: '未知' } });
    assert.equal(body.environments[5].calls_24h, null, 'missing statistics stay unknown');
    assert.deepEqual(body.environments[2].state.known, { occupancy: true, latest: false, version: false });
    assert.deepEqual(body.environments[3].status_detail, [`作业 ${job(4).slice(0, 12)} 结束后运行环境未恢复（synthetic-bed），等待管理员确认中`]);
    assert.deepEqual(body.environments[6].status_detail, ['占用该运行环境的作业暂不可读']);
    const refused = await send('/console/api/environments', { headers: { cookie: await signIn((await member()).token) } });
    assert.equal(refused.status, 404);
    assert.equal(JSON.parse(refused.body).code, 'SOURCE_UNAVAILABLE');
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
    const page = (await send(`/console/runs/${run}`, { headers: { cookie: await signIn(server.admin.token) } })).body;
    assert.match(page, /运行环境 合成运行环境丙（当前已冻结） · 运行环境已冻结，不可重发/);
    assert.match(page, /运行环境 合成运行环境乙（当前使用中） · 等待派发结果中，不可重发/);
    assert.equal(page.match(/运行环境 合成运行环境/g)?.length, 2, 'a job whose reservation names no environment names none');
  });
});
