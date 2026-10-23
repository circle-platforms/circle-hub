import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, test } from 'node:test';
import { PARTITION, STATIC_TERMINAL } from '../../contracts/generated/vocabulary.ts';
import { partitionCountsOf } from '../../contracts/src/validation.ts';
import { countsLine } from './text.ts';
import { probeConsole } from '../../scripts/real/console-page.ts';
import { defaultPacks, fakeWorkflowPack } from './fakes.ts';
import { createTestServer, type TestServer, type TestUser } from './testing.ts';

let server: TestServer;
before(async () => { server = await createTestServer({ packs: [...defaultPacks(), fakeWorkflowPack('facts', '合成事实', ['text/plain'], { factsOnly: true })] }); });
after(async () => { await server?.close(); });
async function send(path: string, cookie = '', method = 'GET', body = '', extra: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
    const req = request(`${server.url}${path}`, { method, headers: { cookie, origin: server.url, 'content-type': 'application/x-www-form-urlencoded', ...extra } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (b: Buffer) => chunks.push(b));
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString(), headers: res.headers }));
    }); req.on('error', reject); req.end(body);
  });
}
const csrf = (body: string) => /name="csrf" value="([^"]+)"/.exec(body)![1];
async function login(user: TestUser) {
  const form = await send('/console/login');
  const logged = await send('/console/login', form.headers['set-cookie']![0].split(';')[0], 'POST', new URLSearchParams({ token: user.token, csrf: csrf(form.body) }).toString());
  assert.equal(logged.status, 303);
  return logged.headers['set-cookie']![0].split(';')[0];
}
async function start(user: TestUser, pack = 'facts', count = 3) {
  await server.assign(user.principal, pack);
  server.fakes.runs.items = (subject) => Array.from({ length: count }, (_, i) => ({ id: `entry-${i}`, label: i === 0 ? '<script>合成名称</script>' : `合成条目${i}`, summary: `合成摘要${i}`, fields: {}, location: subject }));
  const out = await server.fakes.runs.startRun(user.principal, { pack, inputs: { subject: { external: 'tracker:document:synthetic' } } }, { traceId: '1'.repeat(32), sessionId: null });
  assert.equal(out.call_result, 'ok');
  const id = out.run!.run;
  server.fakes.runs.runs.get(id)!.record.build = 'synthetic-10.7';
  return id;
}

test('result page keeps the production record and counts after accepted model commentary',async()=>{
  const user=await server.createUser('生产记录');const id=await start(user);const cookie=await login(user);
  const stored=server.fakes.runs.runs.get(id)!;const original=stored.production!;
  const response=await server.fakes.runs.submitResult(user.principal,{run:id,model:'synthetic-commentary',items:stored.record.items.map((item,i)=>i===0?{item:item.id,handling:'skipped',reason:'合成跳过'}:{item:item.id,handling:'handled',slots:{findings:[{text:'模型评论独立标记',code:'literal_issue'}]}})},{traceId:'2'.repeat(32),sessionId:null});
  assert.equal(response.acceptance,'accepted');assert.notEqual(stored.latest!.record,original.record);
  const result=await send(`/console/results/${id}`,cookie);
  assert.match(result.body,new RegExp(original.record));
  assert.ok(result.body.includes(countsLine(original.result.acceptance,original.result.partitions)));
  assert.ok(!result.body.includes(stored.latest!.record));assert.ok(!result.body.includes('模型评论独立标记'));
});

test('production visibility, neutral refusals, admin and list filters', async () => {
  const a = await server.createUser('甲'); const b = await server.createUser('乙');
  const earlier = await start(a); const own = await start(a); const other = await start(b); const review = await start(a, 'review');
  const cookie = await login(a);
  const missing = await send(`/console/results/run_${'z'.repeat(26)}`, cookie);
  for (const id of [other, review, 'bad', `run_${'z'.repeat(26)}`]) {
    const page = await send(`/console/results/${id}`, cookie);
    assert.equal(page.status, 404); assert.equal(page.body, missing.body); assert.match(page.body, /对你不可用/);
  }
  const list = await send('/console/results?pack=facts&build=synthetic-10.7', cookie);
  assert.equal(list.status, 200); assert.ok(list.body.indexOf(own) < list.body.indexOf(earlier)); assert.ok(list.body.includes(own)); assert.ok(!list.body.includes(other)); assert.ok(!list.body.includes(review));
  assert.ok(!(await send('/console/results?build=absent', cookie)).body.includes(own));
  const admin = await login(server.admin);
  const adminList = await send('/console/results', admin);
  assert.ok(adminList.body.includes(own)); assert.ok(adminList.body.includes(other));
  for (const id of [own, other]) assert.equal((await send(`/console/results/${id}`, admin)).status, 200);
});

