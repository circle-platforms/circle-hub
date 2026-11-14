// The delivery directory at the end of a compile run, against a synthetic Hub stub only: a whole-volume dispatch with one
// failure, then the pass volume dispatched on its own (the final verification).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { generateWorkbookSet } from '../functions/generate.ts';
import { sha256 } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { CONTRACT_DOC, MANIFEST_DOC, PROFILE_DOC } from '../functions/test-support.ts';
import { signTypedRuntime } from '../testing/typed-fixtures.ts';
import { planRunFixture } from '../testing/plan-run.ts';
import { satisfiedRecipes } from './generate-workbook.ts';
import { main, planDigest } from './assemble-delivery.ts';
import { assemble, timeline } from '../functions/delivery.ts';

const TOKEN = 'synthetic-token-1234';
const BOOKING = 'run_01zzzzzzzzzzzzzzzzzzzzzzzz', RECOMPOSED = `rec:${'7'.repeat(64)}`;
const [WHOLE, FINAL, PLAN1, PLAN2, RECOMPOSE] = ['run_01aaaaaaaaaaaaaaaaaaaaaaaa', 'run_01bbbbbbbbbbbbbbbbbbbbbbbb', 'run_01cccccccccccccccccccccccc', 'run_01dddddddddddddddddddddddd', 'run_01eeeeeeeeeeeeeeeeeeeeeeee'];
const CASES = ['990000000000000101', '990000000000000102', '990000000000000103', '990000000000000104'];
const contract = Buffer.from(JSON.stringify(CONTRACT_DOC)), profile = Buffer.from(JSON.stringify(PROFILE_DOC)), inventory = Buffer.from(JSON.stringify(MANIFEST_DOC));
const log = Buffer.from('合成日志：第 3 步断言没有命中\n');

/** A satisfied plan run over `autoids` under this file's booking and recomposition (testing/plan-run.ts). */
const planRun = (run: string, autoids: string[], exclude: string[], pause?: string, contractBytes: Uint8Array = contract) => planRunFixture({ run, autoids, exclude, pause, contract: contractBytes, profile, inventory, predecessor: BOOKING, recomposed: RECOMPOSED });
const plan1 = planRun(PLAN1, CASES.slice(0, 3), [CASES[3]]);
const plan2 = planRun(PLAN2, [CASES[0], CASES[2]], [CASES[1], CASES[3]]);
// The knowledge root the plan runs locked, as the Hub gives it in one batch (a head line, then one node a line), with one manual row.
const ROOT = String(plan1.record.root), ENTRY = `tree:${ROOT}/manual/guide/names@${'1'.repeat(64)}`, MANUAL = '| peer_name | 合成参数说明：特殊字符仅支持“._-”。 |';
const lockedRoot = (run: string, root: string) => {
  const nodes = [{ path: '/manual/guide/names', children: [], entries: [{ entry: '1'.repeat(64), kind: 'behaviour', statement: MANUAL, reference: ENTRY, data: {} }] }];
  return Buffer.from([{ schema: 'run-knowledge@1', run, root, composition: null, nodes: nodes.length, entries: 1 }, ...nodes].map((line) => JSON.stringify(line)).join('\n') + '\n');
};
// The plan run that held CASES[3] before the model left it out of the others.
const GAP = 'run_01777777777777777777777777', LATER = 'run_01888888888888888888888888', GAP_WORDS = '合成缺失事实：配置命令的逆操作不在锁定树里', SPENT_WORDS = '合成：缺少修复后符合要求的产物（修复轮数用完）';
type Gap = 'recorded' | 'exhausted' | 'skipped' | 'skipped-spent' | 'shadowed' | 'workbook' | 'unsubmitted' | 'none';
/**
 * The Hub left the plan of CASES[3] pending on a missing fact with a request (`recorded`), without an accepted plan after the
 * repair rounds (`exhausted`), handed in as skipped while rounds are left (`skipped`) or after the other items of the run used
 * them up (`skipped-spent`), on the missing workbook only (`workbook`), or never accepted a submission (`unsubmitted`). A
 * skipped item is recorded as the Hub records it: skip_reason on the entry, repair_exhausted on the plan slot (which has no
 * rounds of its own) and declared_skip on every other requirement.
 */
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

