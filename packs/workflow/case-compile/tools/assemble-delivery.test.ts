import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { test, after } from 'node:test';
const priorTZ=process.env.TZ;process.env.TZ='Asia/Tokyo';after(()=>{if(priorTZ===undefined)delete process.env.TZ;else process.env.TZ=priorTZ;});
import { generateWorkbookSet } from '../functions/generate.ts';
import { sha256 } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { CONTRACT_DOC, MANIFEST_DOC, PROFILE_DOC } from '../functions/test-support.ts';
import { signTypedRuntime } from '../testing/typed-fixtures.ts';
import { planRunFixture } from '../testing/plan-run.ts';
import { satisfiedRecipes } from './generate-workbook.ts';
import { lineageKeyOf, main, planDigest } from './assemble-delivery.ts';
import { assemble, timeline } from '../functions/delivery.ts';

const TOKEN = 'synthetic-token-1234';
const BOOKING = 'run_01zzzzzzzzzzzzzzzzzzzzzzzz', RECOMPOSED = `rec:${'7'.repeat(64)}`;
const [WHOLE, FINAL, PLAN1, PLAN2, RECOMPOSE] = ['run_01aaaaaaaaaaaaaaaaaaaaaaaa', 'run_01bbbbbbbbbbbbbbbbbbbbbbbb', 'run_01cccccccccccccccccccccccc', 'run_01dddddddddddddddddddddddd', 'run_01eeeeeeeeeeeeeeeeeeeeeeee'];
const CASES = ['990000000000000101', '990000000000000102', '990000000000000103', '990000000000000104'];
const contract = Buffer.from(JSON.stringify(CONTRACT_DOC)), profile = Buffer.from(JSON.stringify(PROFILE_DOC)), inventory = Buffer.from(JSON.stringify(MANIFEST_DOC));
const log = Buffer.from('合成日志：第 3 步断言没有命中\n');

const planRun = (run: string, autoids: string[], exclude: string[], pause?: string, contractBytes: Uint8Array = contract) => planRunFixture({ run, autoids, exclude, pause, contract: contractBytes, profile, inventory, predecessor: BOOKING, recomposed: RECOMPOSED });
const plan1 = planRun(PLAN1, CASES.slice(0, 3), [CASES[3]]);
const plan2 = planRun(PLAN2, [CASES[0], CASES[2]], [CASES[1], CASES[3]]);
const ROOT = String(plan1.record.root), ENTRY = `tree:${ROOT}/manual/guide/names@${'1'.repeat(64)}`, MANUAL = '| peer_name | 合成参数说明：特殊字符仅支持“._-”。 |';
const lockedRoot = (run: string, root: string) => {
  const nodes = [{ path: '/manual/guide/names', children: [], entries: [{ entry: '1'.repeat(64), kind: 'behaviour', statement: MANUAL, reference: ENTRY, data: {} }] }];
  return Buffer.from([{ schema: 'run-knowledge@1', run, root, composition: null, nodes: nodes.length, entries: 1 }, ...nodes].map((line) => JSON.stringify(line)).join('\n') + '\n');
};
const GAP = 'run_01777777777777777777777777', LATER = 'run_01888888888888888888888888', GAP_WORDS = '合成缺失事实：配置命令的逆操作不在锁定树里', SPENT_WORDS = '合成：缺少修复后符合要求的产物（修复轮数用完）';
type Gap = 'recorded' | 'exhausted' | 'skipped' | 'skipped-spent' | 'shadowed' | 'workbook' | 'unsubmitted' | 'none';
function gapRun(kind: 'recorded' | 'exhausted' | 'skipped' | 'skipped-spent' | 'workbook' | 'unsubmitted', run = GAP) {
  const p = planRun(run, [CASES[3]], []);
  const exit = (request_kind: string) => ({ action: 'request', audience: { user: 'usr_synthetic' }, due: '2026-11-09T00:00:00.000Z', request_kind });
  const pending = (missing: string) => ({ status: 'pending', claims: [], layers: [{ layer: 'static', terminal: 'unchecked', reason: 'missing_input', attribution: 'data_gap', exit: exit('clarification'), missing }] });
  const spent = { status: 'pending', claims: [], layers: [{ layer: 'static', terminal: 'incomplete', reason: 'repair_exhausted', attribution: 'producer_error', exit: exit('repair'), missing: SPENT_WORDS }] };
  const declared = { status: 'pending', claims: [], layers: [{ layer: 'static', terminal: 'incomplete', reason: 'declared_skip', attribution: 'unattributed', exit: exit('repair'), missing: '合成：缺少被跳过条目的提交产物（模型声明跳过）' }] };
  const skip = kind === 'skipped' || kind === 'skipped-spent';
  const entry = p.result.partitions.delivered[0] as Record<string, unknown>;
  for (const r of entry.requirements as Array<Record<string, unknown>>) {
    if (skip) Object.assign(r, r.requirement === 'plan' ? spent : declared);
    else if (r.requirement === 'workbook_verified') Object.assign(r, kind === 'exhausted' ? spent : pending('合成：缺少客户端生成的工作簿'));
    else if (kind === 'recorded' && r.requirement === 'contract_methods') Object.assign(r, pending(GAP_WORDS));
    else if (kind === 'exhausted') Object.assign(r, spent);
  }
  if (skip) Object.assign(entry, { reason: 'repair_exhausted', skip_reason: '合成：声明跳过的理由' });
  if (kind === 'exhausted' || skip) (p.result as Record<string, unknown>).rounds = { max: 2, used: kind === 'skipped' ? 0 : 2 };
  return { plan: p, submitted: kind !== 'unsubmitted' };
}
const recomposed = { run: RECOMPOSE, items: CASES.map((autoid, k) => ({ id: `n/${k}`, fields: { case_id: autoid, atoms: [{ id: 'a1', kind: 'intent', content: `合成意图 ${k + 1}`, after: [] }, { id: 'a2', kind: 'action', content: '合成动作', after: [] }, { id: 'a3', kind: 'expectation', content: '合成期望', after: ['a2'] }] } })) };
const job = (id: string, run: string, plan: string, items: string[], workbook: Uint8Array, verdicts: string[]) => ({ job: id.repeat(64), verification_run: run, plan_run: plan, items, sha256: sha256(workbook), ended: 'done', outcome: 'effective', frozen: false, result: `src:${'9'.repeat(64)}`, device_return: `src:${'8'.repeat(64)}`, rows: items.map((item, k) => ({ item, dynamic_terminal: verdicts[k], ...(verdicts[k] === 'fail' ? { evidence: { log: `src:${sha256(log)}` } } : {}) })) });

type McpAnswer = { kind: 'ok' } | { kind: 'refused'; errors: Array<Record<string, unknown>> } | { kind: 'http'; status: number; body: string } | { kind: 'drop' };
async function hub(finalVerdicts = ['pass', 'pass'], finalWorkbook = plan2.workbook, extraJobs: Record<string, unknown[]> = {}, extraPlans: Record<string, ReturnType<typeof planRun>> = {}, order?: string[], chain = false, extraOriginals: Uint8Array[] = [], gap: Gap = 'recorded', knowledge: 'served' | 'absent' | 'tampered' | 'other-root' = 'served', recomposeRecord: Record<string, unknown> = recomposed, sourceBehavior?: {sha:string; mode:'absent'|'tampered'}) {
  const all: Record<string, unknown[]> = { [WHOLE]: [job('a', WHOLE, PLAN1, CASES.slice(0, 3), plan1.workbook, ['pass', 'fail', 'pass'])], [FINAL]: [job('b', FINAL, PLAN2, [CASES[0], CASES[2]], finalWorkbook, finalVerdicts)], ...extraJobs };
  const runsInOrder = order ?? Object.keys(all);
  const jobs = Object.fromEntries(runsInOrder.map((run) => [run, all[run]]));
  const plans: Record<string, ReturnType<typeof planRun>> = { [PLAN1]: plan1, [PLAN2]: plan2, ...extraPlans };
  const planOfRun = (run: string) => (jobs[run][0] as { plan_run: string }).plan_run;
  const at = (k: number) => `2026-11-08T0${Math.floor(k / 60)}:${String(k % 60).padStart(2, '0')}:00.000Z`;
  const records: Record<string, Record<string, unknown>> = { [BOOKING]: { run: BOOKING, pack: 'test-bed@1.0.0', started_at: at(0), predecessor: null, parameters: {}, sources: [] } };
  let previous: string | null = null, k = 1;
  for (const run of runsInOrder) {
    const plan = planOfRun(run);
    if (!records[plan]) records[plan] = { ...plans[plan].record, started_at: at(k++), predecessor: chain && previous ? previous : BOOKING };
    records[run] = {
      run,
      pack: 'case-compile@9.9.9',
      started_at: at(k++),
      predecessor: plan,
      parameters: {
        plan_run: plan,
        ...(plans[plan]?.record?.parameters && (plans[plan].record.parameters as Record<string, unknown>).scope !== undefined
          ? { scope: (plans[plan].record.parameters as Record<string, unknown>).scope }
          : {}),
      },
      sources: plans[plan].record.sources,
    };
    previous = run;
  }
  if (gap !== 'none') { const g = gapRun(gap === 'shadowed' ? 'recorded' : gap); records[GAP] = { ...g.plan.record, started_at: '2026-11-08T00:00:30.000Z', predecessor: BOOKING }; if (g.submitted) plans[GAP] = g.plan; }
  if (gap === 'shadowed') records[LATER] = { ...gapRun('unsubmitted', LATER).plan.record, started_at: '2026-11-08T00:00:40.000Z', predecessor: BOOKING };
  const successors: Record<string, unknown[]> = {};
  for (const record of Object.values(records)) if (typeof record.predecessor === 'string') (successors[record.predecessor] ??= []).push({ run: record.run, pack: record.pack, started_at: record.started_at, predecessor: record.predecessor, parameters: record.parameters, sources: (record.sources as Array<{ slot: string; reference: string }>).map((s) => ({ slot: s.slot, reference: s.reference })) });
  const originals = new Map([contract, profile, inventory, log, ...extraOriginals].map((bytes) => [sha256(bytes), bytes]));
  const requests: string[]=[];
  // What the Hub is asked through MCP (the release of the booking): every call is kept with the files that stood in the watched directory at that moment.
  const mcp: { calls: Array<{ name: string; arguments: Record<string, unknown>; delivered: string[] | null }>; watch?: string; answer: McpAnswer } = { calls: [], answer: { kind: 'ok' } };
  const server = createServer((request, response) => {
    const url = request.url ?? ''; requests.push(url);
    if (request.headers.authorization !== `Bearer ${TOKEN}`) { response.statusCode = 401; response.end(); return; }
    if (request.method === 'POST' && url === '/mcp') {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const sent = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { params: { name: string; arguments: Record<string, unknown> } };
        mcp.calls.push({ name: sent.params.name, arguments: sent.params.arguments, delivered: mcp.watch !== undefined && existsSync(mcp.watch) ? readdirSync(mcp.watch).sort() : null });
        const answer = mcp.answer;
        if (answer.kind === 'drop') { request.socket.destroy(); return; }
        if (answer.kind === 'http') { response.statusCode = answer.status; response.end(answer.body); return; }
        const text = answer.kind === 'refused' ? `合成：运行没有开出来\n供模型引用\n${JSON.stringify({ call_result: 'error', errors: answer.errors })}` : `合成：已释放\n供模型引用\n${JSON.stringify({ call_result: 'ok', run: { run: 'run_01releasedreleasedreleased' } })}`;
        response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }], isError: answer.kind === 'refused' } }));
      });
      return;
    }
    const jobsOf = /^\/run-export\/(run_\w+)\/jobs$/.exec(url); if (jobsOf && jobs[jobsOf[1]]) { response.end(JSON.stringify({ schema: 'run-jobs@1', run: jobsOf[1], jobs: jobs[jobsOf[1]] })); return; }
    const next = /^\/run-export\/(run_\w+)\/successors$/.exec(url); if (next) { response.end(JSON.stringify({ schema: 'run-successors@1', run: next[1], successors: successors[next[1]] ?? [] })); return; }
    const whole = /^\/run-export\/(run_\w+)$/.exec(url); if (whole && plans[whole[1]]) { const p = plans[whole[1]]; response.end(JSON.stringify({ schema: 'run-export@1', run: records[whole[1]] ?? p.record, result: p.result, submission: p.submission })); return; }
    if (whole && records[whole[1]]) { response.statusCode = 409; response.end('这个运行还没有已受理的提交\n'); return; }
    if (url === `/run-export/${RECOMPOSE}/run`) { response.end(JSON.stringify({ schema: 'run-export@1', run: recomposeRecord })); return; }
    const batch = /^\/run-export\/(run_\w+)\/knowledge$/.exec(url);
    if (batch) {
      if (knowledge === 'absent' || !records[batch[1]]) { response.statusCode = 404; response.end('没有\n'); return; }
      const body = lockedRoot(batch[1], knowledge === 'other-root' ? 'e'.repeat(64) : ROOT);
      response.setHeader('content-digest', `sha-256=:${Buffer.from(sha256(body), 'hex').toString('base64')}:`);
      response.end(knowledge === 'tampered' ? Buffer.concat([body, Buffer.from(' ')]) : body); return;
    }
    const alone = /^\/run-export\/(run_\w+)\/run$/.exec(url); if (alone && records[alone[1]]) { response.end(JSON.stringify({ schema: 'run-export@1', run: records[alone[1]] })); return; }
    const source = /^\/run-export\/run_\w+\/sources\/([0-9a-f]{64})$/.exec(url); if (source && sourceBehavior?.sha===source[1]) { response.statusCode=sourceBehavior.mode==='absent'?404:200; response.end(sourceBehavior.mode==='absent'?'没有\n':'different synthetic bytes'); return; } if (source && originals.has(source[1])) { response.end(originals.get(source[1])); return; }
    response.statusCode = 404; response.end('没有\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/mcp`, requests, mcp, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
async function outputOf(run: () => Promise<number>) {
  const out: string[] = [], err: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout), stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { return { code: await run(), stdout: out.join(''), stderr: err.join('') }; } finally { process.stdout.write = stdout; process.stderr.write = stderr; }
}
async function notes(cases: Record<string, unknown>) { const dir = await mkdtemp(join(tmpdir(), 'cc-notes-')); const path = join(dir, 'notes.json'); await writeFile(path, JSON.stringify({ cases })); return path; }
const CANDIDATE = { repro: '合成复现：照第 1 步配置后读第 3 步输出', expected: '合成期望', actual: '第 3 步断言没有命中' };
const NOTES = { [CASES[1]]: { judged: '合成判断：计划写错', remedy: '合成修法：改计划后重跑', evidence: '第 3 步断言没有命中', defect_candidate: CANDIDATE }, [CASES[3]]: { judged: '合成判断：缺事实', remedy: '合成取舍：等补证' } };
// Every call names the record that opened the compile (a plain one: no judge field, which means Plumb) unless the test gives its own.
const PLAIN_OPEN = await (async () => { const dir = await mkdtemp(join(tmpdir(), 'cc-open-')); const path = join(dir, 'open-compile.json'); await writeFile(path, JSON.stringify({ schema: 'open-compile@1', ready: true, recompose_run: RECOMPOSE, plan_run: PLAN1 })); return path; })();
const run = (h: { url: string }, notesPath: string, out: string, runs = `${WHOLE},${FINAL}`, retry?: Parameters<typeof main>[3], extraArgs: string[] = []) => outputOf(() => main(['--hub', h.url, '--runs', runs, '--recompose', RECOMPOSE, '--notes', notesPath, '--out', out, '--name', '合成批', ...(extraArgs.includes('--open') ? [] : ['--open', PLAIN_OPEN]), ...extraArgs], async () => TOKEN, () => new Date('2026-11-08T08:00:00Z'), {sourceCacheDirectory:false,...retry}));