test('security gates and immediate revocation apply to result pages', async () => {
  const user = await server.createUser('安全'); const id = await start(user); const cookie = await login(user);
  const path = `/console/results/${id}`; const page = await send(path, cookie);
  assert.equal(page.status, 200); assert.match(String(page.headers['content-security-policy']), /default-src 'none'/);
  assert.match(page.body, /&lt;script&gt;合成名称&lt;\/script&gt;/); assert.doesNotMatch(page.body, /<script\b|(?:src|href)="https?:/i);
  assert.equal((await send(path, cookie, 'POST')).status, 405);
  assert.equal((await send(path, cookie, 'GET', '', { host: '192.0.2.1' })).status, 403);
  assert.equal((await send(path, cookie, 'GET', '', { origin: 'http://192.0.2.1' })).status, 403);
  assert.equal((await send(path)).headers.location, '/console/login');
  const tokens = await server.records.principals.tokens(user.user.id);
  for (const token of tokens) await server.records.principals.revokeToken(server.admin.principal, token.id);
  assert.equal((await send(path, cookie)).headers.location, '/console/login');
});

test('1200 items have three pages, stable whole-result counts, summaries, claims and terminal filters', async () => {
  const user = await server.createUser('分页'); const id = await start(user, 'facts', 1200); const cookie = await login(user);
  const stored = server.fakes.runs.runs.get(id)!;
  const result = stored.latest!.result;
  const all = result.partitions.delivered;
  all.forEach((item, i) => { item.requirements[0].layers = [{ layer: 'static', terminal: STATIC_TERMINAL[i % STATIC_TERMINAL.length] }]; });
  const claim = { statement: { text: '缺少原件；下一步由来源读取任务补采', data: {} }, qualifier: { nature: 'fact' as const, provenance: 'projected' as const, marks: [] }, grounds: [], warrant: { producer: 'function' as const, id: 'synthetic' }, validity: { status: 'valid' as const, bound: [], premises: [] } };
  all[0].requirements[0].claims.push(claim); result.cross_item.push(claim);
  for (const p of PARTITION.filter((p) => p !== 'delivered')) {
    const item = all.pop()!;
    if (p === 'rejected') result.partitions[p].push({ ...item, code: 'synthetic' });
    else result.partitions[p].push({ ...item, reason: 'not_covered' });
  }
  assert.equal(PARTITION.reduce((n, p) => n + result.partitions[p].length, 0), 1200);
  const counts = partitionCountsOf(result.partitions); assert.equal(counts.unknown, 240);
  const pages = await Promise.all([0, 500, 1000].map((offset) => send(`/console/results/${id}?offset=${offset}`, cookie)));
  for (const [i, page] of pages.entries()) {
    assert.equal(page.status, 200); assert.ok(page.body.includes(countsLine(result.acceptance, result.partitions)));
    assert.equal((page.body.match(/<tbody>[\s\S]*?<\/tbody>/g) ?? []).flatMap((body) => body.match(/<tr>/g) ?? []).length, i === 2 ? 200 : 500);
    assert.match(page.body, /跨条目主张/); assert.match(page.body, /补采/);
  }
  const ids = pages.flatMap((page) => [...page.body.matchAll(/<code>(entry-[0-9]+)<\/code>/g)].map((match) => match[1]));
  assert.equal(ids.length, 1200); assert.equal(new Set(ids).size, 1200);
  assert.match(pages[0].body, /合成摘要0/); assert.match(pages[0].body, /class="t-unknown"/);
  const unknown = await send(`/console/results/${id}?terminal=unchecked`, cookie);
  assert.equal((unknown.body.match(/<tbody>[\s\S]*?<\/tbody>/g) ?? []).flatMap((body) => body.match(/<tr>/g) ?? []).length, 240);
  assert.doesNotMatch(unknown.body, /✓|✗/);
  assert.match(unknown.body, /class="t-unknown">？ 静态：未核对/);
  assert.doesNotMatch(unknown.body, /<strong>[^<]*通过/);
  assert.equal((await send(`/console/results/${id}?terminal=bogus`, cookie)).status, 400);
  stored.latest = null;
  stored.production = null;
  assert.match((await send(`/console/results/${id}`, cookie)).body, /还没有校验结果/);
});

test('a filtered empty list page retains the service cursor', async () => {
  const user = await server.createUser('空页'); const cookie = await login(user);
  const id = await start(user);
  const run = server.fakes.runs.runs.get(id)!.record;
  server.fakes.runs.script.answerNext('listRuns', { items: [{ ...run, build: 'other' }], next: 'synthetic-cursor' });
  const page = await send('/console/results?build=synthetic-10.7&pack=facts', cookie);
  assert.match(page.body, /没有运行/); assert.match(page.body, /下一页/); assert.match(page.body, /cursor=synthetic-cursor/);
});


test('the owner probe logs in, reads the actual console and logs out on synthetic records', async () => {
  const user = await server.createUser('探测联测');
  const id = await start(user, 'facts', 7);
  const stats = await probeConsole({ url: server.url, path: `/console/results/${id}`, token: user.token });
  assert.equal(stats.status, 200); assert.equal(stats.csp, true); assert.equal(stats.scripts, 0);
  assert.equal(stats.externalAddresses, 0); assert.deepEqual(stats.tableRows, [7]); assert.equal(stats.logoutStatus, 303);
});
