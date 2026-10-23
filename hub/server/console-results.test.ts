import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, test } from 'node:test';
import { PARTITION, STATIC_TERMINAL, labelOf } from '../../contracts/generated/vocabulary.ts';
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
  assert.match(result.body,/生产结果记录（start_run 计算）/);
  assert.ok(result.body.includes(stored.latest!.record));assert.match(result.body,/后续受理的模型评论/);
  assert.ok(!result.body.includes('模型评论独立标记'));
  const run=await send(`/console/runs/${id}`,cookie);
  const main=run.body.split('<h2>分区清单</h2>')[1].split('<h2>模型评论（判断）</h2>')[0];
  assert.ok(main.includes(original.record));assert.ok(main.includes(countsLine(original.result.acceptance,original.result.partitions)));
  assert.ok(!main.includes(countsLine(stored.latest!.result.acceptance,stored.latest!.result.partitions)));
  const commentary=run.body.split('<h2>模型评论（判断）</h2>')[1]?.split('<h2>提交与回执</h2>')[0];assert.ok(commentary);assert.ok(commentary.includes(stored.latest!.record));assert.ok(commentary.includes('模型评论独立标记'));
  for(const title of ['已采用的成果','仍需处理的事项','需要你决定的请求'])assert.ok(!commentary.includes(title),title);
  assert.match(commentary,/模型声明的分区（判断，未采用）/);assert.match(commentary,/模型声明跳过 entry-0/);assert.match(commentary,/合成跳过/);

});