test('the pass volume is the dispatched final workbook, the unsuccessful volume holds the failed plan, and every case is accounted for', async (t) => {
  const h = await hub(); t.after(h.close); const out = join(await mkdtemp(join(tmpdir(), 'cc-delivery-')), 'out');
  const { code, stdout, stderr } = await run(h, await notes(NOTES), out);
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout).totals, { cases: 4, delivered: 2, failed: 1, unsettled: 0, unrun: 1 });
  assert.deepEqual((await readdir(out)).sort(), ['case.xlsx', 'delivery.json', 'delivery_report.md', 'unsuccessful_cases.md', 'unsuccessful_cases.xlsx']);
  assert.deepEqual(await readFile(join(out, 'case.xlsx')), Buffer.from(plan2.workbook), 'byte for byte the workbook the final verification dispatched');
  const plan1Inputs = { run: plan1.record, result: plan1.result, submission: plan1.submission, contract, profile, inventory };
  assert.deepEqual(await readFile(join(out, 'unsuccessful_cases.xlsx')), Buffer.from(generateWorkbookSet(satisfiedRecipes(plan1Inputs).filter((r) => r.fields.autoid === CASES[1]))));
  const summary = JSON.parse(await readFile(join(out, 'delivery.json'), 'utf8'));
  assert.deepEqual(summary.cases.map((c: { status: string }) => c.status), ['delivered', 'failed', 'delivered', 'unrun']);
  assert.deepEqual(summary.cases[1].dispatches.map((d: { label: string }) => d.label), ['未通过']);
  assert.equal(summary.unsuccessful_volume.dispatched, false);
  const report = await readFile(join(out, 'delivery_report.md'), 'utf8');
  assert.match(report, /^# 交付报告 — 合成批\n> 生成 2026-11-08 /);
  assert.match(report, /自动化用例 Excel case\.xlsx：2 条原始用例，已整卷上机验证，全部通过。/);
  assert.match(report, /第 1 次上机验证：未通过。/);
  assert.match(report, /原始用例 990000000000000102 合成用例 102：上机 1 次，原始用例的期望与设备输出不一致（模型的判断，未经确认）。原因：期望“合成期望”，设备实际输出“第 3 步断言没有命中”。下一步：由使用者核对/);
  assert.match(report, /未做上机验证，这条原始用例未完成脚本编写。/);
  assert.match(report, /## 原始用例 990000000000000104 合成意图 4/, 'a case never compiled takes its title from the recomposition');
  const long = await readFile(join(out, 'unsuccessful_cases.md'), 'utf8');
  assert.match(long, /\*\*原始用例原句\*\*\n- 合成步骤 → 期望 合成期望/);
  assert.match(long, /合成日志：第 3 步断言没有命中/);
});

test('mixed verdicts and absent case notes remain local while workbook identity and extra notes still reject the batch', async (t) => {
  const mixed = await hub(['pass', 'fail']); t.after(mixed.close);
  const dir = await mkdtemp(join(tmpdir(), 'cc-delivery-'));
  const mixedOut = join(dir, 'mixed');
  const partial = await run(mixed, await notes(NOTES), mixedOut);
  assert.equal(partial.code, 1, partial.stderr);
  assert.ok(JSON.parse(partial.stdout).hints.some((hint:{autoid:string})=>hint.autoid===CASES[2]));
  assert.match(JSON.parse(partial.stdout).message, /^交付目录还缺 \d+ 项（见 hints）：逐条补齐后在新的输出目录重跑 assemble-delivery\.ts，这次的 reply 不作最后回复$/);
  const mixedSummary = JSON.parse(await readFile(join(mixedOut, 'delivery.json'), 'utf8'));
  assert.equal(mixedSummary.pass_volume, null);
  assert.ok(mixedSummary.cases[0].pending.length);
  assert.equal(mixedSummary.cases[0].dispatches.at(-1).terminal, 'pass');
  const only = await hub(undefined, undefined, {}, {}, [WHOLE]); t.after(only.close);
  const onlyOut = join(dir, 'only'); assert.equal((await run(only, await notes(NOTES), onlyOut, WHOLE)).code, 0);
  const both = await hub(); t.after(both.close);
  const missingOut = join(dir, 'missing'); const missing = await run(both, await notes({ [CASES[1]]: NOTES[CASES[1]] }), missingOut);
  assert.equal(missing.code, 0, missing.stderr); assert.equal(JSON.parse(await readFile(join(missingOut, 'delivery.json'), 'utf8')).cases[3].model_claims.absent, true);
  const bad = join(dir, 'bad');
  const other = await hub(['pass', 'pass'], Buffer.from('另一份工作簿')); t.after(other.close);
  const wrongWorkbook = await run(other, await notes(NOTES), bad); assert.equal(wrongWorkbook.code, 1); assert.match(wrongWorkbook.stderr, /上机验证工作簿摘要与其脚本编写结果不一致/);
  const extra = await run(both, await notes({ ...NOTES, [CASES[0]]: NOTES[CASES[1]] }), bad);
  assert.equal(extra.code, 1); assert.match(extra.stderr, /多了 990000000000000101（交付的用例不写说明）/);
  await assert.rejects(readdir(bad), 'invalid batch inputs write nothing');
});

test('a recent pass outside a verified volume leaves case-local pending eligibility and an all-fail dispatch has no pass volume', () => {
  const d = (run: string, items: string[], verdicts: string[]) => ({ run, job: 'j-' + run, plan_run: PLAN1, sha256: 'c'.repeat(64), items, rows: items.map((item, k) => ({ item, dynamic_terminal: verdicts[k] })) });
  const partial = assemble(CASES.slice(0, 3), [d(WHOLE, CASES.slice(0, 3), ['pass', 'fail', 'pass']), d(FINAL, [CASES[0]], ['pass'])]);
  assert.deepEqual(partial.pass?.items, [CASES[0]]); assert.ok(partial.cases[2].pending?.length); assert.equal(partial.cases[2].history.at(-1)?.terminal, 'pass');
  const together = assemble(CASES.slice(0, 3), [d(WHOLE, CASES.slice(0, 3), ['pass', 'fail', 'pass']), d(FINAL, [CASES[0], CASES[2]], ['pass', 'pass'])]);
  assert.deepEqual(together.totals, { cases: 3, delivered: 2, failed: 1, unsettled: 0, unrun: 0 });
  assert.match(timeline(together.cases[1], false), /^第 1 次上机验证：未通过。$/);
  const unverified = assemble(CASES.slice(0, 3), [d(WHOLE, CASES.slice(0, 3), ['pass', 'fail', 'pass'])]); assert.equal(unverified.pass, null); assert.equal(unverified.cases.filter(c => c.pending?.length).length, 2);
  const none = assemble(CASES.slice(0, 2), [d(WHOLE, CASES.slice(0, 2), ['fail', 'no_verdict'])]);
  assert.equal(none.pass, null); assert.deepEqual(none.totals, { cases: 2, delivered: 0, failed: 1, unsettled: 1, unrun: 0 });
  assert.deepEqual(none.unsuccessful?.items, CASES.slice(0, 2));
});

test('cases that last failed in different dispatches go into the unsuccessful volume each with the plan it last ran', async (t) => {
  const [REWORK, FINAL2, PLAN3, PLAN4] = ['run_01ffffffffffffffffffffffff', 'run_01gggggggggggggggggggggggg', 'run_01hhhhhhhhhhhhhhhhhhhhhhhh', 'run_01jjjjjjjjjjjjjjjjjjjjjjjj'];
  const plan3 = planRun(PLAN3, [CASES[0], CASES[2]], [CASES[1], CASES[3]]);
  const plan4 = planRun(PLAN4, [CASES[0]], [CASES[1], CASES[2], CASES[3]]);
  const h = await hub(undefined, undefined, {
    [REWORK]: [job('c', REWORK, PLAN3, [CASES[0], CASES[2]], plan3.workbook, ['pass', 'fail'])],
    [FINAL2]: [job('d', FINAL2, PLAN4, [CASES[0]], plan4.workbook, ['pass'])],
  }, { [PLAN3]: plan3, [PLAN4]: plan4 });
  t.after(() => h.close());
  const out = join(await mkdtemp(join(tmpdir(), 'cc-delivery-')), 'delivery');
  const notesPath = await notes({ ...NOTES, [CASES[2]]: { judged: '合成判断：返工后仍失败', remedy: '合成取舍：继续加轮', evidence: '合成日志：第 3 步断言没有命中', defect_candidate: CANDIDATE } });
  const result = await run(h, notesPath, out, `${WHOLE},${REWORK},${FINAL2}`);
  assert.equal(result.code, 0, result.stderr);
  const summary = JSON.parse(await readFile(join(out, 'delivery.json'), 'utf8'));
  assert.deepEqual(summary.totals, { cases: 4, delivered: 1, failed: 2, unsettled: 0, unrun: 1 });
  assert.deepEqual(summary.unsuccessful_volume.items, [{ autoid: CASES[1], plan_run: PLAN1, run: WHOLE }, { autoid: CASES[2], plan_run: PLAN3, run: REWORK }]);
  const recipe = (inputs: ReturnType<typeof planRun>, plan: string, autoid: string) => satisfiedRecipes({ run: inputs.record, result: inputs.result, submission: inputs.submission, contract, profile, inventory }).find((r) => r.fields.autoid === autoid && r.plan_run === plan)!;
  assert.deepEqual(await readFile(join(out, 'unsuccessful_cases.xlsx')), Buffer.from(generateWorkbookSet([recipe(plan1, PLAN1, CASES[1]), recipe(plan3, PLAN3, CASES[2])], { merged: true })));
  assert.deepEqual(await readFile(join(out, 'case.xlsx')), Buffer.from(plan4.workbook));
  assert.match(await readFile(join(out, 'delivery_report.md'), 'utf8'), /各用最后一次写好的自动化用例；这些写法是否上过机见逐条记录，没有整卷上机验证。/);
});

test('a merged workbook names every plan run and refuses cases of another contract; the default stays one plan run', () => {
  const [a, b] = [planRun(PLAN1, [CASES[0]], []), planRun(PLAN2, [CASES[1]], [])].map((p) => satisfiedRecipes({ run: p.record, result: p.result, submission: p.submission, contract, profile, inventory })[0]);
  assert.throws(() => generateWorkbookSet([a, b]), /共用同一合约、配置、计划运行/);
  assert.ok(generateWorkbookSet([a, b], { merged: true }).length > 0);
  assert.deepEqual(generateWorkbookSet([a]), generateWorkbookSet([a], { merged: true }));
  const other = { ...b, profile: { ...b.profile, device_count: b.profile.device_count + 1 } };
  assert.throws(() => generateWorkbookSet([a, other], { merged: true }), /共用同一合约、配置/);
});

test('later verification updates whole-volume eligibility and preserves other reported passes as pending', async (t) => {
  const [AFTER, PLAN5] = ['run_01kkkkkkkkkkkkkkkkkkkkkkkk', 'run_01mmmmmmmmmmmmmmmmmmmmmmmm'];
  const plan5 = planRun(PLAN5, [CASES[1]], [CASES[0], CASES[2], CASES[3]]);
  const h = await hub(undefined, undefined, { [AFTER]: [job('e', AFTER, PLAN5, [CASES[1]], plan5.workbook, ['fail'])] }, { [PLAN5]: plan5 });
  t.after(() => h.close());
  const out = join(await mkdtemp(join(tmpdir(), 'cc-delivery-')), 'delivery');
  const result = await run(h, await notes(NOTES), out, `${WHOLE},${FINAL},${AFTER}`);
  assert.equal(result.code, 0, result.stderr);
  const summary = JSON.parse(await readFile(join(out, 'delivery.json'), 'utf8'));
  assert.equal(summary.pass_volume.run, FINAL);
  assert.deepEqual(summary.unsuccessful_volume.items, [{ autoid: CASES[1], plan_run: PLAN5, run: AFTER }]);

  const PLAN6 = 'run_01nnnnnnnnnnnnnnnnnnnnnnnn';
  const plan6 = planRun(PLAN6, [CASES[0], CASES[1]], [CASES[2], CASES[3]]);
  const dispatches = [WHOLE, FINAL].map((r, k) => ({ run: r, job: String(k).repeat(64), plan_run: [PLAN1, PLAN2][k], sha256: '0'.repeat(64), items: k ? [CASES[0], CASES[2]] : CASES.slice(0, 3), rows: (k ? [CASES[0], CASES[2]] : CASES.slice(0, 3)).map((item, i) => ({ item, dynamic_terminal: k || i !== 1 ? 'pass' : 'fail' })) }));
  const rerun = { run: 'run_01pppppppppppppppppppppppp', job: '7'.repeat(64), plan_run: PLAN6, sha256: sha256(plan6.workbook), items: [CASES[0], CASES[1]], rows: [{ item: CASES[0], dynamic_terminal: 'fail' }, { item: CASES[1], dynamic_terminal: 'fail' }] };
  const failedAgain = assemble(CASES, [...dispatches, rerun]); assert.equal(failedAgain.pass, null); assert.equal(failedAgain.cases[0].status, 'failed'); assert.ok(failedAgain.cases[2].pending?.length);
  const retry = { ...rerun, run: 'run_01qqqqqqqqqqqqqqqqqqqqqqqq', items: [CASES[0], CASES[2], CASES[1]], rows: [{ item: CASES[0], dynamic_terminal: 'pass' }, { item: CASES[2], dynamic_terminal: 'pass' }, { item: CASES[1], dynamic_terminal: 'fail' }] };
  const settled = assemble(CASES, [...dispatches, retry]);
  assert.equal(settled.pass?.run, FINAL);
  assert.deepEqual(settled.unsuccessful?.items, [CASES[1]]);
  assert.equal(settled.unsuccessful?.sources[CASES[1]].run, retry.run);
  const extra = { ...retry, run: 'run_01rrrrrrrrrrrrrrrrrrrrrrrr', items: [CASES[1]], rows: [{ item: CASES[1], dynamic_terminal: 'pass' }] };
  const last = assemble(CASES, [...dispatches, retry, extra]); assert.equal(last.pass?.run, extra.run); assert.deepEqual(last.cases.filter(c => c.pending?.length).map(c => c.autoid), [CASES[0], CASES[2]]);
});

test('the verification runs the model left out are found in the Hub lineage, and the reply holds only counts and paths', async (t) => {
  const h = await hub();
  t.after(() => h.close());
  const out = join(await mkdtemp(join(tmpdir(), 'cc-delivery-')), 'delivery');
  const result = await run(h, await notes(NOTES), out, FINAL);
  assert.equal(result.code, 0, result.stderr);
  const printed = JSON.parse(result.stdout);
  assert.deepEqual(printed.runs, [WHOLE, FINAL]);
  assert.deepEqual(printed.added_runs, [WHOLE]);
  const replyLines = printed.reply.split('\n');
  assert.deepEqual(replyLines.slice(0, 5), ['原始脑图共 4 条用例：生成成功 2 条，失败 2 条。', '判断方式：Plumb', `自动化用例 Excel：${join(out,'case.xlsx')}`, '', '失败的 2 条：']);
  assert.equal(replyLines[5], '- 原始用例 990000000000000102 合成用例 102：上机 1 次，原始用例的期望与设备输出不一致（模型的判断，未经确认）。原因：期望“合成期望”，设备实际输出“第 3 步断言没有命中”。');
  assert.match(replyLines[6], /^- 原始用例 990000000000000104 合成意图 4：缺少脚本编写所需的资料，没有上机。原因：缺资料，缺少：.+。模型的分析：合成判断：缺事实。$/);
  assert.deepEqual(replyLines.slice(7), ['', `失败用例的详细说明：${join(out,'unsuccessful_cases.md')}`, `失败用例的 Excel（没有整卷上机验证）：${join(out,'unsuccessful_cases.xlsx')}`, `交付报告：${join(out,'delivery_report.md')}`]);
  assert.doesNotMatch(printed.reply, /合成用例 101|合成用例 103|状态未|判断正确|判断错误|决定者|目标自报|设备自报|不升级观察性质|Hub|运行器|下一步/);
  assert.deepEqual([printed.hints, printed.message], [[], '交付目录已组好：最后回复原样用 reply，不另加表格或逐条重述'], 'the answer names the next step: the reply is the closing answer');
  assert.match(await readFile(join(out, 'delivery_report.md'), 'utf8'), /原因：缺资料.*下一步：由使用者处理具名请求，期限 2026-11-09 09:00/);
  const summary = JSON.parse(await readFile(join(out, 'delivery.json'), 'utf8'));
  assert.deepEqual(summary.added_runs, [WHOLE]);
  assert.match(await readFile(join(out, 'delivery_report.md'), 'utf8'), /第 1 次上机验证：未通过/);
});

test('a verification run whose job ended before anything went to the bed is no run of the cases, and the lineage skips it', async (t) => {
  const STUCK = 'run_01ssssssssssssssssssssssss';
  const notSent = { job: 'c'.repeat(64), verification_run: STUCK, plan_run: PLAN2, items: [CASES[0], CASES[2]], sha256: sha256(plan2.workbook), ended: 'done', outcome: 'not_dispatched', frozen: false, result: null, device_return: null, rows: null };
  const h = await hub(undefined, undefined, { [STUCK]: [notSent] }, {}, [WHOLE, STUCK, FINAL]);
  t.after(() => h.close());
  const out = join(await mkdtemp(join(tmpdir(), 'cc-delivery-')), 'delivery');
  const result = await run(h, await notes(NOTES), out, FINAL);
  assert.equal(result.code, 0, result.stderr);
  const printed = JSON.parse(result.stdout);
  assert.deepEqual(printed.runs, [WHOLE, FINAL]);
  assert.deepEqual(printed.added_runs, [WHOLE]);
});