/** A synthetic Hub: the verification runs in `order` (default: every one, in insertion order) stand in the lineage booking → plan run → verification run, each started after the one before. */
async function hub(finalVerdicts = ['pass', 'pass'], finalWorkbook = plan2.workbook, extraJobs: Record<string, unknown[]> = {}, extraPlans: Record<string, ReturnType<typeof planRun>> = {}, order?: string[], chain = false, extraOriginals: Uint8Array[] = [], gap: Gap = 'recorded', knowledge: 'served' | 'absent' | 'tampered' | 'other-root' = 'served') {
  const all: Record<string, unknown[]> = { [WHOLE]: [job('a', WHOLE, PLAN1, CASES.slice(0, 3), plan1.workbook, ['pass', 'fail', 'pass'])], [FINAL]: [job('b', FINAL, PLAN2, [CASES[0], CASES[2]], finalWorkbook, finalVerdicts)], ...extraJobs };
  const runsInOrder = order ?? Object.keys(all);
  const jobs = Object.fromEntries(runsInOrder.map((run) => [run, all[run]]));
  const plans: Record<string, ReturnType<typeof planRun>> = { [PLAN1]: plan1, [PLAN2]: plan2, ...extraPlans };
  const planOfRun = (run: string) => (jobs[run][0] as { plan_run: string }).plan_run;
  const at = (k: number) => `2026-11-08T0${Math.floor(k / 60)}:${String(k % 60).padStart(2, '0')}:00.000Z`;
  // The lineage: each plan run under the booking, or (chain) under the verification run before it, as a rework may name either.
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
  // A later plan run that holds the case but was never answered judged no plan, so the earlier record still stands.
  if (gap === 'shadowed') records[LATER] = { ...gapRun('unsubmitted', LATER).plan.record, started_at: '2026-11-08T00:00:40.000Z', predecessor: BOOKING };
  const successors: Record<string, unknown[]> = {};
  for (const record of Object.values(records)) if (typeof record.predecessor === 'string') (successors[record.predecessor] ??= []).push({ run: record.run, pack: record.pack, started_at: record.started_at, predecessor: record.predecessor, parameters: record.parameters, sources: (record.sources as Array<{ slot: string; reference: string }>).map((s) => ({ slot: s.slot, reference: s.reference })) });
  const originals = new Map([contract, profile, inventory, log, ...extraOriginals].map((bytes) => [sha256(bytes), bytes]));
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    if (request.headers.authorization !== `Bearer ${TOKEN}`) { response.statusCode = 401; response.end(); return; }
    const jobsOf = /^\/run-export\/(run_\w+)\/jobs$/.exec(url); if (jobsOf && jobs[jobsOf[1]]) { response.end(JSON.stringify({ schema: 'run-jobs@1', run: jobsOf[1], jobs: jobs[jobsOf[1]] })); return; }
    const next = /^\/run-export\/(run_\w+)\/successors$/.exec(url); if (next) { response.end(JSON.stringify({ schema: 'run-successors@1', run: next[1], successors: successors[next[1]] ?? [] })); return; }
    const whole = /^\/run-export\/(run_\w+)$/.exec(url); if (whole && plans[whole[1]]) { const p = plans[whole[1]]; response.end(JSON.stringify({ schema: 'run-export@1', run: records[whole[1]] ?? p.record, result: p.result, submission: p.submission })); return; }
    if (whole && records[whole[1]]) { response.statusCode = 409; response.end('这个运行还没有已受理的提交\n'); return; }
    if (url === `/run-export/${RECOMPOSE}/run`) { response.end(JSON.stringify({ schema: 'run-export@1', run: recomposed })); return; }
    const batch = /^\/run-export\/(run_\w+)\/knowledge$/.exec(url);
    if (batch) {
      if (knowledge === 'absent' || !records[batch[1]]) { response.statusCode = 404; response.end('没有\n'); return; }
      const body = lockedRoot(batch[1], knowledge === 'other-root' ? 'e'.repeat(64) : ROOT);
      response.setHeader('content-digest', `sha-256=:${Buffer.from(sha256(body), 'hex').toString('base64')}:`);
      response.end(knowledge === 'tampered' ? Buffer.concat([body, Buffer.from(' ')]) : body); return;
    }
    const alone = /^\/run-export\/(run_\w+)\/run$/.exec(url); if (alone && records[alone[1]]) { response.end(JSON.stringify({ schema: 'run-export@1', run: records[alone[1]] })); return; }
    const source = /^\/run-export\/run_\w+\/sources\/([0-9a-f]{64})$/.exec(url); if (source && originals.has(source[1])) { response.end(originals.get(source[1])); return; }
    response.statusCode = 404; response.end('没有\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
async function outputOf(run: () => Promise<number>) {
  const out: string[] = [], err: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout), stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { return { code: await run(), stdout: out.join(''), stderr: err.join('') }; } finally { process.stdout.write = stdout; process.stderr.write = stderr; }
}
async function notes(cases: Record<string, unknown>) { const dir = await mkdtemp(join(tmpdir(), 'cc-notes-')); const path = join(dir, 'notes.json'); await writeFile(path, JSON.stringify({ cases })); return path; }
// CASES[1] failed once and closes as a defect candidate quoting its author's expectation and the device verbatim.
const CANDIDATE = { repro: '合成复现：照第 1 步配置后读第 3 步输出', expected: '合成期望', actual: '第 3 步断言没有命中' };
const NOTES = { [CASES[1]]: { judged: '合成判断：计划写错', remedy: '合成修法：改计划后重跑', evidence: '第 3 步断言没有命中', defect_candidate: CANDIDATE }, [CASES[3]]: { judged: '合成判断：缺事实', remedy: '合成取舍：等补证' } };
const run = (h: { url: string }, notesPath: string, out: string, runs = `${WHOLE},${FINAL}`, retry?: Parameters<typeof main>[3], extraArgs: string[] = []) => outputOf(() => main(['--hub', h.url, '--runs', runs, '--recompose', RECOMPOSE, '--notes', notesPath, '--out', out, '--name', '合成批', ...extraArgs], async () => TOKEN, () => new Date('2026-11-08T08:00:00Z'), retry));

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
  assert.deepEqual(summary.cases[1].dispatches.map((d: { label: string }) => d.label), ['错误']);
  assert.equal(summary.unsuccessful_volume.dispatched, false);
  const report = await readFile(join(out, 'delivery_report.md'), 'utf8');
  assert.match(report, /^# 交付报告 — 合成批\n> 生成 2026-11-08 /);
  assert.match(report, /自动化用例 Excel case\.xlsx 中的 2 条原始用例已一起完成上机验证，判断正确。/);
  assert.match(report, /第 1 次上机验证判断错误。/);
  assert.match(report, /原始用例 990000000000000102 合成用例 102，模型判断原始用例的期望与设备输出不一致，状态未确认，判断错误。原因还没查清，下一步使用者核对/);
  assert.match(report, /未做上机验证，这条原始用例未完成脚本编写。/);
  assert.match(report, /## 原始用例 990000000000000104 合成意图 4/, 'a case never compiled takes its title from the recomposition');
  const long = await readFile(join(out, 'unsuccessful_cases.md'), 'utf8');
  assert.match(long, /\*\*原始用例原句\*\*\n- 合成步骤 → 期望 合成期望/);
  assert.match(long, /合成日志：第 3 步断言没有命中/);
});

test('a last dispatch with mixed verdicts, a regenerated workbook that differs and notes that miss a case are refused, writing nothing', async (t) => {
  const mixed = await hub(['pass', 'fail']); t.after(mixed.close);
  const out = join(await mkdtemp(join(tmpdir(), 'cc-delivery-')), 'out');
  assert.match((await run(mixed, await notes(NOTES), out)).stderr, /尚无一起做上机验证且全部正确的自动化用例 Excel。原始用例 990000000000000101 最近一次上机验证正确/);
  const only = await hub(undefined, undefined, {}, {}, [WHOLE]); t.after(only.close);
  const both = await hub(); t.after(both.close);
  assert.match((await run(only, await notes(NOTES), out, WHOLE)).stderr, /原始用例 990000000000000101、990000000000000103 最近一次上机验证正确/, 'the whole volume alone is not a pass volume');
  const other = await hub(['pass', 'pass'], Buffer.from('另一份工作簿')); t.after(other.close);
  assert.match((await run(other, await notes(NOTES), out)).stderr, /重新生成的自动化用例 Excel 与上机验证使用的文件不一致/);
  assert.match((await run(both, await notes({ [CASES[1]]: NOTES[CASES[1]] }), out)).stderr, /说明要恰好覆盖没有交付的用例：缺 990000000000000104/);
  assert.match((await run(both, await notes({ ...NOTES, [CASES[0]]: NOTES[CASES[1]] }), out)).stderr, /多了 990000000000000101（交付的用例不写说明）/);
  await assert.rejects(readdir(out), 'nothing was written');
});

test('a recent pass outside the pass volume refuses the delivery, as does a pass with no pass volume; an all-fail last dispatch delivers nothing', () => {
  const d = (run: string, items: string[], verdicts: string[]) => ({ run, job: 'j-' + run, plan_run: PLAN1, sha256: 'c'.repeat(64), items, rows: items.map((item, k) => ({ item, dynamic_terminal: verdicts[k] })) });
  // Run 15's shape: the passes ran together, one was rerun alone and passed; the volume that ships must hold every recent pass.
  assert.throws(() => assemble(CASES.slice(0, 3), [d(WHOLE, CASES.slice(0, 3), ['pass', 'fail', 'pass']), d(FINAL, [CASES[0]], ['pass'])]), /原始用例 990000000000000103 最近一次上机验证正确，但不在最近一份全部正确的自动化用例 Excel 里/);
  const together = assemble(CASES.slice(0, 3), [d(WHOLE, CASES.slice(0, 3), ['pass', 'fail', 'pass']), d(FINAL, [CASES[0], CASES[2]], ['pass', 'pass'])]);
  assert.deepEqual(together.totals, { cases: 3, delivered: 2, failed: 1, unsettled: 0, unrun: 0 });
  assert.match(timeline(together.cases[1], false), /^第 1 次上机验证判断错误。$/);
  assert.throws(() => assemble(CASES.slice(0, 3), [d(WHOLE, CASES.slice(0, 3), ['pass', 'fail', 'pass'])]), /尚无一起做上机验证且全部正确的自动化用例 Excel。原始用例 990000000000000101、990000000000000103 最近一次上机验证正确/);
  const none = assemble(CASES.slice(0, 2), [d(WHOLE, CASES.slice(0, 2), ['fail', 'no_verdict'])]);
  assert.equal(none.pass, null); assert.deepEqual(none.totals, { cases: 2, delivered: 0, failed: 1, unsettled: 1, unrun: 0 });
  assert.deepEqual(none.unsuccessful?.items, CASES.slice(0, 2));
});

test('cases that last failed in different dispatches go into the unsuccessful volume each with the plan it last ran', async (t) => {
  // The shape of a real run: one case fails in the whole-volume dispatch, another only after a rework, then the pass volume alone.
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
  assert.match(await readFile(join(out, 'delivery_report.md'), 'utf8'), /使用各自最近一次上机验证的自动化用例，尚未一起做上机验证。/);
});

test('a merged workbook names every plan run and refuses cases of another contract; the default stays one plan run', () => {
  const [a, b] = [planRun(PLAN1, [CASES[0]], []), planRun(PLAN2, [CASES[1]], [])].map((p) => satisfiedRecipes({ run: p.record, result: p.result, submission: p.submission, contract, profile, inventory })[0]);
  assert.throws(() => generateWorkbookSet([a, b]), /共用同一合约、配置、计划运行/);
  assert.ok(generateWorkbookSet([a, b], { merged: true }).length > 0);
  assert.deepEqual(generateWorkbookSet([a]), generateWorkbookSet([a], { merged: true }));
  const other = { ...b, profile: { ...b.profile, device_count: b.profile.device_count + 1 } };
  assert.throws(() => generateWorkbookSet([a, other], { merged: true }), /共用同一合约、配置/);
});

test('after the final verification, a rerun of other cases that passes nothing leaves the pass volume; a failure of one of its cases or a pass outside it is refused', async (t) => {
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
  assert.throws(() => assemble(CASES, [...dispatches, rerun]), /尚无一起做上机验证且全部正确的自动化用例 Excel。原始用例 990000000000000103 最近一次上机验证正确/);
  // A later try that reruns the pass volume, passes it again and fails only the case it added leaves the pass volume standing.
  const retry = { ...rerun, run: 'run_01qqqqqqqqqqqqqqqqqqqqqqqq', items: [CASES[0], CASES[2], CASES[1]], rows: [{ item: CASES[0], dynamic_terminal: 'pass' }, { item: CASES[2], dynamic_terminal: 'pass' }, { item: CASES[1], dynamic_terminal: 'fail' }] };
  const settled = assemble(CASES, [...dispatches, retry]);
  assert.equal(settled.pass?.run, FINAL);
  assert.deepEqual(settled.unsuccessful?.items, [CASES[1]]);
  assert.equal(settled.unsuccessful?.sources[CASES[1]].run, retry.run);
  // A later volume that passed whole while recent passes stay outside it is not a delivery: they go to the bed together first.
  const extra = { ...retry, run: 'run_01rrrrrrrrrrrrrrrrrrrrrrrr', items: [CASES[1]], rows: [{ item: CASES[1], dynamic_terminal: 'pass' }] };
  assert.throws(() => assemble(CASES, [...dispatches, retry, extra]), /原始用例 990000000000000101、990000000000000103 最近一次上机验证正确，但不在最近一份全部正确的自动化用例 Excel 里/);
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
  assert.equal(printed.reply, [`交付目录 ${out}`, '原始用例 990000000000000101 合成用例 101，自动化用例 Excel 已完成上机验证，状态已确认，判断正确。决定者程序。', '原始用例 990000000000000102 合成用例 102，模型判断原始用例的期望与设备输出不一致，状态未确认，判断错误。原因还没查清，下一步使用者核对原始用例、手册和设备输出后决定是否修改原始用例。决定者模型。', '原始用例 990000000000000103 合成用例 103，自动化用例 Excel 已完成上机验证，状态已确认，判断正确。决定者程序。', '原始用例 990000000000000104 合成意图 4，缺少脚本编写所需的资料，状态未知。原因缺资料，下一步合成取舍：等补证。决定者程序。', ...['case.xlsx', 'unsuccessful_cases.xlsx', 'delivery_report.md', 'unsuccessful_cases.md', 'delivery.json'].map((name) => `- ${join(out, name)}`)].join('\n'));
  const summary = JSON.parse(await readFile(join(out, 'delivery.json'), 'utf8'));
  assert.deepEqual(summary.added_runs, [WHOLE]);
  assert.match(await readFile(join(out, 'delivery_report.md'), 'utf8'), /第 1 次上机验证判断错误/);
});

test('a verification run whose job ended before anything went to the bed is no run of the cases, and the lineage skips it', async (t) => {
  // Run 16: a Hub fault stopped a job in its pre-dispatch device probe; it ended as not dispatched, and the run was verified again.
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
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /用例 990000000000000102 已做上机验证，但说明缺少设备输出/);
  const invented = await run(h, await notes({ ...NOTES, [CASES[1]]: { judged: '合成判断', remedy: '合成修法', evidence: '设备说一切正常' } }), join(dir, 'b'));
  assert.equal(invented.code, 1);
  assert.match(invented.stderr, /用例 990000000000000102 的设备输出不是最近一次上机验证的原话/);
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

test('a failed case goes back to authoring until three authored versions failed; only a verbatim defect candidate closes it earlier', async (t) => {
  // InfoTest's closing rules: max_rounds 3 per case, a free-text environment or product judgement is not a terminal credential.
  const [R2, R3, AGAIN, PLAN7, PLAN8] = ['run_01ssssssssssssssssssssssss', 'run_01tttttttttttttttttttttttt', 'run_01vvvvvvvvvvvvvvvvvvvvvvvv', 'run_01wwwwwwwwwwwwwwwwwwwwwwww', 'run_01xxxxxxxxxxxxxxxxxxxxxxxx'];
  const judgedOnly = { ...NOTES, [CASES[1]]: { judged: '合成判断：环境缺前置', remedy: '合成取舍：本轮不返工', evidence: '第 3 步断言没有命中' } };
  const dir = await mkdtemp(join(tmpdir(), 'cc-delivery-'));
  const once = await hub(); t.after(once.close);
  const early = await run(once, await notes(judgedOnly), join(dir, 'a'));
  assert.equal(early.code, 1);
  assert.match(early.stderr, /用例 990000000000000102 上机验证有错误，已重写自动化用例 1 次，最多重交 3 次，同一份自动化用例重新验证不算重写/);
  const unquoted = await run(once, await notes({ ...NOTES, [CASES[1]]: { ...NOTES[CASES[1]], defect_candidate: { ...CANDIDATE, expected: '作者没写过的期望', actual: '设备说一切正常' } } }), join(dir, 'b'));
  assert.equal(unquoted.code, 1);
  assert.match(unquoted.stderr, /用例 990000000000000102 判断设备的问题时，期望不是原始用例的原句；设备输出不是最近一次上机验证的原话/);
  assert.match((await run(once, await notes({ ...NOTES, [CASES[1]]: { ...NOTES[CASES[1]], defect_candidate: { repro: '合成复现' } } }), join(dir, 'c'))).stderr, /判断设备的问题时，请只写复现步骤、原始用例期望原句和设备输出三项/);

  // A rerun of the same plan is not another authored round.
  const rerun = await hub(undefined, undefined, { [AGAIN]: [job('g', AGAIN, PLAN1, CASES.slice(0, 3), plan1.workbook, ['pass', 'fail', 'pass'])] }, {}, [WHOLE, AGAIN, FINAL]); t.after(rerun.close);
  assert.match((await run(rerun, await notes(judgedOnly), join(dir, 'd'), `${WHOLE},${AGAIN},${FINAL}`)).stderr, /已重写自动化用例 1 次，最多重交 3 次/);

  // Three distinct plans of it failed: it closes as the model not finding a solution, and its judgement is reported as its own account.
  const plan7 = planRun(PLAN7, CASES.slice(0, 3), [CASES[3]], '2'), plan8 = planRun(PLAN8, CASES.slice(0, 3), [CASES[3]], '3');
  const three = await hub(undefined, undefined, { [R2]: [job('h', R2, PLAN7, CASES.slice(0, 3), plan7.workbook, ['pass', 'fail', 'pass'])], [R3]: [job('k', R3, PLAN8, CASES.slice(0, 3), plan8.workbook, ['pass', 'fail', 'pass'])] }, { [PLAN7]: plan7, [PLAN8]: plan8 }, [WHOLE, R2, R3, FINAL]); t.after(three.close);
  const out = join(dir, 'e');
  const closed = await run(three, await notes(judgedOnly), out, FINAL);
  assert.equal(closed.code, 0, closed.stderr);
  assert.deepEqual(JSON.parse(closed.stdout).added_runs, [WHOLE, R2, R3]);
  const summary = JSON.parse(await readFile(join(out, 'delivery.json'), 'utf8'));
  assert.deepEqual({ closing: summary.cases[1].closing, label: summary.cases[1].closing_label, rounds: summary.cases[1].rounds }, { closing: 'authoring_failure', label: '模型未找到解决方案', rounds: 3 });
  assert.deepEqual(summary.closings, { authoring_failure: 1, device_defect: 0, missing_fact: 1, author_conflict: 0 });
  assert.match(JSON.parse(closed.stdout).reply, /自动化用例尚未编写正确，已重写自动化用例 3 次，状态已确认，判断错误。原因编写模型的问题/);
  const report = await readFile(join(out, 'delivery_report.md'), 'utf8');
  assert.match(report, /原始用例 990000000000000102 合成用例 102，自动化用例尚未编写正确，已重写自动化用例 3 次，状态已确认，判断错误/);
  assert.match(report, /原因编写模型的问题，下一步合成取舍：本轮不返工。决定者程序。/);
  assert.match(report, /模型说明，状态未确认。合成判断：环境缺前置/);

  // A verbatim defect candidate closes it after one round and is shown as a candidate for arbitration.
  const candidateOut = join(dir, 'f');
  assert.equal((await run(once, await notes(NOTES), candidateOut)).code, 0);
  const candidateReport = await readFile(join(candidateOut, 'unsuccessful_cases.md'), 'utf8');
  assert.match(candidateReport, /模型判断原始用例的期望与设备输出不一致，状态未确认，判断错误。原因还没查清/);
  assert.match(candidateReport, /复现步骤 合成复现：照第 1 步配置后读第 3 步输出\n\n原始用例原句\n```\n合成期望\n```\n\n设备输出\n```\n第 3 步断言没有命中\n```/);
});

test('a pass whose device words carry an execution-failure line its assertions do not read is no verdict, as the reference engine reviews passes', async (t) => {
  // InfoTest batch_tools.py single-case downgrade with the contract's exec_failure_markers, read from the run log of each pass.
  const doc = structuredClone(CONTRACT_DOC) as Record<string, unknown>;
  doc.exec_failure_markers = { source: 'reference-engine/domain_grammar.json', sha256: 'a'.repeat(64), lines: ['Failed to run the synthetic command'] };
  const marked = Buffer.from(JSON.stringify(signTypedRuntime(doc)));
  const [WHOLE2, FINAL3, PLAN7, PLAN8] = ['run_01yyyyyyyyyyyyyyyyyyyyyyyy', 'run_01zzzzzzzzzzzzzzzzzzzzzzza', 'run_01zzzzzzzzzzzzzzzzzzzzzzzb', 'run_01zzzzzzzzzzzzzzzzzzzzzzzc'];
  const plan7 = planRun(PLAN7, CASES.slice(0, 3), [CASES[3]], undefined, marked), plan8 = planRun(PLAN8, [CASES[0], CASES[2]], [CASES[1], CASES[3]], undefined, marked);
  const clean = Buffer.from('seat# configure widget\nseat#\n'), refused = Buffer.from('seat# configure widget\nFailed to run the synthetic command\nseat#\n');
  const read = Buffer.from('seat# configure widget\n健康检查间隔设置成功 Failed to run the synthetic command\nseat#\n');
  // A pass carries its own run log; a failure keeps the shared log its notes quote word for word.
  const rows = (items: string[], verdicts: string[], logs: Uint8Array[]) => items.map((item, k) => ({ item, dynamic_terminal: verdicts[k], evidence: { log: `src:${sha256(verdicts[k] === 'pass' ? logs[k] : log)}` } }));
  const jobOf = (id: string, run: string, plan: string, items: string[], workbook: Uint8Array, r: unknown[]) => ({ ...job(id, run, plan, items, workbook, items.map(() => 'pass')), rows: r });
  const dir = await mkdtemp(join(tmpdir(), 'cc-delivery-'));
  const notesPath = await notes({ [CASES[1]]: NOTES[CASES[1]], [CASES[3]]: NOTES[CASES[3]] });
  // The final verification's pass of CASES[2] rests on a refused command: no pass volume; the case goes back to authoring (next test).
  const refusedFinal = await hub(undefined, undefined, {
    [WHOLE2]: [jobOf('m', WHOLE2, PLAN7, CASES.slice(0, 3), plan7.workbook, rows(CASES.slice(0, 3), ['pass', 'fail', 'pass'], [clean, refused, clean]))],
    [FINAL3]: [jobOf('n', FINAL3, PLAN8, [CASES[0], CASES[2]], plan8.workbook, rows([CASES[0], CASES[2]], ['pass', 'pass'], [clean, refused]))],
  }, { [PLAN7]: plan7, [PLAN8]: plan8 }, [WHOLE2, FINAL3], false, [marked, clean, refused, read]); t.after(refusedFinal.close);
  const refusedRun = await run(refusedFinal, notesPath, join(dir, 'a'), `${WHOLE2},${FINAL3}`);
  assert.equal(refusedRun.code, 1);
  assert.match(refusedRun.stderr, /尚无一起做上机验证且全部正确的自动化用例 Excel。原始用例 990000000000000101 最近一次上机验证正确/);
  assert.match(refusedRun.stderr, /核对设备输出后，以下原始用例状态未知，执行失败原话没有被自动化用例检查：原始用例 990000000000000103 合成用例 103 的设备输出里有一行“Failed to run the synthetic command”/, 'the refusal names the case and the unread line');
  // The same line inside the text an assertion of the case reads is exempt; a refused pass in an earlier dispatch is reported.
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
  assert.match(await readFile(join(out, 'delivery_report.md'), 'utf8'), /核对设备输出后，1 条原始用例有执行失败原话却未被自动化用例检查，状态未知/);
});

test('a pass the review dropped goes back to authoring like a failure, counts as a round and closes at three, as the reference engine redispatches a broken-errored case', async (t) => {
  // InfoTest compile_engine/nodes.py author_redispatch_disposition: failed, contradicted and broken-errored share one round cap.
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

  // One authored version whose pass was dropped, then the pass volume without it: refused, with the line and what to change.
  const once = await hub(undefined, undefined, { [D1]: [jobOf('p', D1, P1, whole, p1.workbook, rows(whole, all, dropped))], [LAST]: last }, { [P1]: p1, [P4]: p4 }, [D1, LAST], false, [marked, clean, refused]); t.after(once.close);
  const early = await run(once, await notes(note), join(dir, 'a'), `${D1},${LAST}`);
  assert.equal(early.code, 1);
  assert.match(early.stderr, /用例 990000000000000103 最近一次上机验证状态未知，设备输出有执行失败原话“Failed to run the synthetic command”，自动化用例没有检查这一行。下一步由编写模型检查这行设备输出，或改用不会执行失败的观察，改好自动化用例再一起做上机验证。已重写自动化用例 1 次，最多重交 3 次/);

  // Three authored versions, one failed and two with a dropped pass: it closes as the model not finding a solution.
  const failedFirst = rows(whole, ['pass', 'pass', 'fail'], dropped);
  const three = await hub(undefined, undefined, { [D1]: [jobOf('p', D1, P1, whole, p1.workbook, failedFirst)], [D2]: [jobOf('q', D2, P2, whole, p2.workbook, rows(whole, all, dropped))], [D3]: [jobOf('r', D3, P3, whole, p3.workbook, rows(whole, all, dropped))], [LAST]: last }, { [P1]: p1, [P2]: p2, [P3]: p3, [P4]: p4 }, [D1, D2, D3, LAST], false, [marked, clean, refused]); t.after(three.close);
  const out = join(dir, 'b');
  const closed = await run(three, await notes(note), out, LAST);
  assert.equal(closed.code, 0, closed.stderr);
  const summary = JSON.parse(await readFile(join(out, 'delivery.json'), 'utf8'));
  assert.deepEqual(summary.cases.map((c: { status: string }) => c.status), ['delivered', 'delivered', 'unsettled', 'unrun']);
  assert.deepEqual({ closing: summary.cases[2].closing, rounds: summary.cases[2].rounds, terminals: summary.cases[2].dispatches.map((d: { terminal: string }) => d.terminal) }, { closing: 'authoring_failure', rounds: 3, terminals: ['fail', 'no_verdict', 'no_verdict'] });
  assert.match(JSON.parse(closed.stdout).reply, /自动化用例尚未编写正确，已重写自动化用例 3 次，状态已确认，判断错误。原因编写模型的问题/);
  const report = await readFile(join(out, 'delivery_report.md'), 'utf8');
  assert.match(report, /原始用例 990000000000000103 合成用例 103，自动化用例尚未编写正确，已重写自动化用例 3 次，状态已确认，判断错误/);
  assert.match(report, /第 3 次上机验证状态未知，设备输出有执行失败原话“Failed to run the synthetic command”，自动化用例没有检查这一行/);
});

test('a case never dispatched closes only on a fact the Hub recorded missing for its own plan; a written claim sends it back to authoring', async (t) => {
  const h = await hub(); t.after(h.close); const out = join(await mkdtemp(join(tmpdir(), 'cc-delivery-')), 'out');
  const closed = await run(h, await notes(NOTES), out);
  assert.equal(closed.code, 0, closed.stderr);
  const summary = JSON.parse(await readFile(join(out, 'delivery.json'), 'utf8'));
  assert.equal(summary.cases[3].status, 'unrun');
  assert.equal(summary.cases[3].closing, 'missing_fact');
  assert.deepEqual(summary.cases[3].missing, { kind: 'data_gap', plan_run: GAP, requirement: 'contract_methods', missing: GAP_WORDS });
  assert.deepEqual(summary.closings, { authoring_failure: 0, device_defect: 1, missing_fact: 1, author_conflict: 0 });
  const report = await readFile(join(out, 'delivery_report.md'), 'utf8');
  assert.match(report, /原始用例 990000000000000104 合成意图 4，缺少脚本编写所需的资料，状态未知。原因缺资料/);
  assert.ok(report.includes(`证据，Hub 核对结果原话。${GAP_WORDS}`));
  // A later plan run that holds the case but was never answered does not hide the record of the earlier one.
  const shadowed = await hub(undefined, undefined, {}, {}, undefined, false, [], 'shadowed'); t.after(shadowed.close);
  const shadowedOut = join(await mkdtemp(join(tmpdir(), 'cc-delivery-')), 'out');
  assert.equal((await run(shadowed, await notes(NOTES), shadowedOut)).code, 0);
  assert.equal(JSON.parse(await readFile(join(shadowedOut, 'delivery.json'), 'utf8')).cases[3].missing.plan_run, GAP);
  // The missing workbook of a plan run is no missing fact; a plan run with no accepted submission or none holding the case certifies
  // nothing; nor does a declared skip, with rounds left or with the run's rounds used up by its other items (run 20).
  for (const gap of ['workbook', 'unsubmitted', 'none', 'skipped', 'skipped-spent'] as const) {
    const g = await hub(undefined, undefined, {}, {}, undefined, false, [], gap); t.after(g.close);
    const refusedOut = join(await mkdtemp(join(tmpdir(), 'cc-delivery-')), 'out');
    const refused = await run(g, await notes(NOTES), refusedOut);
    assert.equal(refused.code, 1, gap);
    assert.match(refused.stderr, new RegExp(`^不存在：用例 ${CASES[3]}尚未上机验证`), gap);
    assert.ok(!refused.stderr.startsWith('已被占用：'), `${gap}: unrun refusal must never use 已被占用: ${refused.stderr}`);
    await assert.rejects(readdir(refusedOut), `${gap}: nothing was written`);
  }
});

test('a plan audited again without a change is not another authored round; a changed plan is', () => {
  const inputs = (p: ReturnType<typeof planRun>) => ({ run: p.record, result: p.result, submission: p.submission, originals: {} }) as unknown as Parameters<typeof planDigest>[0];
  const first = planRun(PLAN1, CASES.slice(0, 3), [CASES[3]]), audited = structuredClone(first);
  ((audited.submission.items[1].slots.plan[0] as unknown as { data: Record<string, unknown> }).data).fidelity = { brief_sha256: 'a'.repeat(64), steps: [], disclosure: '合成：重新审计' };
  assert.equal(planDigest(inputs(audited), CASES[1]), planDigest(inputs(first), CASES[1]));
  assert.notEqual(planDigest(inputs(planRun(PLAN1, CASES.slice(0, 3), [CASES[3]], '2')), CASES[1]), planDigest(inputs(first), CASES[1]));
});

test('a case whose plan the Hub refused until the repair rounds were spent closes as the model not finding a solution, without a dispatch', async (t) => {
  const h = await hub(undefined, undefined, {}, {}, undefined, false, [], 'exhausted'); t.after(h.close);
  const out = join(await mkdtemp(join(tmpdir(), 'cc-delivery-')), 'out');
  const done = await run(h, await notes(NOTES), out);
  assert.equal(done.code, 0, done.stderr);
  const summary = JSON.parse(await readFile(join(out, 'delivery.json'), 'utf8'));
  assert.deepEqual([summary.cases[3].status, summary.cases[3].closing, summary.cases[3].missing.kind, summary.cases[3].missing.plan_run], ['unrun', 'authoring_failure', 'repair_exhausted', GAP]);
  const report = await readFile(join(out, 'delivery_report.md'), 'utf8');
  assert.match(report, /原始用例 990000000000000104 合成意图 4，自动化用例尚未编写正确，状态已确认，判断错误。原因编写模型的问题/);
  assert.ok(report.includes(`证据，Hub 核对结果原话。${SPENT_WORDS}`));
});

test('a notes file that is not valid JSON is named with the place and the text around it, before anything is read from the Hub', async (t) => {
  const h = await hub(); t.after(h.close);
  const dir = await mkdtemp(join(tmpdir(), 'cc-notes-')), broken = join(dir, 'notes.json');
  await writeFile(broken, '{"cases":{"990000000000000102":{"judged":"合成判断：设备回 "拒绝"","remedy":"合成修法"}}}');
  const refused = await run(h, broken, join(dir, 'out'));
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /说明文件 notes\.json 不是合法的 JSON（.+）；出错位置第 \d+ 个字符，附近原文：".*拒绝.*"。常见原因是括号或引号没有成对；改好这个文件再做脚本合并/);
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
  assert.match(JSON.parse(written.stdout).reply, /原始用例 990000000000000102 合成用例 102，模型判断原始用例与手册冲突，状态未确认，判断错误。原因原始用例的问题/);
  const report = await readFile(join(out, 'delivery_report.md'), 'utf8');
  assert.match(report, /原始用例 990000000000000102 合成用例 102，模型判断原始用例与手册冲突，状态未确认，判断错误。原因原始用例的问题/);
  assert.match(report, /下一步使用者核对原始用例、手册和设备输出后决定是否修改原始用例。决定者模型。/);
  assert.match(report, /原始用例 990000000000000104 合成意图 4，模型判断原始用例与手册冲突，状态未确认，判断错误。原因原始用例的问题/);
  assert.match(report, /未做上机验证，这条原始用例未完成脚本编写。/);
  const quoted = (author: string) => `**证据，原始用例原句**，已按照规则核对原文。\n${fenced(author)}\n\n**证据，手册原话**，构建 ${plan1.record.build}，已按照规则核对原文。\n${fenced(CONFLICT.manual)}`;
  assert.ok(report.includes(quoted('合成步骤')) && report.includes(quoted('合成动作')), 'both sentences and the statement are shown as the tool checked them');
  assert.ok((await readFile(join(out, 'unsuccessful_cases.md'), 'utf8')).includes(quoted('合成步骤')));
  assert.doesNotMatch(report, /模型未找到解决方案/, 'the model is not blamed for a conflict the author or the user has to rule on');
});

test('an author conflict whose quotes do not stand, or whose root the Hub cannot give, refuses the delivery and writes nothing', async (t) => {
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
    assert.equal(refused.code, 1, name);
    assert.match(refused.stderr, expected, name);
    await assert.rejects(readdir(out), `${name}: nothing was written`);
  }
  // A root the Hub cannot give, or gives wrong, is said as that: the claim is not called false for it.
  const broken: Array<['absent' | 'tampered' | 'other-root', RegExp]> = [
    ['absent', /Hub 无法读取脚本编写时使用的手册和命令树，原始用例与手册冲突的判断尚未核对/],
    ['tampered', /手册和命令树与保存的原件不一致，原始用例与手册冲突的判断尚未核对/],
    ['other-root', /手册和命令树与脚本编写时使用的构建不一致，原始用例与手册冲突的判断尚未核对/],
  ];
  for (const [mode, expected] of broken) {
    const h = await hub(undefined, undefined, {}, {}, undefined, false, [], 'recorded', mode); t.after(h.close);
    const out = join(dir, mode), refused = await run(h, await note(CONFLICT), out);
    assert.equal(refused.code, 1, mode);
    assert.match(refused.stderr, expected, mode);
    await assert.rejects(readdir(out), `${mode}: nothing was written`);
  }
  // Nothing is cited, nothing is read: a delivery without the claim never asks the Hub for the root (the stub would answer 404).
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
  assert.match(failed.stderr, /^暂时不可用：Hub 不可达（ECONNREFUSED），已等待 60 秒并尝试 10 次仍未恢复。请.*。$/m);
  await assert.rejects(readdir(out2), 'nothing written when retry budget exhausted');
});