test('each result row retains its partition and partition code or reason',async()=>{
  const user=await server.createUser('分区');const id=await start(user,'facts',4);const cookie=await login(user);
  const parts=server.fakes.runs.runs.get(id)!.production!.result.partitions;
  parts.rejected.push({...parts.delivered.pop()!,code:'synthetic.<reject>'});
  parts.quarantined.push({...parts.delivered.pop()!,reason:'missing_input'});
  parts.incomplete.push({...parts.delivered.pop()!,reason:'not_covered'});
  const result=await send(`/console/results/${id}`,cookie);
  const rows=[...result.body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(match=>match[1]);
  for(const partition of PARTITION){
    const item=parts[partition][0];const row=rows.find(row=>row.includes(`<code>${item.item}</code>`))!;
    assert.ok(row.includes(labelOf('partition',partition)),partition);
    if('code'in item)assert.match(row,/synthetic\.&lt;reject&gt;/);
    if('reason'in item)assert.ok(row.includes(labelOf('reason',item.reason)));
  }
});

test('requirements show both layers, satisfaction and reason, and dynamic unknowns can be filtered',async()=>{
  const user=await server.createUser('动态层');const id=await start(user);const cookie=await login(user);
  const items=server.fakes.runs.runs.get(id)!.production!.result.partitions.delivered;
  Object.assign(items[0].requirements[0],{layers:[{layer:'static',terminal:'pass'},{layer:'dynamic',terminal:'not_run',reason:'missing_input'}],status:'pending'});
  Object.assign(items[1].requirements[0],{layers:[{layer:'dynamic',terminal:'fail',code:'synthetic.dynamic_failure'}],status:'unsatisfied',unsatisfied_reason:'outcome_mismatch'});
  const response=await send(`/console/results/${id}`,cookie);
  const rows=[...response.body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(match=>match[1]);
  const first=rows.find(row=>row.includes('<code>entry-0</code>'))!;
  assert.match(first,/静态：通过/);assert.match(first,/动态：未运行/);assert.match(first,/未决/);assert.match(first,/t-unknown/);
  const second=rows.find(row=>row.includes('<code>entry-1</code>'))!;
  assert.match(second,/静态：本层不适用/);assert.match(second,/动态：失败/);assert.match(second,/未满足（终态不符合期望）/);
  const third=rows.find(row=>row.includes('<code>entry-2</code>'))!;assert.match(third,/动态：本层不适用/);
  const filtered=await send(`/console/results/${id}?terminal=not_run`,cookie);
  assert.equal(filtered.status,200);assert.match(filtered.body,/筛选后 1 个/);assert.ok(!filtered.body.includes('<code>entry-1</code>'));
  assert.equal((await send(`/console/results/${id}?terminal=fail`,cookie)).status,200);
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
  assert.match((await send(`/console/results/${id}`, cookie)).body, /没有找到 start_run 留下的校验结果记录/);
});

test('a filtered empty list page retains the service cursor', async () => {
  const user = await server.createUser('空页'); const cookie = await login(user);
  const id = await start(user);
  const run = server.fakes.runs.runs.get(id)!.record;
  server.fakes.runs.script.answerNext('listRuns', { items: [{ ...run, build: 'other' }], next: 'synthetic-cursor' });
  const page = await send('/console/results?build=synthetic-10.7&pack=facts', cookie);
  assert.match(page.body, /部分/);assert.match(page.body,/这一页的 1 个运行里没有符合筛选的生产运行/);
  assert.doesNotMatch(page.body,/>没有运行</);assert.match(page.body, /下一页/); assert.match(page.body, /cursor=synthetic-cursor/);
  server.fakes.runs.script.answerNext('listRuns',{items:[],next:null});
  assert.match((await send('/console/results',cookie)).body,/>没有符合筛选的生产运行</);
  server.fakes.runs.script.answerNext('listRuns',{items:[],next:null});
  const last=await send('/console/results?cursor=synthetic-cursor',cookie);
  assert.match(last.body,/部分/);assert.doesNotMatch(last.body,/>没有运行</);
  const another=await start(user),review=await start(user,'review');
  const complete=await send('/console/results',cookie);
  assert.match(complete.body,/本页检查了 3 个运行，列出 2 个符合筛选的生产运行/);assert.doesNotMatch(complete.body,/部分|下一页/);
  assert.ok(complete.body.includes(id));assert.ok(complete.body.includes(another));assert.ok(!complete.body.includes(review));
  const noMatch=await send('/console/results?build=absent',cookie);
  assert.match(noMatch.body,/没有符合筛选的生产运行/);assert.match(noMatch.body,/本页检查了 3 个运行，列出 0 个/);assert.doesNotMatch(noMatch.body,/部分|下一页/);

});


test('the owner probe logs in, reads the actual console and logs out on synthetic records', async () => {
  const user = await server.createUser('探测联测');
  const id = await start(user, 'facts', 7);
  const stats = await probeConsole({ url: server.url, path: `/console/results/${id}`, token: user.token });
  assert.equal(stats.status, 200); assert.equal(stats.csp, true); assert.equal(stats.scripts, 0);
  assert.equal(stats.externalAddresses, 0); assert.deepEqual(stats.tableRows, [7]); assert.equal(stats.logoutStatus, 303);
});

test('independent probe sessions print the same digest for the same synthetic result page',async()=>{
  const user=await server.createUser('摘要');const id=await start(user);
  const options={url:server.url,path:`/console/results/${id}`,token:user.token};
  assert.equal((await probeConsole(options)).sha256,(await probeConsole(options)).sha256);
});

test('a missing production record requires a reread before suggesting a new run even when commentary exists',async()=>{
  const user=await server.createUser('缺生产记录');const id=await start(user),cookie=await login(user),stored=server.fakes.runs.runs.get(id)!;
  const submitted=await server.fakes.runs.submitResult(user.principal,{run:id,model:'synthetic-commentary',items:stored.record.items.map(item=>({item:item.id,handling:'handled',slots:{findings:[{text:'合成评论',code:'literal_issue'}]}}))},{traceId:'3'.repeat(32),sessionId:null});
  assert.equal(submitted.acceptance,'accepted');const commentary=stored.latest!.record;assert.notEqual(commentary,stored.production!.record);stored.production=null;
  for(const path of [`/console/results/${id}`,`/console/runs/${id}`]){
    const response=await send(path,cookie);assert.equal(response.status,200);
    assert.match(response.body,/没有找到 start_run 留下的校验结果记录/);assert.match(response.body,/submission 等于运行记录摘要的 validation_result/);
    assert.match(response.body,/刷新本页再看/);assert.match(response.body,/刷新后仍缺/);assert.ok(response.body.includes(stored.record.started_at));
    assert.ok(response.body.indexOf('刷新本页再看')<response.body.indexOf('同样的输入重新开始一次新运行'));
    assert.match(response.body,/同样的输入重新开始一次新运行/);assert.match(response.body,/client_key/);
    assert.match(response.body,/已有后续受理的模型评论/);assert.ok(response.body.includes(commentary));assert.doesNotMatch(response.body,/还没有校验结果/);
  }
});