test("a case not delivered that went to the bed is explained with the device's own words, checked verbatim", async (t) => {
  const h = await hub(); t.after(() => h.close());
  const dir = await mkdtemp(join(tmpdir(), 'cc-delivery-'));
  const missing = await run(h, await notes({ ...NOTES, [CASES[1]]: { judged: '合成判断', remedy: '合成修法' } }), join(dir, 'a'));
  assert.equal(missing.code, 1, missing.stderr);
  assert.match(JSON.parse(missing.stdout).hints[0].next_action,/一个文件/);
  const missingSummary = JSON.parse(await readFile(join(dir,'a','delivery.json'),'utf8'));
  assert.ok(missingSummary.cases[1].pending.some((fact:string) => fact.includes('说明缺少设备输出')));
  assert.equal(missingSummary.cases[1].closing,undefined);
  assert.equal(missingSummary.cases[0].status,'delivered');
  const invented = await run(h, await notes({ ...NOTES, [CASES[1]]: { judged: '合成判断', remedy: '合成修法', evidence: '设备说一切正常' } }), join(dir, 'b'));
  assert.equal(invented.code, 1, invented.stderr);
  const inventedSummary = JSON.parse(await readFile(join(dir,'b','delivery.json'),'utf8'));
  assert.ok(inventedSummary.cases[1].pending.some((fact:string) => fact.includes('不是最近一次上机验证的原话')));
  assert.equal(inventedSummary.cases[1].closing,undefined);
  assert.match(await readFile(join(dir,'b','delivery_report.md'),'utf8'), /模型提出的设备输出.*逐字核对未通过/);
  const out = join(dir, 'c');
  const ok = await run(h, await notes(NOTES), out);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(await readFile(join(out, 'delivery_report.md'), 'utf8'), /\*\*证据，设备输出\*\*，已按照规则核对设备输出。\n```\n第 3 步断言没有命中\n```/);
});

test('a rework whose plan run names the previous verification run as predecessor is still found, up to the booking and back down', async (t) => {
  const h = await hub(undefined, undefined, {}, {}, undefined, true);
  t.after(() => h.close());
  const out = join(await mkdtemp(join(tmpdir(), 'cc-delivery-')), 'delivery');
  const result = await run(h, await notes(NOTES), out, FINAL);
  assert.equal(result.code, 0, result.stderr);
  const printed = JSON.parse(result.stdout);
  assert.deepEqual(printed.runs, [WHOLE, FINAL]);
  assert.deepEqual(printed.added_runs, [WHOLE]);
});

test('recorded distinct failed versions have bounded conclusions and invalid defect evidence stays case-local', async (t) => {
  const [R2, R3, AGAIN, PLAN7, PLAN8] = ['run_01ssssssssssssssssssssssss', 'run_01tttttttttttttttttttttttt', 'run_01vvvvvvvvvvvvvvvvvvvvvvvv', 'run_01wwwwwwwwwwwwwwwwwwwwwwww', 'run_01xxxxxxxxxxxxxxxxxxxxxxxx'];
  const judgedOnly = { ...NOTES, [CASES[1]]: { judged: '合成判断：环境缺前置', remedy: '合成取舍：本轮不返工', evidence: '第 3 步断言没有命中' } };
  const dir = await mkdtemp(join(tmpdir(), 'cc-delivery-'));
  const once = await hub(); t.after(once.close);
  const early = await run(once, await notes(judgedOnly), join(dir, 'a'));
  assert.equal(early.code, 0, early.stderr);
  const earlySummary=JSON.parse(await readFile(join(dir,'a','delivery.json'),'utf8'));
  assert.equal(earlySummary.cases[1].closing,undefined);
  assert.ok(earlySummary.cases[1].pending.some((fact:string)=>fact.includes('已记录 1 份不同内容')));
  assert.equal(earlySummary.cases[1].dispatches[0].dynamic_terminal,'fail');
  const unquoted = await run(once, await notes({ ...NOTES, [CASES[1]]: { ...NOTES[CASES[1]], defect_candidate: { ...CANDIDATE, expected: '作者没写过的期望', actual: '设备说一切正常' } } }), join(dir, 'b'));
  assert.equal(unquoted.code, 1,unquoted.stderr);
  assert.equal(JSON.parse(unquoted.stdout).hints[0].autoid, CASES[1]);
  const unquotedSummary=JSON.parse(await readFile(join(dir,'b','delivery.json'),'utf8'));
  assert.equal(unquotedSummary.cases[1].closing,undefined);
  assert.ok(unquotedSummary.cases[1].pending.some((fact:string)=>fact.includes('期望不是原始用例的原句；设备输出不是最近一次上机验证的原话')));
  assert.match((await run(once, await notes({ ...NOTES, [CASES[1]]: { ...NOTES[CASES[1]], defect_candidate: { repro: '合成复现' } } }), join(dir, 'c'))).stderr, /判断设备的问题时，请只写复现步骤、原始用例期望原句和设备输出三项/);

  const rerun = await hub(undefined, undefined, { [AGAIN]: [job('g', AGAIN, PLAN1, CASES.slice(0, 3), plan1.workbook, ['pass', 'fail', 'pass'])] }, {}, [WHOLE, AGAIN, FINAL]); t.after(rerun.close);
  assert.equal((await run(rerun, await notes(judgedOnly), join(dir, 'd'), `${WHOLE},${AGAIN},${FINAL}`)).code,0);
  assert.ok(JSON.parse(await readFile(join(dir,'d','delivery.json'),'utf8')).cases[1].pending.some((fact:string)=>fact.includes('已记录 1 份不同内容')));

  const plan7 = planRun(PLAN7, CASES.slice(0, 3), [CASES[3]], '2'), plan8 = planRun(PLAN8, CASES.slice(0, 3), [CASES[3]], '3');
  const three = await hub(undefined, undefined, { [R2]: [job('h', R2, PLAN7, CASES.slice(0, 3), plan7.workbook, ['pass', 'fail', 'pass'])], [R3]: [job('k', R3, PLAN8, CASES.slice(0, 3), plan8.workbook, ['pass', 'fail', 'pass'])] }, { [PLAN7]: plan7, [PLAN8]: plan8 }, [WHOLE, R2, R3, FINAL]); t.after(three.close);
  const out = join(dir, 'e');
  const closed = await run(three, await notes(judgedOnly), out, FINAL);
  assert.equal(closed.code, 0, closed.stderr);
  assert.deepEqual(JSON.parse(closed.stdout).added_runs, [WHOLE, R2, R3]);
  const summary = JSON.parse(await readFile(join(out, 'delivery.json'), 'utf8'));
  assert.deepEqual({ closing: summary.cases[1].closing, label: summary.cases[1].closing_label, rounds: summary.cases[1].rounds }, { closing: 'authoring_failure', label: '所记录的核验尚未通过', rounds: 3 });
  assert.deepEqual(summary.closings, { authoring_failure: 1, device_defect: 0, missing_fact: 1, author_conflict: 0 });
  assert.match(JSON.parse(closed.stdout).reply, /合成用例 102：上机 3 次、写过 3 版自动化用例，都没有通过。原因（模型的分析）：合成判断：环境缺前置。/);
  const report = await readFile(join(out, 'delivery_report.md'), 'utf8');
  assert.match(report, /原始用例 990000000000000102 合成用例 102：上机 3 次、写过 3 版自动化用例，都没有通过。原因（模型的分析）：合成判断：环境缺前置。/);
  assert.match(report, /下一步：尚缺具名出口材料.*模型建议单列为未确认。/);
  assert.match(report, /\*\*怎么判断的\*\*（模型的失败分析，未经确认）：合成判断：环境缺前置/);

  const candidateOut = join(dir, 'f');
  assert.equal((await run(once, await notes(NOTES), candidateOut)).code, 0);
  const candidateReport = await readFile(join(candidateOut, 'unsuccessful_cases.md'), 'utf8');
  assert.match(candidateReport, /上机 1 次，原始用例的期望与设备输出不一致（模型的判断，未经确认）。原因：期望“合成期望”，设备实际输出“第 3 步断言没有命中”。/);
  assert.match(candidateReport, /模型提出的复现步骤（未确认） 合成复现：照第 1 步配置后读第 3 步输出\n\n原始用例原句，已逐字核对\n```\n合成期望\n```\n\n设备输出，已逐字核对\n```\n第 3 步断言没有命中\n```/);
});

test('a pass whose device words carry an execution-failure line its assertions do not read is no verdict', async (t) => {
  const doc = structuredClone(CONTRACT_DOC) as Record<string, unknown>;
  doc.exec_failure_markers = { source: 'reference-engine/domain_grammar.json', sha256: 'a'.repeat(64), lines: ['Failed to run the synthetic command'] };
  const marked = Buffer.from(JSON.stringify(signTypedRuntime(doc)));
  const [WHOLE2, FINAL3, PLAN7, PLAN8] = ['run_01yyyyyyyyyyyyyyyyyyyyyyyy', 'run_01zzzzzzzzzzzzzzzzzzzzzzza', 'run_01zzzzzzzzzzzzzzzzzzzzzzzb', 'run_01zzzzzzzzzzzzzzzzzzzzzzzc'];
  const plan7 = planRun(PLAN7, CASES.slice(0, 3), [CASES[3]], undefined, marked), plan8 = planRun(PLAN8, [CASES[0], CASES[2]], [CASES[1], CASES[3]], undefined, marked);
  const clean = Buffer.from('seat# configure widget\nseat#\n'), refused = Buffer.from('seat# configure widget\nFailed to run the synthetic command\nseat#\n');
  const read = Buffer.from('seat# configure widget\n健康检查间隔设置成功 Failed to run the synthetic command\nseat#\n');
  const rows = (items: string[], verdicts: string[], logs: Uint8Array[]) => items.map((item, k) => ({ item, dynamic_terminal: verdicts[k], evidence: { log: `src:${sha256(verdicts[k] === 'pass' ? logs[k] : log)}` } }));
  const jobOf = (id: string, run: string, plan: string, items: string[], workbook: Uint8Array, r: unknown[]) => ({ ...job(id, run, plan, items, workbook, items.map(() => 'pass')), rows: r });
  const dir = await mkdtemp(join(tmpdir(), 'cc-delivery-'));
  const notesPath = await notes({ [CASES[1]]: NOTES[CASES[1]], [CASES[3]]: NOTES[CASES[3]] });
  const refusedFinal = await hub(undefined, undefined, {
    [WHOLE2]: [jobOf('m', WHOLE2, PLAN7, CASES.slice(0, 3), plan7.workbook, rows(CASES.slice(0, 3), ['pass', 'fail', 'pass'], [clean, refused, clean]))],
    [FINAL3]: [jobOf('n', FINAL3, PLAN8, [CASES[0], CASES[2]], plan8.workbook, rows([CASES[0], CASES[2]], ['pass', 'pass'], [clean, refused]))],
  }, { [PLAN7]: plan7, [PLAN8]: plan8 }, [WHOLE2, FINAL3], false, [marked, clean, refused, read]); t.after(refusedFinal.close);
  const refusedRun = await run(refusedFinal, notesPath, join(dir, 'a'), `${WHOLE2},${FINAL3}`);
  assert.equal(refusedRun.code, 1, refusedRun.stderr);
  assert.ok(JSON.parse(refusedRun.stdout).hints.some((hint:{autoid:string})=>hint.autoid===CASES[2]));
  const pendingSummary = JSON.parse(await readFile(join(dir, 'a', 'delivery.json'), 'utf8')); assert.equal(pendingSummary.pass_volume, null); assert.equal(pendingSummary.cases[2].dispatches.at(-1).terminal, 'no_verdict'); assert.ok(pendingSummary.cases[2].pending.length);
  assert.match(await readFile(join(dir, 'a', 'delivery_report.md'), 'utf8'), /Failed to run the synthetic command/);
  const earlier = await hub(undefined, undefined, {
    [WHOLE2]: [jobOf('m', WHOLE2, PLAN7, CASES.slice(0, 3), plan7.workbook, rows(CASES.slice(0, 3), ['pass', 'fail', 'pass'], [clean, clean, refused]))],
    [FINAL3]: [jobOf('n', FINAL3, PLAN8, [CASES[0], CASES[2]], plan8.workbook, rows([CASES[0], CASES[2]], ['pass', 'pass'], [read, clean]))],
  }, { [PLAN7]: plan7, [PLAN8]: plan8 }, [WHOLE2, FINAL3], false, [marked, clean, refused, read]); t.after(earlier.close);
  const out = join(dir, 'b');
  const passed = await run(earlier, notesPath, out, `${WHOLE2},${FINAL3}`);
  assert.equal(passed.code, 0, passed.stderr);
  const summary = JSON.parse(await readFile(join(out, 'delivery.json'), 'utf8'));
  assert.deepEqual(summary.cases.map((c: { status: string }) => c.status), ['delivered', 'failed', 'delivered', 'unrun']);
  assert.deepEqual(summary.pass_audit, { markers: 1, read: 4, downgraded: [{ run: WHOLE2, item: CASES[2], where: '运行日志', line: 'Failed to run the synthetic command' }], wordless: 0 });
  assert.deepEqual(summary.cases[2].dispatches.map((d: { terminal: string }) => d.terminal), ['no_verdict', 'pass']);
  assert.match(await readFile(join(out, 'delivery_report.md'), 'utf8'), /核对设备输出后，1 条原始用例的设备输出有执行失败原话、自动化用例没有检查到，无结论/);
});

test('an audited device pass remains unknown after three recorded distinct versions', async (t) => {
  const doc = structuredClone(CONTRACT_DOC) as Record<string, unknown>;
  doc.exec_failure_markers = { source: 'reference-engine/domain_grammar.json', sha256: 'a'.repeat(64), lines: ['Failed to run the synthetic command'] };
  const marked = Buffer.from(JSON.stringify(signTypedRuntime(doc)));
  const [D1, D2, D3, LAST, P1, P2, P3, P4] = ['run_01fffffffffffffffffffffff1', 'run_01fffffffffffffffffffffff2', 'run_01fffffffffffffffffffffff3', 'run_01fffffffffffffffffffffff4', 'run_01fffffffffffffffffffffff5', 'run_01fffffffffffffffffffffff6', 'run_01fffffffffffffffffffffff7', 'run_01fffffffffffffffffffffff8'];
  const whole = CASES.slice(0, 3), rest = [CASES[0], CASES[1]];
  const p1 = planRun(P1, whole, [CASES[3]], undefined, marked), p2 = planRun(P2, whole, [CASES[3]], '2', marked), p3 = planRun(P3, whole, [CASES[3]], '3', marked), p4 = planRun(P4, rest, [CASES[2], CASES[3]], '3', marked);
  const clean = Buffer.from('seat# configure widget\nseat#\n'), refused = Buffer.from('seat# configure widget\nFailed to run the synthetic command\nseat#\n');
  const rows = (items: string[], verdicts: string[], logs: Uint8Array[]) => items.map((item, k) => ({ item, dynamic_terminal: verdicts[k], evidence: { log: `src:${sha256(verdicts[k] === 'pass' ? logs[k] : log)}` } }));
  const jobOf = (id: string, run: string, plan: string, items: string[], workbook: Uint8Array, r: unknown[]) => ({ ...job(id, run, plan, items, workbook, items.map(() => 'pass')), rows: r });
  const all = ['pass', 'pass', 'pass'], dropped = [clean, clean, refused];
  const last = [jobOf('s', LAST, P4, rest, p4.workbook, rows(rest, ['pass', 'pass'], [clean, clean]))];
  const dir = await mkdtemp(join(tmpdir(), 'cc-delivery-'));
  const note = { [CASES[2]]: { judged: '合成判断：删除后的重复删除报执行失败', remedy: '合成取舍：不再返工', evidence: 'Failed to run the synthetic command' }, [CASES[3]]: NOTES[CASES[3]] };

  const once = await hub(undefined, undefined, { [D1]: [jobOf('p', D1, P1, whole, p1.workbook, rows(whole, all, dropped))], [LAST]: last }, { [P1]: p1, [P4]: p4 }, [D1, LAST], false, [marked, clean, refused]); t.after(once.close);
  const early = await run(once, await notes(note), join(dir, 'a'), `${D1},${LAST}`);
  assert.equal(early.code, 0,early.stderr);
  const earlySummary=JSON.parse(await readFile(join(dir,'a','delivery.json'),'utf8'));
  assert.equal(earlySummary.cases[2].closing,undefined);
  assert.ok(earlySummary.cases[2].pending.some((fact:string)=>fact.includes('已核验 1 份不同自动化用例')));
  assert.equal(earlySummary.cases[2].dispatches[0].dynamic_terminal,'pass');
  assert.match(JSON.parse(early.stdout).reply,/上机 1 次，最后一次运行器报通过，这次结果没有被采用，尚不能交付。/);

  const failedFirst = rows(whole, ['pass', 'pass', 'fail'], dropped);
  const three = await hub(undefined, undefined, { [D1]: [jobOf('p', D1, P1, whole, p1.workbook, failedFirst)], [D2]: [jobOf('q', D2, P2, whole, p2.workbook, rows(whole, all, dropped))], [D3]: [jobOf('r', D3, P3, whole, p3.workbook, rows(whole, all, dropped))], [LAST]: last }, { [P1]: p1, [P2]: p2, [P3]: p3, [P4]: p4 }, [D1, D2, D3, LAST], false, [marked, clean, refused]); t.after(three.close);
  const out = join(dir, 'b');
  const closed = await run(three, await notes(note), out, LAST);
  assert.equal(closed.code, 0, closed.stderr);
  const summary = JSON.parse(await readFile(join(out, 'delivery.json'), 'utf8'));
  assert.deepEqual(summary.cases.map((c: { status: string }) => c.status), ['delivered', 'delivered', 'unsettled', 'unrun']);
  assert.deepEqual({ closing: summary.cases[2].closing, rounds: summary.cases[2].rounds, terminals: summary.cases[2].dispatches.map((d: { terminal: string }) => d.terminal) }, { closing: 'authoring_failure', rounds: 3, terminals: ['fail', 'no_verdict', 'no_verdict'] });
  assert.match(JSON.parse(closed.stdout).reply, /合成用例 103：上机 3 次、写过 3 版自动化用例，没有得到可采用的通过结论。原因（模型的分析）：合成判断：删除后的重复删除报执行失败。/);
  const report = await readFile(join(out, 'delivery_report.md'), 'utf8');
  assert.match(report, /原始用例 990000000000000103 合成用例 103：上机 3 次、写过 3 版自动化用例，没有得到可采用的通过结论。/);
  assert.match(report, /第 3 次上机验证：运行器报通过，这次结果没有被采用（设备输出有执行失败原话“Failed to run the synthetic command”，自动化用例没有检查这一行）/);
});