test('--scope is refused because delivery scope cannot be narrowed from a local file at delivery time', async (t) => {
  const h = await hub();
  t.after(h.close);
  const dir = await mkdtemp(join(tmpdir(), 'cc-scope-refused-'));
  const scopePath = join(dir, 'scope-trial.md');
  await writeFile(scopePath, `范围：${CASES[0]}\n`);
  const out = join(dir, 'out');
  const refused = await run(h, await notes(NOTES), out, `${WHOLE},${FINAL}`, undefined, ['--scope', scopePath]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /^参数无效：交付时不允许从本地 --scope 文件收窄范围/);
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
  assert.match(payload.reply, /范围：本次共 2 \/ 4 条原始用例，另有 2 条未纳入本次范围（详见交付报告）。/);
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
  const ok = await outputOf(() => main(['--hub', noRecompose.url, '--runs', `${WHOLE},${FINAL}`, '--notes', notesPath, '--out', outNoRec, '--name', '合成无重组批'], async () => TOKEN, () => new Date('2026-11-08T08:00:00Z')));
  assert.equal(ok.code, 0, ok.stderr);
  const summary = JSON.parse(await readFile(join(outNoRec, 'delivery.json'), 'utf8'));
  assert.equal(summary.in_scope_total, 2);
  assert.equal(summary.out_of_scope_total, 2);
  assert.deepEqual(summary.out_of_scope, scope.out_of_scope);
  const report = await readFile(join(outNoRec, 'delivery_report.md'), 'utf8');
  assert.match(report, /990000000000000103 合成标题 3/);
  assert.match(report, /990000000000000104 合成标题 4/);

  // In-scope unrun case without closure still blocks delivery even when parameters.scope is active.
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
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, new RegExp(`^不存在：用例 ${CASES[1]}尚未上机验证`));
  await assert.rejects(readdir(outUnclosed));

  // Dispatch containing an item outside the anchored scope is also refused.
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