test('a case never dispatched closes only on a fact the Hub recorded missing for its own plan; a written claim sends it back to authoring', async (t) => {
  const h = await hub(); t.after(h.close); const out = join(await mkdtemp(join(tmpdir(), 'cc-delivery-')), 'out');
  const closed = await run(h, await notes(NOTES), out);
  assert.equal(closed.code, 0, closed.stderr);
  const summary = JSON.parse(await readFile(join(out, 'delivery.json'), 'utf8'));
  assert.equal(summary.cases[3].status, 'unrun');
  assert.equal(summary.cases[3].closing, 'missing_fact');
  assert.deepEqual(summary.cases[3].missing, { kind: 'data_gap', plan_run: GAP, requirement: 'contract_methods', missing: GAP_WORDS, attributions:['data_gap'], gaps:[{missing:GAP_WORDS,reason:'missing_input',exit:{action:'request',audience:{user:'usr_synthetic'},due:'2026-11-09T00:00:00.000Z',request_kind:'clarification'}}], exit:{action:'request',audience:{user:'usr_synthetic'},due:'2026-11-09T00:00:00.000Z',request_kind:'clarification'} });
  assert.deepEqual(summary.closings, { authoring_failure: 0, device_defect: 1, missing_fact: 1, author_conflict: 0 });
  const report = await readFile(join(out, 'delivery_report.md'), 'utf8');
  assert.match(report, /原始用例 990000000000000104 合成意图 4：缺少脚本编写所需的资料，没有上机。原因：缺资料/);
  assert.ok(report.includes(`**核对结果摘要**：${GAP_WORDS}`));
  const shadowed = await hub(undefined, undefined, {}, {}, undefined, false, [], 'shadowed'); t.after(shadowed.close);
  const shadowedOut = join(await mkdtemp(join(tmpdir(), 'cc-delivery-')), 'out');
  assert.equal((await run(shadowed, await notes(NOTES), shadowedOut)).code, 0);
  assert.equal(JSON.parse(await readFile(join(shadowedOut, 'delivery.json'), 'utf8')).cases[3].missing.plan_run, GAP);
  for (const gap of ['workbook', 'unsubmitted', 'none', 'skipped', 'skipped-spent'] as const) {
    const g = await hub(undefined, undefined, {}, {}, undefined, false, [], gap); t.after(g.close);
    const refusedOut = join(await mkdtemp(join(tmpdir(), 'cc-delivery-')), 'out');
    const refused = await run(g, await notes(NOTES), refusedOut);
    assert.equal(refused.code, 1, refused.stderr);
    assert.equal(JSON.parse(refused.stdout).hints[0].autoid, CASES[3]);
    const caseRow = JSON.parse(await readFile(join(refusedOut, 'delivery.json'), 'utf8')).cases[3];
    assert.equal(caseRow.closing, undefined, gap); assert.ok(caseRow.pending.length, gap);
  }
});

test('a plan audited again without a change is not another authored round; a changed plan is', () => {
  const inputs = (p: ReturnType<typeof planRun>) => ({ run: p.record, result: p.result, submission: p.submission, originals: {} }) as unknown as Parameters<typeof planDigest>[0];
  const first = planRun(PLAN1, CASES.slice(0, 3), [CASES[3]]), audited = structuredClone(first);
  ((audited.submission.items[1].slots.plan[0] as unknown as { data: Record<string, unknown> }).data).fidelity = { brief_sha256: 'a'.repeat(64), steps: [], disclosure: '合成：重新审计' };
  assert.equal(planDigest(inputs(audited), CASES[1]), planDigest(inputs(first), CASES[1]));
  assert.equal(planDigest(inputs(first), 'not-authored'),null,'a missing authored plan cannot become another counted round from its run ID');
  assert.notEqual(planDigest(inputs(planRun(PLAN1, CASES.slice(0, 3), [CASES[3]], '2')), CASES[1]), planDigest(inputs(first), CASES[1]));
});

test('a plan repair budget records bounded unverified observations without inventing device failure', async (t) => {
  const h = await hub(undefined, undefined, {}, {}, undefined, false, [], 'exhausted'); t.after(h.close);
  const out = join(await mkdtemp(join(tmpdir(), 'cc-delivery-')), 'out');
  const done = await run(h, await notes(NOTES), out);
  assert.equal(done.code, 0, done.stderr);
  const summary = JSON.parse(await readFile(join(out, 'delivery.json'), 'utf8'));
  assert.deepEqual([summary.cases[3].status, summary.cases[3].closing, summary.cases[3].missing.kind, summary.cases[3].missing.plan_run], ['unrun', 'authoring_failure', 'repair_exhausted', GAP]);
  const report = await readFile(join(out, 'delivery_report.md'), 'utf8');
  assert.match(report, /原始用例 990000000000000104 合成意图 4：自动化用例没有通过脚本合并的核对，没有上机。原因：生产者错误/);
  assert.ok(report.includes(`**核对结果摘要**：${SPENT_WORDS}`));
});

test('an invalid notes file is identified without echoing its content before any Hub read', async (t) => {
  const h = await hub(); t.after(h.close);
  const dir = await mkdtemp(join(tmpdir(), 'cc-notes-')), broken = join(dir, 'notes.json');
  await writeFile(broken, '{"cases":{"990000000000000102":{"judged":"合成判断：设备回 "拒绝"","remedy":"合成修法"}}}');
  const refused = await run(h, broken, join(dir, 'out'));
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /参数无效：说明文件 notes\.json 不是合法的 JSON/);
  assert.match(refused.stderr, /位置：说明文件 notes\.json/);
  assert.doesNotMatch(refused.stderr, /设备回|附近原文/);
  assert.doesNotMatch(refused.stderr, /重新导出该运行对应输入的原始字节/);
});

const CONFLICT = { author: '合成步骤', manual: '特殊字符仅支持“._-”', reference: ENTRY };
const fenced = (text: string) => ['```', text, '```'].join('\n');
test("an author's step against the manual closes a failed case at its first round and a case left unwritten without a device, checking both quotes against the locked root", async (t) => {
  const h = await hub(undefined, undefined, {}, {}, undefined, false, [], 'none'); t.after(h.close);
  const out = join(await mkdtemp(join(tmpdir(), 'cc-delivery-')), 'out');
  const written = await run(h, await notes({
    [CASES[1]]: { judged: '合成判断：设备拒绝了作者给的名字', remedy: '合成取舍：等作者或用户裁定', evidence: '第 3 步断言没有命中', author_conflict: CONFLICT },
    [CASES[3]]: { judged: '合成判断：重组时问过用户，选了先不编', remedy: '合成取舍：等作者裁定', author_conflict: { ...CONFLICT, author: '合成动作' } },
  }), out);
  assert.equal(written.code, 0, written.stderr);
  const summary = JSON.parse(await readFile(join(out, 'delivery.json'), 'utf8'));
  assert.deepEqual(summary.cases.map((c: { status: string; closing?: string }) => [c.status, c.closing ?? null]), [['delivered', null], ['failed', 'author_conflict'], ['delivered', null], ['unrun', 'author_conflict']]);
  assert.deepEqual([summary.cases[1].closing_label, summary.cases[1].rounds, summary.cases[1].conflict], ['作者步骤与手册冲突（待作者或用户裁定）', 1, CONFLICT]);
  assert.deepEqual([summary.cases[3].rounds ?? null, summary.cases[3].conflict], [null, { ...CONFLICT, author: '合成动作' }]);
  assert.deepEqual(summary.closings, { authoring_failure: 0, device_defect: 0, missing_fact: 0, author_conflict: 2 });
  assert.match(JSON.parse(written.stdout).reply, /原始用例 990000000000000102 合成用例 102：上机 1 次，原始用例与手册冲突（模型的判断，未经确认）。原因（原始用例的问题）：作者写“合成步骤”，手册写“特殊字符仅支持“\._-””。/);
  const report = await readFile(join(out, 'delivery_report.md'), 'utf8');
  assert.match(report, /原始用例 990000000000000102 合成用例 102：上机 1 次，原始用例与手册冲突（模型的判断，未经确认）。原因（原始用例的问题）：作者写“合成步骤”，手册写“特殊字符仅支持“\._-””。/);
  assert.match(report, /下一步：由使用者核对原始用例、手册和设备输出后裁定。/);
  assert.match(report, /原始用例 990000000000000104 合成意图 4：原始用例与手册冲突（模型的判断，未经确认）。原因（原始用例的问题）：作者写“合成动作”，手册写“特殊字符仅支持“\._-””。/);
  assert.match(report, /未做上机验证，这条原始用例未完成脚本编写。/);
  const quoted = (author: string) => `**证据，原始用例原句**，已按照规则核对原文。\n${fenced(author)}\n\n**证据，手册原话**，构建 ${plan1.record.build}，已按照规则核对原文。\n${fenced(CONFLICT.manual)}`;
  assert.ok(report.includes(quoted('合成步骤')) && report.includes(quoted('合成动作')), 'both sentences and the statement are shown as the tool checked them');
  assert.ok((await readFile(join(out, 'unsuccessful_cases.md'), 'utf8')).includes(quoted('合成步骤')));
  assert.doesNotMatch(report, /模型未找到解决方案/, 'the model is not blamed for a conflict the author or the user has to rule on');
});

test('invalid conflict quotes or unavailable citations remain case-local while wrong root and digest reject the batch', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-delivery-'));
  const note = (conflict: unknown) => notes({ ...NOTES, [CASES[1]]: { judged: '合成判断', remedy: '合成取舍', evidence: '第 3 步断言没有命中', author_conflict: conflict } });
  const served = await hub(); t.after(served.close);
  const refusals: Array<[string, unknown, RegExp]> = [
    ['manual', { ...CONFLICT, manual: '特殊字符仅支持“._-:”' }, /用例 990000000000000102 判断原始用例的问题时，手册引文不是所选手册的原话；逐字复制，不改写、不拼接/],
    ['author', { ...CONFLICT, author: '作者没写过这一句' }, /用例 990000000000000102 判断原始用例的问题时，原始用例引文不是标题、步骤或期望的原句；逐字复制/],
    ['entry', { ...CONFLICT, reference: `tree:${ROOT}/manual/guide/gone@${'3'.repeat(64)}` }, /所选手册不属于脚本编写时使用的手册和命令树，请使用同一构建的手册和命令树/],
    ['root', { ...CONFLICT, reference: `tree:${'d'.repeat(64)}/manual/guide/names@${'1'.repeat(64)}` }, /所选手册不属于脚本编写时使用的手册和命令树/],
  ];
  for (const [name, conflict, expected] of refusals) {
    const out = join(dir, name), refused = await run(served, await note(conflict), out);
    assert.equal(refused.code, 1, refused.stderr);
    assert.equal(JSON.parse(refused.stdout).hints[0].autoid, CASES[1]);
    const caseRow = JSON.parse(await readFile(join(out, 'delivery.json'), 'utf8')).cases[1];
    assert.equal(caseRow.closing, undefined, name); assert.match(caseRow.pending.join('；'), expected, name);
    assert.match(await readFile(join(out, 'delivery_report.md'), 'utf8'), /模型提出的手册原话.*未取得完整的逐字核对依据/);
  }
  const broken: Array<['absent' | 'tampered' | 'other-root', RegExp]> = [
    ['absent', /Hub 无法读取脚本编写时使用的手册和命令树，原始用例与手册冲突的判断尚未核对/],
    ['tampered', /手册和命令树与保存的原件不一致，原始用例与手册冲突的判断尚未核对/],
    ['other-root', /手册和命令树与脚本编写时使用的构建不一致，原始用例与手册冲突的判断尚未核对/],
  ];
  for (const [mode, expected] of broken) {
    const h = await hub(undefined, undefined, {}, {}, undefined, false, [], 'recorded', mode); t.after(h.close);
    const out = join(dir, mode), refused = await run(h, await note(CONFLICT), out);
    if (mode === 'absent') {
      assert.equal(refused.code, 1, refused.stderr);
    assert.equal(JSON.parse(refused.stdout).hints[0].autoid, CASES[1]); const row = JSON.parse(await readFile(join(out, 'delivery.json'), 'utf8')).cases[1]; assert.equal(row.closing, undefined); assert.match(row.pending.join('；'), expected);
    } else {
      assert.equal(refused.code, 1, mode); assert.match(refused.stderr, expected, mode); await assert.rejects(readdir(out), `${mode}: nothing was written`);
    }
  }
  const unread = await hub(undefined, undefined, {}, {}, undefined, false, [], 'recorded', 'absent'); t.after(unread.close);
  const plain = await run(unread, await notes(NOTES), join(dir, 'plain'));
  assert.equal(plain.code, 0, plain.stderr);
});

test('assemble-delivery retries 503 Retry-After and ECONNREFUSED on reads and stops after 60s without writing', async (t) => {
  const h = await hub(); t.after(h.close);
  let calls = 0;
  let now1 = 0;
  const pauses1: number[] = [];
  const out1 = join(await mkdtemp(join(tmpdir(), 'cc-delivery-retry-')), 'out');
  const recovered = await run(h, await notes(NOTES), out1, `${WHOLE},${FINAL}`, {
    timing: { now: () => now1, pause: async (ms) => { pauses1.push(ms); now1 += ms; } },
    fetch: async (input, init) => {
      calls++;
      if (calls === 1) return new Response('正在重启', { status: 503, headers: { 'retry-after': '5' } });
      if (calls === 2) throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
      return globalThis.fetch(input, init);
    },
  });
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.deepEqual(pauses1, [5_000, 2_000]);
  assert.deepEqual(JSON.parse(recovered.stdout).totals, { cases: 4, delivered: 2, failed: 1, unsettled: 0, unrun: 1 });

  let now2 = 0;
  const pauses2: number[] = [];
  const out2 = join(await mkdtemp(join(tmpdir(), 'cc-delivery-fail-')), 'out');
  const failed = await run(h, await notes(NOTES), out2, `${WHOLE},${FINAL}`, {
    timing: { now: () => now2, pause: async (ms) => { pauses2.push(ms); now2 += ms; } },
    fetch: async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }); },
  });
  assert.equal(failed.code, 1);
  assert.deepEqual(pauses2, [2_000, 4_000, 8_000, 8_000, 8_000, 8_000, 8_000, 8_000, 6_000]);
  assert.match(failed.stderr, /^暂时不可用：/);
  assert.match(failed.stderr, /ECONNREFUSED/);
  assert.match(failed.stderr, /已等待 60 秒并尝试 10 次/);
  assert.match(failed.stderr, /请等待 Hub 恢复或确认网络可达后用同一命令重试/);
  await assert.rejects(readdir(out2), 'nothing written when retry budget exhausted');
});

test('a --scope option is refused: the scope of a delivery is the one frozen in the Hub runs', async (t) => {
  const h = await hub();
  t.after(h.close);
  const dir = await mkdtemp(join(tmpdir(), 'cc-scope-refused-'));
  const scopePath = join(dir, 'scope-trial.md');
  await writeFile(scopePath, `范围：${CASES[0]}\n`);
  const out = join(dir, 'out');
  const refused = await run(h, await notes(NOTES), out, `${WHOLE},${FINAL}`, undefined, ['--scope', scopePath]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /^参数无效：参数写法：--hub --runs --notes --out --open 必填，--recompose --name 可选，每个只写一次/);
  await assert.rejects(readdir(out));
});

function withScope(p: ReturnType<typeof planRun>, scope: { words: string; cases: string[]; out_of_scope?: Array<{ autoid: string; title: string }> } | undefined) {
  const copy = structuredClone(p);
  const params: Record<string, unknown> = { ...(copy.record.parameters as Record<string, unknown>) };
  delete params.exclude;
  if (scope) {
    params.scope = { words: scope.words, cases: scope.cases };
    (copy.record as Record<string, unknown>).groups = [{ kind: 'case-compile', scope: { words: scope.words, cases: scope.cases, out_of_scope: scope.out_of_scope ?? [] } }];
  }
  (copy.record as { parameters: Record<string, unknown> }).parameters = params;
  return copy;
}

test('assemble-delivery refuses when runs carry conflicting frozen parameters.scope', async (t) => {
  const scopeA = { words: '本次先编 101 和 102', cases: [CASES[0], CASES[1]] };
  const scopeB = { words: '中途改成只编 101', cases: [CASES[0]] };
  const scopedPlan1 = withScope(planRun(PLAN1, [CASES[0], CASES[1]], []), scopeA);
  const scopedPlan2 = withScope(planRun(PLAN2, [CASES[0]], []), scopeB);
  const h = await hub(
    ['pass'],
    scopedPlan2.workbook,
    { [WHOLE]: [job('a', WHOLE, PLAN1, [CASES[0], CASES[1]], scopedPlan1.workbook, ['pass', 'fail'])], [FINAL]: [job('b', FINAL, PLAN2, [CASES[0]], scopedPlan2.workbook, ['pass'])] },
    { [PLAN1]: scopedPlan1, [PLAN2]: scopedPlan2 },
    [WHOLE, FINAL],
    false,
    [],
    'none',
  );
  t.after(h.close);
  const out = join(await mkdtemp(join(tmpdir(), 'cc-scope-conflict-')), 'out');
  const refused = await run(h, await notes({ [CASES[1]]: NOTES[CASES[1]] }), out, `${WHOLE},${FINAL}`);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /^参数无效：/);
  assert.match(refused.stderr, /scope/);
  assert.match(refused.stderr, new RegExp(`${PLAN1}|${WHOLE}`));
  assert.match(refused.stderr, new RegExp(`${PLAN2}|${FINAL}`));
  await assert.rejects(readdir(out));
});

test('assemble-delivery uses matching frozen Hub parameters.scope and discloses out-of-scope cases without failing closure', async (t) => {
  const scope = { words: '只做 101 和 102 两条核心场景', cases: [CASES[0], CASES[1]] };
  const scopedPlan1 = withScope(planRun(PLAN1, [CASES[0], CASES[1]], []), scope);
  const scopedPlan2 = withScope(planRun(PLAN2, [CASES[0]], []), { words: '只做 101 和 102 两条核心场景', cases: [CASES[1], CASES[0]] });
  const h = await hub(
    ['pass'],
    scopedPlan2.workbook,
    { [WHOLE]: [job('a', WHOLE, PLAN1, [CASES[0], CASES[1]], scopedPlan1.workbook, ['pass', 'fail'])], [FINAL]: [job('b', FINAL, PLAN2, [CASES[0]], scopedPlan2.workbook, ['pass'])] },
    { [PLAN1]: scopedPlan1, [PLAN2]: scopedPlan2 },
    [WHOLE, FINAL],
    false,
    [],
    'none',
  );
  t.after(h.close);
  const dir = await mkdtemp(join(tmpdir(), 'cc-scoped-delivery-'));
  const out = join(dir, 'out');
  const done = await run(h, await notes({ [CASES[1]]: NOTES[CASES[1]] }), out, `${WHOLE},${FINAL}`);
  assert.equal(done.code, 0, done.stderr);
  const payload = JSON.parse(done.stdout);
  assert.deepEqual(payload.totals, { cases: 2, delivered: 1, failed: 1, unsettled: 0, unrun: 0 });
  assert.equal(payload.in_scope_total, 2);
  assert.equal(payload.out_of_scope_total, 2);
  assert.match(payload.reply, /^原始脑图共 4 条用例，本次范围 2 条：生成成功 1 条，失败 1 条；其余 2 条不在本次范围内。\n/);
  const summary = JSON.parse(await readFile(join(out, 'delivery.json'), 'utf8'));
  assert.equal(summary.scope.source, 'hub_run_parameters');
  assert.equal(summary.scope.words, '只做 101 和 102 两条核心场景');
  assert.equal(summary.in_scope_total, 2);
  assert.equal(summary.out_of_scope_total, 2);
  assert.deepEqual(summary.out_of_scope.map((c: { autoid: string }) => c.autoid), [CASES[2], CASES[3]]);
  const report = await readFile(join(out, 'delivery_report.md'), 'utf8');
  assert.match(report, /本次范围：只做 101 和 102 两条核心场景/);
  assert.match(report, /未纳入本次范围的原始用例（2 条/);
  assert.match(report, new RegExp(`${CASES[2]} 合成意图 3`));
  assert.match(report, new RegExp(`${CASES[3]} 合成意图 4`));
});

test('assemble-delivery refuses one scoped run paired with an unscoped run, and reads frozen out_of_scope when --recompose is omitted', async (t) => {
  const scope = { words: '本次仅交付 101 与 102', cases: [CASES[0], CASES[1]], out_of_scope: [{ autoid: CASES[2], title: '合成标题 3' }, { autoid: CASES[3], title: '合成标题 4' }] };
  const scopedPlan1 = withScope(planRun(PLAN1, [CASES[0], CASES[1]], []), scope);
  const unscopedPlan2 = withScope(planRun(PLAN2, [CASES[0]], []), undefined);
  const mismatch = await hub(
    ['pass'],
    unscopedPlan2.workbook,
    { [WHOLE]: [job('a', WHOLE, PLAN1, [CASES[0], CASES[1]], scopedPlan1.workbook, ['pass', 'fail'])], [FINAL]: [job('b', FINAL, PLAN2, [CASES[0]], unscopedPlan2.workbook, ['pass'])] },
    { [PLAN1]: scopedPlan1, [PLAN2]: unscopedPlan2 },
    [WHOLE, FINAL],
    false,
    [],
    'none',
  );
  t.after(mismatch.close);
  const outConflict = join(await mkdtemp(join(tmpdir(), 'cc-scope-half-')), 'out');
  const refused = await run(mismatch, await notes({ [CASES[1]]: NOTES[CASES[1]] }), outConflict, `${WHOLE},${FINAL}`);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /^参数无效：所选运行的冻结 parameters\.scope 不一致/);
  await assert.rejects(readdir(outConflict));

  const scopedPlan2 = withScope(planRun(PLAN2, [CASES[0]], []), scope);
  const noRecompose = await hub(
    ['pass'],
    scopedPlan2.workbook,
    { [WHOLE]: [job('a', WHOLE, PLAN1, [CASES[0], CASES[1]], scopedPlan1.workbook, ['pass', 'fail'])], [FINAL]: [job('b', FINAL, PLAN2, [CASES[0]], scopedPlan2.workbook, ['pass'])] },
    { [PLAN1]: scopedPlan1, [PLAN2]: scopedPlan2 },
    [WHOLE, FINAL],
    false,
    [],
    'none',
  );
  t.after(noRecompose.close);
  const outNoRec = join(await mkdtemp(join(tmpdir(), 'cc-scope-norec-')), 'out');
  const notesPath = await notes({ [CASES[1]]: NOTES[CASES[1]] });
  const ok = await outputOf(() => main(['--hub', noRecompose.url, '--runs', `${WHOLE},${FINAL}`, '--notes', notesPath, '--out', outNoRec, '--name', '合成无重组批', '--open', PLAIN_OPEN], async () => TOKEN, () => new Date('2026-11-08T08:00:00Z')));
  assert.equal(ok.code, 0, ok.stderr);
  const summary = JSON.parse(await readFile(join(outNoRec, 'delivery.json'), 'utf8'));
  assert.equal(summary.in_scope_total, 2);
  assert.equal(summary.out_of_scope_total, 2);
  assert.deepEqual(summary.out_of_scope, scope.out_of_scope);
  const report = await readFile(join(outNoRec, 'delivery_report.md'), 'utf8');
  assert.match(report, /990000000000000103 合成标题 3/);
  assert.match(report, /990000000000000104 合成标题 4/);

  const partialScope = { words: '本次仅交付 101 与 102', cases: [CASES[0], CASES[1]] };
  const scopedSinglePlan = withScope(planRun(PLAN1, [CASES[0]], []), partialScope);
  const unclosed = await hub(
    ['pass'],
    scopedSinglePlan.workbook,
    { [WHOLE]: [job('a', WHOLE, PLAN1, [CASES[0]], scopedSinglePlan.workbook, ['pass'])] },
    { [PLAN1]: scopedSinglePlan },
    [WHOLE],
    false,
    [],
    'none',
  );
  t.after(unclosed.close);
  const outUnclosed = join(await mkdtemp(join(tmpdir(), 'cc-scope-unclosed-')), 'out');
  const blocked = await run(unclosed, await notes({ [CASES[1]]: NOTES[CASES[1]] }), outUnclosed, WHOLE);
  assert.equal(blocked.code, 1, blocked.stderr);
  assert.equal(JSON.parse(blocked.stdout).hints[0].autoid, CASES[1]);
  const pendingCase = JSON.parse(await readFile(join(outUnclosed, 'delivery.json'), 'utf8')).cases.find((c: { autoid: string }) => c.autoid === CASES[1]);
  assert.ok(pendingCase.pending.length); assert.equal(pendingCase.closing, undefined);

  const narrowScope = { words: '只交付 101', cases: [CASES[0]] };
  const narrowedPlan = withScope(planRun(PLAN1, [CASES[0]], []), narrowScope);
  const strayDispatch = await hub(
    ['pass'],
    narrowedPlan.workbook,
    { [WHOLE]: [job('a', WHOLE, PLAN1, [CASES[0], CASES[1]], narrowedPlan.workbook, ['pass', 'pass'])] },
    { [PLAN1]: narrowedPlan },
    [WHOLE],
    false,
    [],
    'none',
  );
  t.after(strayDispatch.close);
  const outStray = join(await mkdtemp(join(tmpdir(), 'cc-scope-stray-')), 'out');
  const refusedStray = await run(strayDispatch, await notes({}), outStray, WHOLE);
  assert.equal(refusedStray.code, 1);
  assert.match(refusedStray.stderr, new RegExp(`^参数无效：上机验证 ${WHOLE} 包含未纳入本次 parameters\\.scope 的原始用例 ${CASES[1]}`));
  await assert.rejects(readdir(outStray));
});

test('assemble-delivery retains out_of_scope disclosure when both --recompose and parameters.scope were scoped (red-then-green)', async (t) => {
  const scope = {
    words: '从重组起仅编 101 和 102',
    cases: [CASES[0], CASES[1]],
    out_of_scope: [
      { autoid: CASES[2], title: '合成标题 3' },
      { autoid: CASES[3], title: '合成标题 4' },
    ],
  };
  const scopedRecomp = {
    run: RECOMPOSE,
    items: recomposed.items.slice(0, 2),
    groups: [{ kind: 'recompose-scope@1', scope }],
  };
  const scopedPlan1 = withScope(planRun(PLAN1, [CASES[0], CASES[1]], []), scope);
  const scopedPlan2 = withScope(planRun(PLAN2, [CASES[0]], []), scope);
  const h = await hub(
    ['pass'],
    scopedPlan2.workbook,
    {
      [WHOLE]: [job('a', WHOLE, PLAN1, [CASES[0], CASES[1]], scopedPlan1.workbook, ['pass', 'fail'])],
      [FINAL]: [job('b', FINAL, PLAN2, [CASES[0]], scopedPlan2.workbook, ['pass'])],
    },
    { [PLAN1]: scopedPlan1, [PLAN2]: scopedPlan2 },
    [WHOLE, FINAL],
    false,
    [],
    'none',
    'served',
    scopedRecomp,
  );
  t.after(h.close);
  const out = join(await mkdtemp(join(tmpdir(), 'cc-scope-recomp-out-')), 'out');
  const done = await run(h, await notes({ [CASES[1]]: NOTES[CASES[1]] }), out, `${WHOLE},${FINAL}`);
  assert.equal(done.code, 0, done.stderr);
  const summary = JSON.parse(await readFile(join(out, 'delivery.json'), 'utf8'));
  assert.equal(summary.in_scope_total, 2);
  assert.equal(summary.out_of_scope_total, 2);
  assert.deepEqual(summary.out_of_scope, scope.out_of_scope);
  const report = await readFile(join(out, 'delivery_report.md'), 'utf8');
  assert.match(report, /未纳入本次范围的原始用例（2 条/);
  assert.match(report, new RegExp(`${CASES[2]} 合成意图 3|${CASES[2]} 合成标题 3`));
  assert.match(report, new RegExp(`${CASES[3]} 合成意图 4|${CASES[3]} 合成标题 4`));
});


test('a missing pass-review original leaves local unknown eligibility while a mismatching digest refuses the batch',async(t)=>{
  const declared=structuredClone(CONTRACT_DOC) as Record<string,unknown>;
  declared.exec_failure_markers={source:'synthetic-rule.json',sha256:'a'.repeat(64),lines:['Synthetic declared failure']};
  const marked=Buffer.from(JSON.stringify(signTypedRuntime(declared)));
  const plan=planRun(PLAN1,CASES.slice(0,3),[CASES[3]],undefined,marked);
  const output=Buffer.from('synthetic unique device-output original');
  const sourceSha=sha256(output);
  const checkedJob={...job('a',WHOLE,PLAN1,CASES.slice(0,3),plan.workbook,['pass','pass','pass']),rows:CASES.slice(0,3).map(item=>({item,dynamic_terminal:'pass',qualifier:{nature:'judgment',marks:['target_reported']},accepted_as_fact:false,evidence:{log:`src:${sourceSha}`}}))};
  const dir=await mkdtemp(join(tmpdir(),'cc-missing-original-'));
  for(const mode of ['absent','tampered'] as const){
    const h=await hub(undefined,undefined,{[WHOLE]:[checkedJob]},{[PLAN1]:plan},[WHOLE],false,[marked,output],'recorded','served',recomposed,{sha:sourceSha,mode});t.after(h.close);
    const out=join(dir,mode);const result=await run(h,await notes({}),out,WHOLE);
    if(mode==='tampered'){
      assert.equal(result.code,1);assert.match(result.stderr,/字节与摘要不一致/);assert.deepEqual(await readdir(out).catch(()=>[]),[]);
    }else{
      assert.equal(result.code,0,result.stderr);
      const summary=JSON.parse(await readFile(join(out,'delivery.json'),'utf8'));
      assert.equal(summary.pass_volume,null);
      assert.ok(summary.cases.slice(0,3).every((c:{status:string;pending:string[];dispatches:Array<{dynamic_terminal:string;accepted_as_fact:boolean}>})=>c.status==='unsettled'&&c.pending.length&&c.dispatches[0].dynamic_terminal==='pass'&&c.dispatches[0].accepted_as_fact===false));
      assert.deepEqual(summary.artifacts.slice().sort(),(await readdir(out)).sort());
      const report=await readFile(join(out,'delivery_report.md'),'utf8');assert.doesNotMatch(report.split('交付物：')[1],/(^|、)case\.xlsx/);
    }
  }
});


test('assembly opts into immutable source caching while fresh run and job metadata is read again',async(t)=>{
  const h=await hub();t.after(h.close);
  const root=await mkdtemp(join(tmpdir(),'cc-assembly-cache-'));
  const cache=join(root,'cache');const noteFile=await notes(NOTES);
  assert.equal((await run(h,noteFile,join(root,'first'),undefined,{sourceCacheDirectory:cache})).code,0);
  const first=h.requests.splice(0);
  assert.ok(first.some(path=>path.includes('/sources/')));
  assert.equal((await run(h,noteFile,join(root,'second'),undefined,{sourceCacheDirectory:cache})).code,0);
  const second=h.requests;
  assert.deepEqual(second.filter(path=>!path.includes('/sources/')),first.filter(path=>!path.includes('/sources/')),'run/job/successor responses are always fresh');
  assert.equal(second.filter(path=>path.includes('/sources/')).length,0,'only previously digest-verified source bytes are reused');
  for(const path of first.filter(path=>path.includes('/sources/'))){
    const runPath=path.split('/sources/')[0];
    assert.ok(first.findIndex(candidate=>candidate===runPath||candidate===runPath+'/run'||candidate===runPath+'/jobs')<first.indexOf(path),'a source hit follows fresh metadata for its run');
  }
});


test('an excluded preceding item cannot shift the latest failed recipe to another case',async(t)=>{
  const plan=planRun(PLAN1,CASES.slice(0,3),[CASES[0],CASES[3]]);
  const h=await hub(undefined,undefined,{[WHOLE]:[job('a',WHOLE,PLAN1,[CASES[1],CASES[2]],plan.workbook,['fail','pass'])]},{[PLAN1]:plan});t.after(h.close);
  const out=join(await mkdtemp(join(tmpdir(),'cc-excluded-preceding-')),'out');
  const result=await run(h,await notes(NOTES),out);
  assert.equal(result.code,0,result.stderr);
  const recipes=satisfiedRecipes({run:plan.record,result:plan.result,submission:plan.submission,contract,profile,inventory});
  assert.deepEqual(recipes.map(recipe=>recipe.fields.autoid),[CASES[1],CASES[2]]);
  assert.deepEqual(await readFile(join(out,'unsuccessful_cases.xlsx')),Buffer.from(generateWorkbookSet(recipes.filter(recipe=>recipe.fields.autoid===CASES[1]),{merged:true})));
  const summary=JSON.parse(await readFile(join(out,'delivery.json'),'utf8'));
  assert.deepEqual(summary.unsuccessful_volume.items.map((item:{autoid:string})=>item.autoid),[CASES[1]]);
});

test('each dispatched item list must match the actual generated workbook',async(t)=>{
  const h=await hub(undefined,undefined,{[FINAL]:[job('b',FINAL,PLAN2,[CASES[0]],plan2.workbook,['pass'])]});t.after(h.close);
  const out=join(await mkdtemp(join(tmpdir(),'cc-workbook-binding-')),'out');
  const result=await run(h,await notes(NOTES),out);
  assert.equal(result.code,1,'a partial job item list must not ship the larger workbook');assert.match(result.stderr,/用例清单.*实际工作簿/);
  assert.deepEqual(await readdir(out).catch(()=>[]),[]);
});

test('every dispatched workbook digest must match its original plan even outside the final pass volume',async(t)=>{
  const earlier=job('a',WHOLE,PLAN1,CASES.slice(0,3),Buffer.from('different synthetic workbook'),['pass','fail','pass']);
  const h=await hub(undefined,undefined,{[WHOLE]:[earlier]});t.after(h.close);
  const out=join(await mkdtemp(join(tmpdir(),'cc-workbook-binding-')),'out');
  const result=await run(h,await notes(NOTES),out);
  assert.equal(result.code,1,'an earlier dispatch digest mismatch must not become case-local pending');assert.match(result.stderr,/工作簿摘要.*脚本编写结果/);
  assert.deepEqual(await readdir(out).catch(()=>[]),[]);
});

test('a verification run the model names that never reached the bed is skipped like a discovered one, and its reason is disclosed', async (t) => {
  const STUCK = 'run_01ssssssssssssssssssssssss';
  const reason = '该床尚未恢复，不能派发。来源探针 synthetic-probe';
  const next = '由bed-admin按 interactive: 同步节点配置态的清理需人工确认后执行 处理后重开';
  const notSent = { job: 'c'.repeat(64), verification_run: STUCK, plan_run: PLAN2, items: [CASES[0], CASES[2]], sha256: sha256(plan2.workbook), ended: 'done', outcome: 'not_dispatched', frozen: false, result: null, device_return: null, rows: null, missing_facts: [{ fact: reason, next_action: next }], next_action: next };
  const h = await hub(undefined, undefined, { [STUCK]: [notSent] }, {}, [WHOLE, STUCK, FINAL]);
  t.after(() => h.close());
  const out = join(await mkdtemp(join(tmpdir(), 'cc-delivery-')), 'delivery');
  const result = await run(h, await notes(NOTES), out, `${WHOLE},${FINAL},${STUCK}`);
  assert.equal(result.code, 0, result.stderr);
  const printed = JSON.parse(result.stdout);
  assert.deepEqual(printed.runs, [WHOLE, FINAL], 'a run that never reached the bed is not a run of the cases');
  const summary = JSON.parse(await readFile(join(out, 'delivery.json'), 'utf8'));
  assert.equal(summary.unsent_runs[0].run, STUCK);
  assert.equal(summary.unsent_runs[0].missing_facts[0].fact, reason);
  const report = await readFile(join(out, 'delivery_report.md'), 'utf8');
  assert.match(report, /没有发到设备/);
  assert.match(report, /由bed-admin/);
});

test('run31 unsuccessful volume uses the last authored plan even when its verification never reached the bed', async t => {
  const STUCK = 'run_01ssssssssssssssssssssssss', PLAN3 = 'run_01tttttttttttttttttttttttt';
  const plan3 = planRun(PLAN3, [CASES[1]], [CASES[0], CASES[2], CASES[3]], '99');
  const unsent = { job: 'f'.repeat(64), verification_run: STUCK, plan_run: PLAN3, items: [CASES[1]], sha256: sha256(plan3.workbook), ended: 'done', outcome: 'not_dispatched', frozen: false, result: null, device_return: null, rows: null, missing_facts: [{ fact: '合成测试环境配置尚未恢复', next_action: '由测试环境管理员恢复后重开' }] };
  const h = await hub(undefined, undefined, { [STUCK]: [unsent] }, { [PLAN3]: plan3 }, [WHOLE, FINAL, STUCK]); t.after(h.close);
  const out = join(await mkdtemp(join(tmpdir(), 'cc-run31-')), 'delivery');
  const result = await run(h, await notes(NOTES), out, `${FINAL},${STUCK}`);
  assert.equal(result.code, 0, result.stderr);
  const expected = generateWorkbookSet(satisfiedRecipes({ run: plan3.record, result: plan3.result, submission: plan3.submission, contract, profile, inventory }), { merged: true });
  assert.deepEqual(await readFile(join(out, 'unsuccessful_cases.xlsx')), Buffer.from(expected));
  const summary = JSON.parse(await readFile(join(out, 'delivery.json'), 'utf8'));
  assert.equal(summary.unsuccessful_volume.items[0].plan_run, PLAN3);
  assert.equal(summary.cases.find((c: {autoid:string}) => c.autoid === CASES[1]).dispatches.length, 1, 'the unissued writing does not create an observed device attempt');
  const other = join(await mkdtemp(join(tmpdir(), 'cc-run31-')), 'delivery');
  const discovered = await run(h, await notes(NOTES), other, FINAL);
  assert.equal(discovered.code, 0, discovered.stderr);
  assert.deepEqual(JSON.parse(await readFile(join(other, 'delivery.json'), 'utf8')).unsent_runs, summary.unsent_runs);
});

test('run31 unrecognized unrun cases return a named repair form and a nonzero status without inventing a round', async t => {
  const h = await hub(undefined, undefined, {}, {}, undefined, false, [], 'none'); t.after(h.close);
  const data = structuredClone(NOTES) as Record<string, Record<string, unknown>>; data[CASES[3]].round = 1;
  const out = join(await mkdtemp(join(tmpdir(), 'cc-run31-')), 'delivery');
  const result = await run(h, await notes(data), out);
  assert.equal(result.code, 1);
  const stdout = JSON.parse(result.stdout);
  const hint = stdout.hints.find((h: {autoid:string}) => h.autoid === CASES[3]);
  assert.ok(hint.missing); assert.match(hint.next_action, /Hub.*具名|author_conflict/); assert.match(hint.legal_form, /author_conflict/);
  const summary = JSON.parse(await readFile(join(out, 'delivery.json'), 'utf8'));
  assert.equal(summary.cases.find((c: {autoid:string}) => c.autoid === CASES[3]).model_claims.round, undefined);
});

test('run31 an observed case excludes stale workbook gaps but preserves the device mapped failure and Hub no-verdict', async t => {
  const modified = structuredClone(plan2);
  const row = (modified.result.partitions.delivered as Array<{item:string;requirements:Array<Record<string,unknown>>}>)[1];
  Object.assign(row.requirements.find(r => r.requirement === 'workbook_verified')!, { status: 'pending', layers: [{ layer: 'static', terminal: 'unchecked', reason: 'missing_input', attribution: 'data_gap', missing: '合成早期工作簿尚未生成', exit: { action: 'request', request_kind: 'clarification', audience: { user: 'usr_synthetic' }, due: '2026-11-09T00:00:00.000Z' } }] });
  const second = job('b', FINAL, PLAN2, [CASES[0], CASES[2]], plan2.workbook, ['pass', 'no_verdict']);
  Object.assign(second.rows[1], { report_check: { mapped_terminal: 'fail' }, missing_facts: ['closed'], missing_fact: '动态完整性前提 closed 未满足', next_action: '请管理员补齐前提 closed', evidence: { log: `src:${sha256(log)}` } });
  const h = await hub(undefined, undefined, { [FINAL]: [second] }, { [PLAN2]: modified }); t.after(h.close);
  const out = join(await mkdtemp(join(tmpdir(), 'cc-run31-')), 'delivery');
  const result = await run(h, await notes({ ...NOTES, [CASES[2]]: { judged: '合成设备自报错误，Hub 尚未采用', remedy: '由测试环境管理员核对前提', evidence: '第 3 步断言没有命中' } }), out, FINAL);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = await readFile(join(out, 'delivery_report.md'), 'utf8');
  const section = report.split(`## 原始用例 ${CASES[2]}`)[1].split('\n##')[0];
  assert.doesNotMatch(section, /合成早期工作簿尚未生成|\bclosed\b|usr_synthetic/);
  assert.match(section, /第 2 次上机验证：运行器报未通过，这次结果没有被采用。/);
  const summary = JSON.parse(await readFile(join(out, 'delivery.json'), 'utf8'));
  const observed = summary.cases.find((c:{autoid:string})=>c.autoid===CASES[2]).dispatches.at(-1);
  assert.equal(observed.terminal, 'no_verdict');
  assert.equal(observed.report_check.mapped_terminal, 'fail');
  assert.equal(observed.missing_fact, '动态完整性前提 closed 未满足');
});

test('run31 a compilation with only unissued jobs discloses the known reason without fabricating device attempts', async t => {
  const STUCK = 'run_01ssssssssssssssssssssssss';
  const pending = { job: 'f'.repeat(64), verification_run: STUCK, plan_run: PLAN1, items: CASES.slice(0,3), sha256: sha256(plan1.workbook), ended: 'done', outcome: 'not_dispatched', frozen: false, result: null, device_return: null, rows: null, missing_facts: [{ fact: '合成测试环境配置尚未恢复', next_action: '由测试环境管理员恢复后重开' }] };
  const h=await hub(undefined,undefined,{[STUCK]:[pending]},{},[STUCK]);t.after(h.close);
  const out=join(await mkdtemp(join(tmpdir(),'cc-run31-')),'delivery');
  const result=await run(h,await notes(Object.fromEntries(CASES.map(id=>[id,{judged:'合成说明：没有上机',remedy:'由测试环境管理员恢复后重开'}]))),out,STUCK);
  assert.equal(result.code,0,result.stderr||result.stdout);
  const summary=JSON.parse(await readFile(join(out,'delivery.json'),'utf8'));
  assert.equal(summary.dispatches.length,0);assert.equal(summary.unsent_runs.length,1);
  assert.ok(summary.cases.every((c:{dispatches:unknown[]})=>c.dispatches.length===0));
  const report=await readFile(join(out,'delivery_report.md'),'utf8');
  assert.match(report,/合成测试环境配置尚未恢复/);assert.match(report,/由测试环境管理员恢复后重开/);
  assert.doesNotMatch(report,/已按照规则核对设备输出|执行器规则没有说明/);
});

test('run31 a later actual attempt supersedes an older unissued attempt of the identical writing', async t => {
  const STUCK='run_01ssssssssssssssssssssssss';
  const pending={job:'f'.repeat(64),verification_run:STUCK,plan_run:PLAN1,items:CASES.slice(0,3),sha256:sha256(plan1.workbook),ended:'done',outcome:'not_dispatched',frozen:false,result:null,device_return:null,rows:null,missing_facts:[{fact:'合成环境曾未恢复',next_action:'由测试环境管理员恢复后重开'}]};
  for (const order of [[STUCK,WHOLE,FINAL],[WHOLE,STUCK,FINAL]]) {
  const h=await hub(undefined,undefined,{[STUCK]:[pending]},{},order);t.after(h.close);
  const out=join(await mkdtemp(join(tmpdir(),'cc-run31-')),'delivery');
  const result=await run(h,await notes(NOTES),out,`${STUCK},${FINAL}`);
  assert.equal(result.code,0,result.stderr||result.stdout);
  const summary=JSON.parse(await readFile(join(out,'delivery.json'),'utf8'));
  assert.equal(summary.unsuccessful_volume.items[0].run,WHOLE);
  const section=(await readFile(join(out,'delivery_report.md'),'utf8')).split(`## 原始用例 ${CASES[1]}`)[1].split('\n##')[0];
  assert.match(section,/本卷这条写法已在第 1 次上机验证中执行/);
  assert.doesNotMatch(section,/这份写法尚未发到设备/);
  }
});

test('run31 unissued history has the same chronological order whether earlier runs are explicit or discovered', async t => {
  const STUCK='run_01ssssssssssssssssssssssss',NEWER='run_01uuuuuuuuuuuuuuuuuuuuuuuu',PLAN3='run_01tttttttttttttttttttttttt';
  const plan3=planRun(PLAN3,[CASES[1]],[CASES[0],CASES[2],CASES[3]],'99');
  const pending=(run:string,id:string)=>({job:id.repeat(64),verification_run:run,plan_run:PLAN3,items:[CASES[1]],sha256:sha256(plan3.workbook),ended:'done',outcome:'not_dispatched',frozen:false,result:null,device_return:null,rows:null,missing_facts:[{fact:'合成环境尚未恢复',next_action:'由测试环境管理员恢复后重开'}]});
  const h=await hub(undefined,undefined,{[STUCK]:[pending(STUCK,'f')],[NEWER]:[pending(NEWER,'e')]},{[PLAN3]:plan3},[WHOLE,FINAL,STUCK,NEWER]);t.after(h.close);
  const read=async(runs:string)=>{const out=join(await mkdtemp(join(tmpdir(),'cc-run31-')),'delivery');const result=await run(h,await notes(NOTES),out,runs);assert.equal(result.code,0,result.stderr||result.stdout);return JSON.parse(await readFile(join(out,'delivery.json'),'utf8')).unsent_runs;};
  const explicit=await read(`${STUCK},${NEWER}`),discovered=await read(NEWER);
  assert.deepEqual(discovered,explicit);
  assert.deepEqual(await read(`${STUCK},${STUCK},${NEWER}`), explicit, 'a run is still one run when named twice');
  assert.deepEqual(discovered.map((r:{run:string})=>r.run),[STUCK,NEWER]);
});

test('CLI reads case-bound card decisions without changing frozen scope and leaves absent decisions unchanged',async(t)=>{
 const {spawn}=await import('node:child_process');const {fileURLToPath}=await import('node:url');const {rm}=await import('node:fs/promises');
 const h=await hub(undefined,undefined,{}, {},undefined,false,[],'none');t.after(h.close);
 const dir=await mkdtemp(join(tmpdir(),'delivery-card-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const notesPath=await notes({[CASES[1]]:{judged:'合成冲突',remedy:'合成下一步',evidence:'第 3 步断言没有命中',author_conflict:CONFLICT},[CASES[3]]:{judged:'合成冲突',remedy:'合成下一步',author_conflict:{...CONFLICT,author:'合成动作'}}});
 const ruling='使用者决定：保留原始用例，暂不编写';await writeFile(join(dir,'scope.md'),`# 使用者原话，由主会话记录\n## 用例 ${CASES[3]}\n${ruling}\n`);
 const cli=(out:string)=>new Promise<{code:number|null;stdout:string;stderr:string}>((done,reject)=>{const child=spawn(process.execPath,[fileURLToPath(new URL('./assemble-delivery.ts',import.meta.url)),'--hub',h.url,'--runs',`${WHOLE},${FINAL}`,'--recompose',RECOMPOSE,'--notes',notesPath,'--out',out,'--open',PLAIN_OPEN],{cwd:dir});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('close',code=>done({code,stdout,stderr}));child.stdin.end(TOKEN+'\n');});
 const out=join(dir,'with-card'),result=await cli(out);assert.equal(result.code,0,result.stderr);
 const summary=JSON.parse(await readFile(join(out,'delivery.json'),'utf8'));assert.equal(summary.cases.length,4);assert.deepEqual(summary.cases.find((c:any)=>c.autoid===CASES[3]).user_rulings,[{source:'scope.md',target:CASES[3],ruling}]);assert.equal(summary.cases.find((c:any)=>c.autoid===CASES[1]).user_rulings,undefined);
 const report=await readFile(join(out,'delivery_report.md'),'utf8');assert.match(report,/下一步：等作者裁定原始用例。/);assert.ok(report.includes(ruling));assert.match(report,/下一步：由使用者核对原始用例、手册和设备输出后裁定/);
 await rm(join(dir,'scope.md'));const plainOut=join(dir,'without-card'),plain=await cli(plainOut);assert.equal(plain.code,0,plain.stderr);assert.doesNotMatch(await readFile(join(plainOut,'delivery_report.md'),'utf8'),/下一步：等作者裁定原始用例/);
});

test('a delivered case whose plan stands on a checkpoint the model wrote itself says so in the reply, the report and the machine summary', async (t) => {
  const marked = { ...plan2, result: structuredClone(plan2.result) as typeof plan2.result };
  const entry = (marked.result.partitions.delivered as Array<{ item: string; requirements: Array<{ requirement: string; claims: unknown[] }> }>).find((row) => row.item === `case-${CASES[0]}`)!;
  const grounded = entry.requirements.find((row) => row.requirement === 'expected_grounded')!;
  const checkpoint = { criterion: 'c_sig', expectation: 'rec-expectation', assertion: 'a_sig', basis: 'model_judgment', kind: 'literal', operator: 'abs_found', literal: 'SYNTH-SIG', quote: { reference: `src:${'a'.repeat(64)}/kityminder@1/n/expected`, text: '合成应答带有签名记录' }, rationale: '合成理由：选应答里的签名记录名', reviewed: false, status: '未确认', decided_by: '模型', conditional_on_judgment: true };
  grounded.claims = [{ statement: { verdict: 'support', data: { typed_criteria: [], model_criteria: [checkpoint] } } }];
  const h = await hub(undefined, undefined, {}, { [PLAN2]: marked }); t.after(h.close);
  const out = join(await mkdtemp(join(tmpdir(), 'cc-delivery-')), 'out');
  const { code, stdout, stderr } = await run(h, await notes(NOTES), out);
  assert.equal(code, 0, stderr);
  const reply = String(JSON.parse(stdout).reply).split('\n');
  assert.ok(reply.includes('生成成功的用例里有 1 条含模型拟定的检查点（共 1 处），建议复核，逐项见交付报告。'), reply.join('\n'));
  assert.ok(!reply.some((line) => line.includes(`原始用例 ${CASES[0]} `) || line.includes(`原始用例 ${CASES[2]} `)));
  const report = await readFile(join(out, 'delivery_report.md'), 'utf8');
  assert.ok(report.includes(`- 原始用例 ${CASES[0]} 合成用例 101（含 1 处模型拟定的检查点）\n- 原始用例 ${CASES[2]} 合成用例 103\n`), report);
  assert.ok(report.includes(`## 需要复核的检查点\n\n模型拟定的检查点：`), report);
  assert.match(report, /模型拟定的检查点：原始用例的这些期望没有给出具体取值，检查点由模型拟定，是模型的判断，未经独立复核/);
  assert.ok(report.includes('- 期望「合成应答带有签名记录」：检查点「SYNTH-SIG」。模型的理由：合成理由：选应答里的签名记录名'), report);
  assert.equal(report.split('模型拟定的检查点：').length - 1, 1, 'only the case that stands on one lists it');
  const summary = JSON.parse(await readFile(join(out, 'delivery.json'), 'utf8'));
  assert.deepEqual(summary.cases[0].model_checkpoints, [{ expectation: '合成应答带有签名记录', literal: 'SYNTH-SIG', rationale: '合成理由：选应答里的签名记录名' }]);
  assert.equal(summary.cases[2].model_checkpoints, undefined);
});

const STOPPED = Buffer.from([
  '2026-11-17 07:08:56 #######   step2: 合成分组>合成用例 101',
  '2026-11-17 07:08:58 #######   step9: 按声明的行列结构取一格',
  '2026-11-17 07:09:03 ################# The failed check point num:   0   ####',
  '2026-11-17 07:09:03 ################# The passed check point num:   0   ####',
  '2026-11-17 07:09:03 >       return invoke(request, logger, checker)',
  '2026-11-17 07:09:03 runner/workbook_runner.py:101: in run_workbook',
  '2026-11-17 07:09:03 E       runner.CellSelectionError: 取不到：没有符合声明形状的行；位置：数据行',
  '2026-11-17 07:09:03 ######################      FAIL      ####################',
].join('\n') + '\n');
const NOT_COMPLETE = { condition: 'result.complete', pointer: '/complete', declared_pointer: '/complete', resolved: false, present: true, actual_sha256: 'e'.repeat(64), result_definition_sha256: 'f'.repeat(64), missing_fact: '结果完整字段 /complete 尚不为 true，缺完整报告', next_action: '按该指针对照已保存原件：原件未齐时稍后 job resume；不重交' };
const stoppedWhole = () => {
  const stopped = job('a', WHOLE, PLAN1, CASES.slice(0, 3), plan1.workbook, ['no_verdict', 'no_verdict', 'no_verdict']);
  stopped.rows.forEach((row, k) => Object.assign(row, { report_check: NOT_COMPLETE, missing_facts: ['complete', 'closed', 'report'], missing_fact: NOT_COMPLETE.missing_fact, next_action: NOT_COMPLETE.next_action, ...(k === 0 ? { evidence: { log: `src:${sha256(STOPPED)}` } } : {}) }));
  return stopped;
};
const WHY = `同一份自动化用例 Excel 中排在前面的原始用例 ${CASES[0]} 合成用例 101 在第 9 步出现异常，运行器中止了整本，本条没有在设备上执行`, NEXT = '修正前一条后重新上机；本次不算本条的一次上机';

test('the cases a stopped run did not reach are reported as not executed with the reason and the next step, and none of them counts as a device attempt', async (t) => {
  const h = await hub(undefined, undefined, { [WHOLE]: [stoppedWhole()] }, {}, [WHOLE], false, [STOPPED]); t.after(h.close);
  const dir = await mkdtemp(join(tmpdir(), 'cc-delivery-')), out = join(dir, 'out');
  const note = { ...NOTES, [CASES[0]]: { judged: '合成判断：取格失败，运行器中止了整本', remedy: '合成取舍：改取格条件后重新上机', evidence: 'runner.CellSelectionError: 取不到：没有符合声明形状的行；位置：数据行' } };
  const { code, stdout, stderr } = await run(h, await notes({ ...note, [CASES[1]]: { judged: '合成说明', remedy: '合成下一步' } }), out, WHOLE);
  assert.equal(code, 0, stderr);
  const summary = JSON.parse(await readFile(join(out, 'delivery.json'), 'utf8'));
  assert.deepEqual(summary.totals, { cases: 4, delivered: 0, failed: 0, unsettled: 1, unrun: 3 });
  const [first, second, third] = summary.cases;
  assert.deepEqual([first.status, first.dispatches.map((d: { terminal: string }) => d.terminal), first.not_executed], ['unsettled', ['no_verdict'], undefined], 'the case that stopped the run keeps the verdict the Hub gave it');
  for (const c of [second, third]) {
    assert.deepEqual([c.status, c.dispatches], ['unrun', []], 'no device attempt');
    assert.deepEqual(c.not_executed, [{ ordinal: 1, run: WHOLE, job: 'a'.repeat(64), plan_run: PLAN1, by: { item: CASES[0], step: 9 }, reason: WHY, next_action: NEXT }]);
    assert.equal(c.reenter, true, 'it is taken up again once the case before it is corrected');
    assert.equal(c.basis, undefined, 'its workbook was verified and dispatched, so the plan run\'s pending workbook step says nothing about it');
  }
  assert.deepEqual(summary.unsuccessful_volume.items.map((c: { autoid: string }) => c.autoid), [CASES[0], CASES[1], CASES[2]], 'their plans are in the unsuccessful volume');
  assert.equal(summary.incomplete, false);
  const report = await readFile(join(out, 'delivery_report.md'), 'utf8');
  assert.ok(report.includes(`原始用例 ${CASES[1]} 合成用例 102：没有在设备上执行，无结论。原因：${WHY}。下一步：${NEXT}。`), report);
  assert.ok(report.includes(`第 1 次未执行：${WHY}。`), report);
  assert.ok(JSON.parse(stdout).reply.includes(`原始用例 ${CASES[2]} 合成用例 103：没有在设备上执行，无结论。`));
  assert.doesNotMatch(report, new RegExp(`原始用例 ${CASES[1]}[^\\n]*(稍后 job resume|完整字段)`), 'the Hub advice for a report that is not yet complete does not stand for a case that did not run');

  const claimed = await run(h, await notes({ ...note, [CASES[1]]: { judged: '合成说明', remedy: '合成下一步', round: 1 } }), join(dir, 'claimed'), WHOLE);
  assert.equal(claimed.code, 1);
  assert.deepEqual(JSON.parse(claimed.stdout).hints.map((hint: { autoid: string; missing: string }) => [hint.autoid, hint.missing]), [[CASES[1], '本条没有到过设备，不能声明上机轮次']]);
});

test('two compiles of one mind map under one booking are two lineages: a late-bound plan run is known by its recompose run, as its merge run is', () => {
  const SUBJECT = 'src:' + '1'.repeat(64), FIRST = 'rec:' + 'a'.repeat(64), SECOND = 'rec:' + 'b'.repeat(64), RESULT = 'rec:' + 'c'.repeat(64);
  const plan = (record: string) => [{ slot: 'subject', reference: SUBJECT }, { slot: 'recomposition_run', reference: record }];
  assert.equal(lineageKeyOf(plan(FIRST)), FIRST);
  assert.notEqual(lineageKeyOf(plan(FIRST)), lineageKeyOf(plan(SECOND)), 'an earlier compile of the same document is another compilation');
  assert.equal(lineageKeyOf([...plan(FIRST), { slot: 'recomposition_result', reference: RESULT }]), FIRST, 'the merge run of the compile, which binds the result too');
  assert.equal(lineageKeyOf([{ slot: 'subject', reference: SUBJECT }, { slot: 'recomposition_result', reference: RESULT }]), RESULT, 'a run from before the late binding');
  assert.equal(lineageKeyOf([{ slot: 'subject', reference: SUBJECT }]), SUBJECT);
});

test('--open says who judged: the report and the reply carry the line of the judge the compile was opened with, in all three modes, and delivery.json names it', async (t) => {
  const h = await hub(); t.after(h.close);
  const dir = await mkdtemp(join(tmpdir(), 'cc-judge-line-'));
  const opened = async (name: string, record: Record<string, unknown>) => { const path = join(dir, `${name}.json`); await writeFile(path, JSON.stringify({ schema: 'open-compile@1', ready: true, recompose_run: RECOMPOSE, plan_run: PLAN1, ...record })); return path; };
  const lines = {
    plumb: '判断方式：Plumb',
    jev: '判断方式：Jev（TypeSafe 的线上判断服务；原始用例的步骤、写出的命令和手册片段发给了 TypeSafe；结论是模型的判断，未经确认，逐条进复核）',
    model: '判断方式：通用大模型（不经 Plumb；命令核验只做命令树的程序核对，场景保真由独立盲审判断）',
  } as const;
  for (const [mode, record] of [['plumb', {}], ['jev', { judge: 'jev' }], ['model', { judge: 'model' }]] as const) {
    const out = join(dir, `out-${mode}`);
    const res = await run(h, await notes(NOTES), out, `${WHOLE},${FINAL}`, undefined, ['--open', await opened(mode, record)]);
    assert.equal(res.code, 0, res.stderr);
    const reply = (JSON.parse(res.stdout) as { reply: string }).reply.split('\n');
    assert.equal(reply[1], lines[mode], 'the reply says it right after the result line');
    const report = (await readFile(join(out, 'delivery_report.md'), 'utf8')).split('\n');
    assert.ok(report.includes(lines[mode]), mode);
    assert.equal(report.filter((line) => line.startsWith('判断方式：')).length, 1);
    assert.ok(report.indexOf(lines[mode]) < report.findIndex((line) => line.startsWith('自动化用例 Excel')), 'in the head of the report, before the files');
    const summary = JSON.parse(await readFile(join(out, 'delivery.json'), 'utf8'));
    assert.deepEqual([summary.judge, summary.judge_line], [mode, lines[mode]]);
  }
  // --open is required, so the line cannot be forgotten: a call without it is refused before the Hub is read, and nothing is written.
  const noOpen = join(dir, 'out-no-open'), notesPath = await notes(NOTES), asked = h.requests.length;
  const missing = await outputOf(() => main(['--hub', h.url, '--runs', `${WHOLE},${FINAL}`, '--recompose', RECOMPOSE, '--notes', notesPath, '--out', noOpen], async () => TOKEN));
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /^参数无效：缺少参数：--open（--open 为这一轮用的开运行记录，pipeline\.json 的 open）。参数写法：--hub --runs --notes --out --open 必填/);
  await assert.rejects(readdir(noOpen));
  assert.equal(h.requests.length, asked, 'the hub was not asked for this call');
  // A file that is no open record, or names a judge nobody knows, is refused before the Hub is read, and nothing is written.
  const refuse = async (path: string, said: RegExp) => { const out = join(dir, `out-${basename(path)}`); const res = await run(h, await notes(NOTES), out, `${WHOLE},${FINAL}`, undefined, ['--open', path]); assert.equal(res.code, 1); assert.match(res.stderr, said); await assert.rejects(readdir(out)); };
  const other = join(dir, 'other.json'); await writeFile(other, JSON.stringify({ schema: 'pipeline@1' }));
  await refuse(other, /^参数无效：--open 不是 open-compile\.ts 写的开运行记录/);
  await refuse(await opened('gpt', { judge: 'gpt' }), /^参数无效：--open 里的判断方式 "gpt" 不认识（应当是 jev 或 model，没有这一项就是 plumb）/);
  // The record has to be this compile's own: one whose runs are none of this compile's would write another compile's judge into this report.
  const ELSEWHERE = { plan_run: 'run_01zzzzzzzzzzzzzzzzzzzzzzzz', recompose_run: 'run_01yyyyyyyyyyyyyyyyyyyyyyyy' };
  await refuse(await opened('elsewhere', { judge: 'jev', ...ELSEWHERE }), /^参数无效：--open 的开运行记录不是这次编译的（它写的脚本编写运行 run_01zzzzzzzzzzzzzzzzzzzzzzzz、用例重组运行 run_01yyyyyyyyyyyyyyyyyyyyyyyy，都不在 --runs 这些上机验证所属的脚本编写运行里，也不是 --recompose）/);
  await refuse(await opened('no-runs', { judge: 'jev', plan_run: undefined, recompose_run: undefined }), /^参数无效：--open 的开运行记录不是这次编译的（它写的脚本编写运行 没有写、用例重组运行 没有写/);
  // One of the two is enough: this compile's plan run, or the recomposition run that --recompose names.
  for (const [name, own] of [['own-plan-run', { ...ELSEWHERE, plan_run: PLAN1 }], ['own-recompose-run', { ...ELSEWHERE, recompose_run: RECOMPOSE }]] as const) {
    const out = join(dir, `out-${name}`);
    const res = await run(h, await notes(NOTES), out, `${WHOLE},${FINAL}`, undefined, ['--open', await opened(name, { judge: 'jev', ...own })]);
    assert.equal(res.code, 0, `${name}: ${res.stderr}`);
    assert.equal(JSON.parse(await readFile(join(out, 'delivery.json'), 'utf8')).judge, 'jev', name);
  }
  // Without --recompose only the plan run can show that the record belongs here.
  const bare = await opened('bare', { judge: 'jev', ...ELSEWHERE, recompose_run: RECOMPOSE });
  const bareNotes = await notes(NOTES);
  const withoutRecompose = await outputOf(() => main(['--hub', h.url, '--runs', `${WHOLE},${FINAL}`, '--notes', bareNotes, '--out', join(dir, 'out-bare'), '--open', bare], async () => TOKEN));
  assert.equal(withoutRecompose.code, 1);
  assert.match(withoutRecompose.stderr, /^参数无效：--open 的开运行记录不是这次编译的/);
  await assert.rejects(readdir(join(dir, 'out-bare')));
});

// What the open record says about the booking, and what the delivery then does with it (decision 195).
const openWith = async (extra: Record<string, unknown>) => { const dir = await mkdtemp(join(tmpdir(), 'cc-open-')); const path = join(dir, 'open-compile.json'); await writeFile(path, JSON.stringify({ schema: 'open-compile@1', ready: true, subject: 'agile:mindmap:900001', product: 'widget', build: 'Fixture_Build_A', booking: BOOKING, recompose_run: RECOMPOSE, plan_run: PLAN1, ...extra })); return path; };
const RELEASE_CALL = { name: 'start_run', arguments: { pack: 'test-bed', inputs: { inventory: { external: 'doc:doc:bed-topology' } }, predecessor: BOOKING, parameters: { action: 'release', booking: BOOKING } } };
const ALL_FILES = ['case.xlsx', 'delivery.json', 'delivery_report.md', 'unsuccessful_cases.md', 'unsuccessful_cases.xlsx'];
const PLAIN_MESSAGE = '交付目录已组好：最后回复原样用 reply，不另加表格或逐条重述';
const bookingOf = async (extra: string[], openExtra: Record<string, unknown>, setup?: (h: Awaited<ReturnType<typeof hub>>) => void, notesOf: Record<string, unknown> = NOTES) => {
  const h = await hub(); setup?.(h);
  try {
    const out = join(await mkdtemp(join(tmpdir(), 'cc-delivery-')), 'out'); h.mcp.watch = out;
    const result = await run(h, await notes(notesOf), out, undefined, undefined, ['--open', await openWith(openExtra), ...extra]);
    return { h, out, ...result, answer: result.stdout ? JSON.parse(result.stdout) as Record<string, any> : {} };
  } finally { await h.close(); }
};

test('a compile that took its booking itself has it released when the delivery is complete: one test-bed release call after the files are written, and the reply and the message say so', async () => {
  const done = await bookingOf([], { booking_acquired: true });
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual(done.h.mcp.calls, [{ ...RELEASE_CALL, delivered: ALL_FILES }], 'one call, shaped as the test-bed skill gives it, and every file stood there already');
  assert.deepEqual(done.answer.booking, { run: BOOKING, state: 'released' });
  const lines = String(done.answer.reply).split('\n');
  assert.deepEqual([lines.at(-2)!.startsWith('交付报告：'), lines.at(-1)], [true, '测试环境的预订已释放。'], 'the sentence is the last line of the reply, after the line of the report');
  assert.equal(done.answer.message, PLAIN_MESSAGE, 'a release that went through adds nothing to the message');
  assert.ok(!String(done.answer.reply).includes(BOOKING), 'no run number in what the user reads');
  assert.deepEqual((await readdir(done.out)).sort(), ALL_FILES);
  assert.equal(JSON.parse(await readFile(join(done.out, 'delivery.json'), 'utf8')).booking, undefined, 'the summary was written before the Hub answered, so it says nothing of it');
  assert.deepEqual(done.answer.files && Object.keys(done.answer.files).sort(), ALL_FILES);
});

test('the release names the inventory the compile was opened with; a record that names none means the default one', async () => {
  const done = await bookingOf([], { booking_acquired: true, inventory: 'doc:doc:other-topology' });
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual(done.h.mcp.calls.map((call) => call.arguments), [{ ...RELEASE_CALL.arguments, inputs: { inventory: { external: 'doc:doc:other-topology' } } }]);
  assert.deepEqual(done.answer.booking, { run: BOOKING, state: 'released' });
});

test('a record that does not say the compile took the booking leaves it where it is and says so in the reply and, with the run, in the message; a record with no booking says nothing', async () => {
  const kept = await bookingOf([], {});
  assert.equal(kept.code, 0, kept.stderr);
  assert.deepEqual(kept.h.mcp.calls, []);
  assert.deepEqual(kept.answer.booking, { run: BOOKING, state: 'kept' });
  assert.equal(String(kept.answer.reply).split('\n').at(-1), '测试环境的预订仍保留（不是这次编译预订的）。不再使用时请要求释放。');
  assert.equal(kept.answer.message, `${PLAIN_MESSAGE}。预订 ${BOOKING} 不是这次编译预订的，没有释放；使用者要求时在重跑时加 --release-booking yes，或按 test-bed 技能的 release 释放`);
  assert.ok(!String(kept.answer.reply).includes(BOOKING));
  const none = await bookingOf([], { booking: undefined });
  assert.equal(none.code, 0, none.stderr);
  assert.deepEqual([none.h.mcp.calls, none.answer.booking, String(none.answer.reply).includes('预订'), none.answer.message], [[], undefined, false, PLAIN_MESSAGE]);
});

test('--keep-booking leaves the booking, as asked, whether or not the compile took it; nothing is called and the message adds nothing', async () => {
  for (const [name, open] of [['taken', { booking_acquired: true }], ['not taken', {}]] as const) {
    const done = await bookingOf(['--keep-booking', 'yes'], open);
    assert.equal(done.code, 0, `${name}: ${done.stderr}`);
    assert.deepEqual(done.h.mcp.calls, [], name);
    assert.deepEqual(done.answer.booking, { run: BOOKING, state: 'kept' }, name);
    assert.equal(String(done.answer.reply).split('\n').at(-1), '测试环境的预订按要求保留。', name);
    assert.equal(done.answer.message, PLAIN_MESSAGE, name);
  }
});

test('--release-booking releases the booking of a record that does not say the compile took it, with the same one call', async () => {
  const done = await bookingOf(['--release-booking', 'yes'], {});
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual(done.h.mcp.calls, [{ ...RELEASE_CALL, delivered: ALL_FILES }]);
  assert.deepEqual(done.answer.booking, { run: BOOKING, state: 'released' });
  assert.equal(String(done.answer.reply).split('\n').at(-1), '测试环境的预订已释放。');
});

test('a delivery that still has hints releases nothing and says nothing of the booking, whatever the record and the options say', async () => {
  const unverified = { ...NOTES, [CASES[1]]: { ...NOTES[CASES[1]], evidence: '这句话设备没有输出过' } };
  for (const [name, extra, open] of [['taken', [], { booking_acquired: true }], ['not taken', [], {}], ['forced', ['--release-booking', 'yes'], {}], ['kept', ['--keep-booking', 'yes'], { booking_acquired: true }]] as const) {
    const done = await bookingOf([...extra], open, undefined, unverified);
    assert.equal(done.code, 1, `${name}: ${done.stderr}`);
    assert.ok(done.answer.hints.length > 0, name);
    assert.deepEqual(done.h.mcp.calls, [], name);
    assert.equal(done.answer.booking, undefined, name);
    assert.ok(!/预订/.test(`${done.answer.reply}${done.answer.message}`), name);
    assert.equal(done.answer.message, `交付目录还缺 ${done.answer.hints.length} 项（见 hints）：逐条补齐后在新的输出目录重跑 assemble-delivery.ts，这次的 reply 不作最后回复`, name);
  }
});

test('a Hub that refuses the release or cannot be reached does not undo the delivery: the files are written, the exit code is the one it would have had, and the reply gives the words; a refusal is not released, no answer is unknown', async () => {
  const refusals: Array<[string, McpAnswer, string, 'not_released' | 'unknown']> = [
    ['refused', { kind: 'refused', errors: [{ code: 'LEASE_UNAVAILABLE', message: '合成：Hub 拒绝释放', fix: '合成：请管理员核对', path: '/parameters/booking' }] }, '合成：Hub 拒绝释放（位置 /parameters/booking）；下一步：合成：请管理员核对', 'not_released'],
    ['another code of the same words', { kind: 'refused', errors: [{ code: 'test-bed.release_mismatch', message: '你没有持有这个预订（run_01zzzzzzzzzzzzzzzzzzzzzzzz）：这次运行的血缘里没有未过期的租约行' }] }, '你没有持有这个预订（run_01zzzzzzzzzzzzzzzzzzzzzzzz）：这次运行的血缘里没有未过期的租约行', 'not_released'],
    ['http', { kind: 'http', status: 503, body: '合成：维护中' }, 'Hub 答复 503：合成：维护中', 'unknown'],
    ['unreachable', { kind: 'drop' }, 'Hub 不可达（fetch failed）', 'unknown'],
  ];
  for (const [name, answer, words, state] of refusals) {
    const done = await bookingOf([], { booking_acquired: true }, (h) => { h.mcp.answer = answer; });
    assert.equal(done.code, 0, `${name}: the delivery stays what it was: ${done.stderr}`);
    assert.deepEqual((await readdir(done.out)).sort(), ALL_FILES, name);
    assert.equal(done.h.mcp.calls.length, 1, `${name}: asked once, not again`);
    assert.deepEqual(done.answer.booking, { run: BOOKING, state, reason: words }, name);
    assert.equal(String(done.answer.reply).split('\n').at(-1), `测试环境的预订${state === 'unknown' ? '是否已释放未知' : '没有释放'}：${words}。请再要求释放一次，或请管理员核对。`, name);
    assert.equal(done.answer.message, `${PLAIN_MESSAGE}。预订 ${BOOKING} ${state === 'unknown' ? '是否已释放未知（原因见 booking.reason）：按 test-bed 技能的 release 再试一次，答复没有持有这个预订就是已经释放' : '没有释放（原因见 booking.reason）：按 test-bed 技能的 release 再试一次，仍被拒绝就把原话告诉使用者'}`, name);
  }
  const long = await bookingOf([], { booking_acquired: true }, (h) => { h.mcp.answer = { kind: 'refused', errors: [{ code: 'x.y', message: '字'.repeat(400) }] }; });
  assert.equal(long.answer.booking.reason, '字'.repeat(300), 'at most 300 characters of the words');
  assert.equal(String(long.answer.reply).split('\n').at(-1), `测试环境的预订没有释放：${'字'.repeat(300)}。请再要求释放一次，或请管理员核对。`);
});

test('a Hub that says the booking holds nothing has nothing left to release: it is reported as released, with its words kept in the machine part only', async () => {
  const words = '你没有持有这个预订（run_01zzzzzzzzzzzzzzzzzzzzzzzz）：这次运行的血缘里没有未过期的租约行；下一步：booking 写你自己的预订运行的编号';
  const done = await bookingOf([], { booking_acquired: true }, (h) => { h.mcp.answer = { kind: 'refused', errors: [{ code: 'test-bed.not_holder', message: '你没有持有这个预订（run_01zzzzzzzzzzzzzzzzzzzzzzzz）：这次运行的血缘里没有未过期的租约行', fix: 'booking 写你自己的预订运行的编号' }] }; });
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual(done.answer.booking, { run: BOOKING, state: 'released', reason: words });
  assert.equal(String(done.answer.reply).split('\n').at(-1), '测试环境的预订已释放。');
  assert.ok(!String(done.answer.reply).includes('run_0'), 'the words of the Hub are not in what the user reads');
  assert.equal(done.answer.message, PLAIN_MESSAGE);
});

test('the two booking options exclude each other and take only yes, and --release-booking needs a booking to release; each is refused before the Hub is read', async (t) => {
  const h = await hub(); t.after(h.close); const dir = await mkdtemp(join(tmpdir(), 'cc-delivery-')); const path = await notes(NOTES), open = await openWith({ booking_acquired: true });
  const refuse = async (name: string, extra: string[], said: RegExp, openPath = open) => {
    const out = join(dir, name), asked = h.requests.length;
    const res = await outputOf(() => main(['--hub', h.url, '--runs', `${WHOLE},${FINAL}`, '--recompose', RECOMPOSE, '--notes', path, '--out', out, '--open', openPath, ...extra], async () => TOKEN));
    assert.equal(res.code, 1, name); assert.match(res.stderr, said, name);
    await assert.rejects(readdir(out), name);
    assert.equal(h.requests.length, asked, `${name}: the Hub was not read`); assert.deepEqual(h.mcp.calls, [], name);
  };
  await refuse('both', ['--keep-booking', 'yes', '--release-booking', 'yes'], /^参数无效：--keep-booking 和 --release-booking 不能一起写：一个要保留预订，一个要释放它。只写其中一个后重试/);
  await refuse('no value', ['--keep-booking'], /^参数无效：参数写法：--hub --runs --notes --out --open 必填，--recompose --name 可选，每个只写一次；预订另有可选的 --keep-booking yes（保留）和 --release-booking yes（释放），不能一起写/);
  await refuse('bad keep', ['--keep-booking', 'true'], /^参数无效：--keep-booking 只能写 yes。要保留预订就写 --keep-booking yes，不要就不写这个选项/);
  await refuse('bad release', ['--release-booking', 'no'], /^参数无效：--release-booking 只能写 yes。要释放预订就写 --release-booking yes，不要就不写这个选项/);
  await refuse('twice', ['--keep-booking', 'yes', '--keep-booking', 'yes'], /^参数无效：参数写法：/);
  await refuse('no booking', ['--release-booking', 'yes'], /^参数无效：--release-booking 没有预订可释放：--open 的开运行记录里没有预订的运行编号（booking）/, PLAIN_OPEN);
  await refuse('mangled', [], /^参数无效：--open 里的 booking_acquired 是 "yes"，只能是 true（没有这一项就是这次编译没有自己预订测试环境）/, await openWith({ booking_acquired: 'yes' }));
  await refuse('taken without a booking', [], /^参数无效：--open 说这次编译自己预订了测试环境，却没有写预订的运行编号（booking）/, await openWith({ booking_acquired: true, booking: undefined }));
});

test('a tab inside a quote of the device output goes through the delivery as it is: the verbatim check, the report, the log tail and delivery.json; the same quote with spaces is refused', async (t) => {
  const TAB_LOG = Buffer.from('合成日志：\t第 3 步断言\t没有命中\n');
  const verdicts = ['pass', 'fail', 'pass'];
  const jobs = { [WHOLE]: [{ ...job('a', WHOLE, PLAN1, CASES.slice(0, 3), plan1.workbook, verdicts), rows: CASES.slice(0, 3).map((item, k) => ({ item, dynamic_terminal: verdicts[k], ...(verdicts[k] === 'fail' ? { evidence: { log: `src:${sha256(TAB_LOG)}` } } : {}) })) }] };
  const h = await hub(undefined, undefined, jobs, {}, undefined, false, [TAB_LOG]); t.after(h.close);
  const quoted = '第 3 步断言\t没有命中';
  const withTab = { ...NOTES, [CASES[1]]: { ...NOTES[CASES[1]], evidence: quoted, defect_candidate: { ...CANDIDATE, actual: quoted } } };
  const out = join(await mkdtemp(join(tmpdir(), 'cc-delivery-')), 'out'), done = await run(h, await notes(withTab), out);
  assert.equal(done.code, 0, done.stderr);
  const report = await readFile(join(out, 'delivery_report.md'), 'utf8');
  assert.ok(report.includes(`\n\`\`\`\n${quoted}\n\`\`\`\n`), 'the quote is fenced with its tab');
  assert.ok((await readFile(join(out, 'unsuccessful_cases.md'), 'utf8')).includes('合成日志：\t第 3 步断言\t没有命中'), 'the tail of the device log keeps its tabs');
  const row = JSON.parse(await readFile(join(out, 'delivery.json'), 'utf8')).cases[1];
  assert.deepEqual([row.model_claims.evidence, row.model_claims.defect_candidate.actual, row.pending], [quoted, quoted, undefined]);
  assert.match(await readFile(join(out, 'delivery.json'), 'utf8'), /"evidence": "第 3 步断言\\t没有命中"/, 'in the file the tab is the escape JSON gives it');
  assert.ok((await readdir(out)).includes('unsuccessful_cases.xlsx'));
  const spaced = { ...NOTES, [CASES[1]]: { ...NOTES[CASES[1]], evidence: quoted.replace('\t', ' ') } };
  const refused = await run(h, await notes(spaced), join(await mkdtemp(join(tmpdir(), 'cc-delivery-')), 'out'));
  assert.equal(refused.code, 1, refused.stderr);
  assert.ok(JSON.parse(refused.stdout).hints.some((hint: { missing: string }) => hint.missing === '设备引文未通过逐字核对'), 'the quote with spaces is not what the device printed');
});
