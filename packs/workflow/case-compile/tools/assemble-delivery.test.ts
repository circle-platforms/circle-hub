// The delivery directory at the end of a compile run, against a synthetic Hub stub only: a whole-volume dispatch with one
// failure, then the pass volume dispatched on its own (the final verification).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import REQUIREMENTS from '../requirements.json' with { type: 'json' };
import { canonicalJson } from '../functions/canonical-json.ts';
import { GENERATOR, generateWorkbookSet } from '../functions/generate.ts';
import { sha256 } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { CONTRACT_DOC, MANIFEST_DOC, PROFILE_DOC } from '../functions/test-support.ts';
import { signTypedRuntime } from '../testing/typed-fixtures.ts';
import { generationFixture } from '../testing/workbook.ts';
import { satisfiedRecipes } from './generate-workbook.ts';
import { main, planDigest } from './assemble-delivery.ts';
import { assemble, timeline } from '../functions/delivery.ts';

const TOKEN = 'synthetic-token-1234';
const BOOKING = 'run_01zzzzzzzzzzzzzzzzzzzzzzzz', RECOMPOSED = `rec:${'7'.repeat(64)}`;
const [WHOLE, FINAL, PLAN1, PLAN2, RECOMPOSE] = ['run_01aaaaaaaaaaaaaaaaaaaaaaaa', 'run_01bbbbbbbbbbbbbbbbbbbbbbbb', 'run_01cccccccccccccccccccccccc', 'run_01dddddddddddddddddddddddd', 'run_01eeeeeeeeeeeeeeeeeeeeeeee'];
const CASES = ['990000000000000101', '990000000000000102', '990000000000000103', '990000000000000104'];
const contract = Buffer.from(JSON.stringify(CONTRACT_DOC)), profile = Buffer.from(JSON.stringify(PROFILE_DOC)), inventory = Buffer.from(JSON.stringify(MANIFEST_DOC));
const log = Buffer.from('合成日志：第 3 步断言没有命中\n');

/** A satisfied plan run over `autoids`, as the Hub exports it, with `exclude` frozen in its parameters; `pause` varies the plan (another authored round). */
function planRun(run: string, autoids: string[], exclude: string[], pause?: string, contractBytes: Uint8Array = contract) {
  const recipe = generationFixture();
  if (pause) recipe.slots.steps[2] = { ...recipe.slots.steps[2], args: [pause] };
  const items = autoids.map((autoid) => ({ id: `case-${autoid}`, fields: { ...recipe.fields, autoid, title: `合成用例 ${autoid.slice(-3)}`, path: ['合成文档', '合成分组', `合成用例 ${autoid.slice(-3)}`], steps: [{ text: '合成步骤', expected: ['合成期望'] }] } }));
  const submission = { run, model: 'synthetic-model', items: items.map((item) => ({ item: item.id, handling: 'handled', slots: { plan: [{ data: recipe.slots }] } })) };
  const record = { run, pack: 'case-compile', predecessor: BOOKING, pack_digest: 'b'.repeat(64), root: (recipe.fields.command_catalog as { root: string }).root, build: recipe.build, parameters: { exclude }, items, requirements: REQUIREMENTS.requirements.map((v) => ({ key: v.key, accepted_producer: v.accepted_producer })), sources: [...Object.entries({ contract: contractBytes, profile, inventory }).map(([slot, bytes]) => ({ slot, role: 'expected', reference: `src:${sha256(bytes)}` })), { slot: 'recomposition_result', role: 'expected', reference: RECOMPOSED }] };
  const result = { schema: 'validation@1', run, submission: sha256(canonicalJson(submission)), acceptance: 'accepted', errors: [], locks: { pack: GENERATOR, pack_digest: record.pack_digest, root: record.root }, coverage: { complete: true, examined: items.length, total: items.length }, partitions: { delivered: items.map((item) => ({ item: item.id, requirements: REQUIREMENTS.requirements.map((v) => ({ requirement: v.key, status: v.key === 'workbook_verified' ? 'unresolved' : 'satisfied', claims: v.key === 'commands_known' ? [{ statement: { verdict: 'support', data: { command_catalog: recipe.fields.command_catalog } } }] : v.key === 'contract_methods' ? [{ statement: { verdict: 'support', data: { runtime_version: recipe.contract.runtimeVersion, contract_sha256: recipe.contract.pinned.identity } } }] : [] })) })) } };
  const workbook = generateWorkbookSet(satisfiedRecipes({ run: record, result, submission, contract: contractBytes, profile, inventory }));
  return { record, result, submission, workbook };
}
const plan1 = planRun(PLAN1, CASES.slice(0, 3), [CASES[3]]);
const plan2 = planRun(PLAN2, [CASES[0], CASES[2]], [CASES[1], CASES[3]]);
// The plan run that held CASES[3] before the model left it out of the others.
const GAP = 'run_01777777777777777777777777', LATER = 'run_01888888888888888888888888', GAP_WORDS = '合成缺失事实：配置命令的逆操作不在锁定树里', SPENT_WORDS = '合成：缺少修复后符合要求的产物（修复轮数用完）';
type Gap = 'recorded' | 'exhausted' | 'shadowed' | 'workbook' | 'unsubmitted' | 'none';
/**
 * The Hub left the plan of CASES[3] pending on a missing fact with a request (`recorded`), without an accepted plan after the
 * repair rounds (`exhausted`), on the missing workbook only (`workbook`), or never accepted a submission (`unsubmitted`).
 */
function gapRun(kind: 'recorded' | 'exhausted' | 'workbook' | 'unsubmitted', run = GAP) {
  const p = planRun(run, [CASES[3]], []);
  const pending = (missing: string) => ({ status: 'pending', claims: [], layers: [{ layer: 'static', terminal: 'unchecked', reason: 'missing_input', attribution: 'data_gap', exit: { action: 'request', audience: { user: 'usr_synthetic' }, due: '2026-11-09T00:00:00.000Z', request_kind: 'clarification' }, missing }] });
  const spent = { status: 'pending', claims: [], layers: [{ layer: 'static', terminal: 'incomplete', reason: 'repair_exhausted', attribution: 'producer_error', exit: { action: 'request', audience: { user: 'usr_synthetic' }, due: '2026-11-09T00:00:00.000Z', request_kind: 'repair' }, missing: SPENT_WORDS }] };
  for (const r of p.result.partitions.delivered[0].requirements as Array<Record<string, unknown>>) {
    if (r.requirement === 'workbook_verified') Object.assign(r, kind === 'exhausted' ? spent : pending('合成：缺少客户端生成的工作簿'));
    else if (kind === 'recorded' && r.requirement === 'contract_methods') Object.assign(r, pending(GAP_WORDS));
    else if (kind === 'exhausted') Object.assign(r, spent);
  }
  return { plan: p, submitted: kind !== 'unsubmitted' };
}
const recomposed = { run: RECOMPOSE, items: CASES.map((autoid, k) => ({ id: `n/${k}`, fields: { case_id: autoid, atoms: [{ id: 'a1', kind: 'intent', content: `合成意图 ${k + 1}`, after: [] }, { id: 'a2', kind: 'action', content: '合成动作', after: [] }, { id: 'a3', kind: 'expectation', content: '合成期望', after: ['a2'] }] } })) };
const job = (id: string, run: string, plan: string, items: string[], workbook: Uint8Array, verdicts: string[]) => ({ job: id.repeat(64), verification_run: run, plan_run: plan, items, sha256: sha256(workbook), ended: 'done', outcome: 'effective', frozen: false, result: `src:${'9'.repeat(64)}`, device_return: `src:${'8'.repeat(64)}`, rows: items.map((item, k) => ({ item, dynamic_terminal: verdicts[k], ...(verdicts[k] === 'fail' ? { evidence: { log: `src:${sha256(log)}` } } : {}) })) });

/** A synthetic Hub: the verification runs in `order` (default: every one, in insertion order) stand in the lineage booking → plan run → verification run, each started after the one before. */
async function hub(finalVerdicts = ['pass', 'pass'], finalWorkbook = plan2.workbook, extraJobs: Record<string, unknown[]> = {}, extraPlans: Record<string, ReturnType<typeof planRun>> = {}, order?: string[], chain = false, extraOriginals: Uint8Array[] = [], gap: Gap = 'recorded') {
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
    records[run] = { run, pack: 'case-compile@9.9.9', started_at: at(k++), predecessor: plan, parameters: { plan_run: plan }, sources: plans[plan].record.sources };
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
const run = (h: { url: string }, notesPath: string, out: string, runs = `${WHOLE},${FINAL}`) => outputOf(() => main(['--hub', h.url, '--runs', runs, '--recompose', RECOMPOSE, '--notes', notesPath, '--out', out, '--name', '合成批'], async () => TOKEN, () => new Date('2026-11-08T08:00:00Z')));

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
  assert.deepEqual(summary.cases[1].dispatches.map((d: { label: string }) => d.label), ['失败']);
  assert.equal(summary.unsuccessful_volume.dispatched, false);
  const report = await readFile(join(out, 'delivery_report.md'), 'utf8');
  assert.match(report, /^# 交付报告 — 合成批\n> 生成 2026-11-08 /);
  assert.match(report, /交付 2，上机未通过 1，上机没有结论 0，没有上机 1/);
  assert.match(report, /\*\*发生了什么\*\*：第 1 次上机（核验运行 run_01a+）：失败。/);
  assert.match(report, /\*\*怎么判断的\*\*：合成判断：计划写错\n\n\*\*修复方案／取舍\*\*：合成修法：改计划后重跑/);
  assert.match(report, /没有上机：计划运行用 parameters\.exclude 排除了这一条/);
  assert.match(report, /## 合成意图 4/, 'a case never compiled takes its title from the recomposition');
  const long = await readFile(join(out, 'unsuccessful_cases.md'), 'utf8');
  assert.match(long, /\*\*脑图原始用例\*\*：\n- 合成步骤 → 预期：合成期望/);
  assert.match(long, /合成日志：第 3 步断言没有命中/);
});

test('a last dispatch with mixed verdicts, a regenerated workbook that differs and notes that miss a case are refused, writing nothing', async (t) => {
  const mixed = await hub(['pass', 'fail']); t.after(mixed.close);
  const out = join(await mkdtemp(join(tmpdir(), 'cc-delivery-')), 'out');
  assert.match((await run(mixed, await notes(NOTES), out)).stderr, /还没有一次整卷全部通过、之后也没再失败的上机，990000000000000101 最近一次上机通过了。通过卷要单独整卷上机/);
  const only = await hub(undefined, undefined, {}, {}, [WHOLE]); t.after(only.close);
  const both = await hub(); t.after(both.close);
  assert.match((await run(only, await notes(NOTES), out, WHOLE)).stderr, /990000000000000101、990000000000000103 最近一次上机通过了/, 'the whole volume alone is not a pass volume');
  const other = await hub(['pass', 'pass'], Buffer.from('另一份工作簿')); t.after(other.close);
  assert.match((await run(other, await notes(NOTES), out)).stderr, /重算的工作簿和核验运行 run_01b+ 派发的那份字节不一致/);
  assert.match((await run(both, await notes({ [CASES[1]]: NOTES[CASES[1]] }), out)).stderr, /说明要恰好覆盖没有交付的用例：缺 990000000000000104/);
  assert.match((await run(both, await notes({ ...NOTES, [CASES[0]]: NOTES[CASES[1]] }), out)).stderr, /多了 990000000000000101（交付的用例不写说明）/);
  await assert.rejects(readdir(out), 'nothing was written');
});

test('a recent pass outside the pass volume refuses the delivery, as does a pass with no pass volume; an all-fail last dispatch delivers nothing', () => {
  const d = (run: string, items: string[], verdicts: string[]) => ({ run, job: 'j-' + run, plan_run: PLAN1, sha256: 'c'.repeat(64), items, rows: items.map((item, k) => ({ item, dynamic_terminal: verdicts[k] })) });
  // Run 15's shape: the passes ran together, one was rerun alone and passed; the volume that ships must hold every recent pass.
  assert.throws(() => assemble(CASES.slice(0, 3), [d(WHOLE, CASES.slice(0, 3), ['pass', 'fail', 'pass']), d(FINAL, [CASES[0]], ['pass'])]), /最近一次上机通过的 990000000000000103 不在最后一次整卷全部通过的那一卷（核验运行 run_01b+）里。所有最近一次上机通过的用例要放在同一卷里一起整卷上机/);
  const together = assemble(CASES.slice(0, 3), [d(WHOLE, CASES.slice(0, 3), ['pass', 'fail', 'pass']), d(FINAL, [CASES[0], CASES[2]], ['pass', 'pass'])]);
  assert.deepEqual(together.totals, { cases: 3, delivered: 2, failed: 1, unsettled: 0, unrun: 0 });
  assert.match(timeline(together.cases[1], false), /^第 1 次上机（核验运行 run_01a+）：失败。$/);
  assert.throws(() => assemble(CASES.slice(0, 3), [d(WHOLE, CASES.slice(0, 3), ['pass', 'fail', 'pass'])]), /还没有一次整卷全部通过、之后也没再失败的上机，990000000000000101、990000000000000103 最近一次上机通过了/);
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
  assert.match(await readFile(join(out, 'delivery_report.md'), 'utf8'), new RegExp(`每条用它最后一次上机的计划（计划运行 ${PLAN1}、${PLAN3}）`));
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
  assert.throws(() => assemble(CASES, [...dispatches, rerun]), /还没有一次整卷全部通过、之后也没再失败的上机，990000000000000103 最近一次上机通过了/);
  // A later try that reruns the pass volume, passes it again and fails only the case it added leaves the pass volume standing.
  const retry = { ...rerun, run: 'run_01qqqqqqqqqqqqqqqqqqqqqqqq', items: [CASES[0], CASES[2], CASES[1]], rows: [{ item: CASES[0], dynamic_terminal: 'pass' }, { item: CASES[2], dynamic_terminal: 'pass' }, { item: CASES[1], dynamic_terminal: 'fail' }] };
  const settled = assemble(CASES, [...dispatches, retry]);
  assert.equal(settled.pass?.run, FINAL);
  assert.deepEqual(settled.unsuccessful?.items, [CASES[1]]);
  assert.equal(settled.unsuccessful?.sources[CASES[1]].run, retry.run);
  // A later volume that passed whole while recent passes stay outside it is not a delivery: they go to the bed together first.
  const extra = { ...retry, run: 'run_01rrrrrrrrrrrrrrrrrrrrrrrr', items: [CASES[1]], rows: [{ item: CASES[1], dynamic_terminal: 'pass' }] };
  assert.throws(() => assemble(CASES, [...dispatches, retry, extra]), /最近一次上机通过的 990000000000000101、990000000000000103 不在最后一次整卷全部通过的那一卷（核验运行 run_01r+）里/);
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
  assert.equal(printed.reply, [`交付目录：${out}`, '共 4 条：交付 2，上机未通过 1，上机没有结论 0，没有上机 1。', '上机未通过的终态：声明与设备行为冲突（待仲裁） 1。没有上机的终态：缺少 Hub 点名的事实（待补齐） 1。', ...['case.xlsx', 'unsuccessful_cases.xlsx', 'delivery_report.md', 'unsuccessful_cases.md', 'delivery.json'].map((name) => `- ${join(out, name)}`)].join('\n'));
  const summary = JSON.parse(await readFile(join(out, 'delivery.json'), 'utf8'));
  assert.deepEqual(summary.added_runs, [WHOLE]);
  assert.match(await readFile(join(out, 'delivery_report.md'), 'utf8'), new RegExp(`第 1 次上机（核验运行 ${WHOLE}）：失败`));
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
  assert.match(missing.stderr, /用例 990000000000000102 上过机，说明里缺 evidence/);
  const invented = await run(h, await notes({ ...NOTES, [CASES[1]]: { judged: '合成判断', remedy: '合成修法', evidence: '设备说一切正常' } }), join(dir, 'b'));
  assert.equal(invented.code, 1);
  assert.match(invented.stderr, /用例 990000000000000102 的 evidence 不是它最后一次上机设备返回里的原话/);
  const out = join(dir, 'c');
  const ok = await run(h, await notes(NOTES), out);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(await readFile(join(out, 'delivery_report.md'), 'utf8'), /\*\*设备原话\*\*（已核对出自最后一次上机的设备返回）：\n```device-evidence\n第 3 步断言没有命中\n```/);
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
  assert.match(early.stderr, /用例 990000000000000102 上机没通过的编写轮次是 1，还不到 3 轮（同一份计划重跑不算新的一轮）。说明里的判断不能让它定下结论：环境缺数据、缺拓扑、缺前置这类文字主张不是依据，照用例原样继续编写/);
  const unquoted = await run(once, await notes({ ...NOTES, [CASES[1]]: { ...NOTES[CASES[1]], defect_candidate: { ...CANDIDATE, expected: '作者没写过的期望', actual: '设备说一切正常' } } }), join(dir, 'b'));
  assert.equal(unquoted.code, 1);
  assert.match(unquoted.stderr, /用例 990000000000000102 的 defect_candidate：expected 不是这条用例作者期望原文里的字；actual 不是它最后一次上机设备返回里的原话/);
  assert.match((await run(once, await notes({ ...NOTES, [CASES[1]]: { ...NOTES[CASES[1]], defect_candidate: { repro: '合成复现' } } }), join(dir, 'c'))).stderr, /defect_candidate 恰好写 repro（复现步骤）、expected（作者期望原文）和 actual（设备原话）三项/);

  // A rerun of the same plan is not another authored round.
  const rerun = await hub(undefined, undefined, { [AGAIN]: [job('g', AGAIN, PLAN1, CASES.slice(0, 3), plan1.workbook, ['pass', 'fail', 'pass'])] }, {}, [WHOLE, AGAIN, FINAL]); t.after(rerun.close);
  assert.match((await run(rerun, await notes(judgedOnly), join(dir, 'd'), `${WHOLE},${AGAIN},${FINAL}`)).stderr, /编写轮次是 1，还不到 3 轮/);

  // Three distinct plans of it failed: it closes as the model not finding a solution, and its judgement is reported as its own account.
  const plan7 = planRun(PLAN7, CASES.slice(0, 3), [CASES[3]], '2'), plan8 = planRun(PLAN8, CASES.slice(0, 3), [CASES[3]], '3');
  const three = await hub(undefined, undefined, { [R2]: [job('h', R2, PLAN7, CASES.slice(0, 3), plan7.workbook, ['pass', 'fail', 'pass'])], [R3]: [job('k', R3, PLAN8, CASES.slice(0, 3), plan8.workbook, ['pass', 'fail', 'pass'])] }, { [PLAN7]: plan7, [PLAN8]: plan8 }, [WHOLE, R2, R3, FINAL]); t.after(three.close);
  const out = join(dir, 'e');
  const closed = await run(three, await notes(judgedOnly), out, FINAL);
  assert.equal(closed.code, 0, closed.stderr);
  assert.deepEqual(JSON.parse(closed.stdout).added_runs, [WHOLE, R2, R3]);
  const summary = JSON.parse(await readFile(join(out, 'delivery.json'), 'utf8'));
  assert.deepEqual({ closing: summary.cases[1].closing, label: summary.cases[1].closing_label, rounds: summary.cases[1].rounds }, { closing: 'authoring_failure', label: '模型未找到解决方案', rounds: 3 });
  assert.deepEqual(summary.closings, { authoring_failure: 1, device_defect: 0, missing_fact: 1 });
  assert.match(JSON.parse(closed.stdout).reply, /\n上机未通过的终态：模型未找到解决方案 1。没有上机的终态：缺少 Hub 点名的事实（待补齐） 1。\n/);
  const report = await readFile(join(out, 'delivery_report.md'), 'utf8');
  assert.match(report, /上机未通过 1，上机没有结论 0，没有上机 1。上机未通过的终态：模型未找到解决方案 1。/);
  assert.match(report, /- 编号 `990000000000000102` · 状态：上机未通过 · 上机 3 次 · 终态：模型未找到解决方案/);
  assert.match(report, /\*\*结论\*\*：模型未找到解决方案：编写 3 轮，每一轮上机都没通过，作者内容未改、没有核对得上的缺陷候选；下面“怎么判断的”是模型自述，不是定下结论的依据。\n\n\*\*怎么判断的\*\*：合成判断：环境缺前置/);

  // A verbatim defect candidate closes it after one round and is shown as a candidate for arbitration.
  const candidateOut = join(dir, 'f');
  assert.equal((await run(once, await notes(NOTES), candidateOut)).code, 0);
  const candidateReport = await readFile(join(candidateOut, 'unsuccessful_cases.md'), 'utf8');
  assert.match(candidateReport, /· 终态：声明与设备行为冲突（待仲裁）/);
  assert.match(candidateReport, /\*\*缺陷候选\*\*：复现步骤：合成复现：照第 1 步配置后读第 3 步输出\n\n作者期望（原文）：\n```device-evidence\n合成期望\n```\n\n设备实际（原话）：\n```device-evidence\n第 3 步断言没有命中\n```/);
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
  // The final verification's pass of CASES[2] rests on a refused command: no pass volume, so the run must exclude it and verify again.
  const refusedFinal = await hub(undefined, undefined, {
    [WHOLE2]: [jobOf('m', WHOLE2, PLAN7, CASES.slice(0, 3), plan7.workbook, rows(CASES.slice(0, 3), ['pass', 'fail', 'pass'], [clean, refused, clean]))],
    [FINAL3]: [jobOf('n', FINAL3, PLAN8, [CASES[0], CASES[2]], plan8.workbook, rows([CASES[0], CASES[2]], ['pass', 'pass'], [clean, refused]))],
  }, { [PLAN7]: plan7, [PLAN8]: plan8 }, [WHOLE2, FINAL3], false, [marked, clean, refused, read]); t.after(refusedFinal.close);
  const refusedRun = await run(refusedFinal, notesPath, join(dir, 'a'), `${WHOLE2},${FINAL3}`);
  assert.equal(refusedRun.code, 1);
  assert.match(refusedRun.stderr, /还没有一次整卷全部通过、之后也没再失败的上机，990000000000000101 最近一次上机通过了/);
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
  assert.match(await readFile(join(out, 'delivery_report.md'), 'utf8'), /- 通过复核（InfoTest 的执行失败标记，合约声明 1 条）：读了 4 条通过的运行日志，1 条里有本条断言没读的执行失败原话、改记无判定。/);
});

test('a case never dispatched closes only on a fact the Hub recorded missing for its own plan; a written claim sends it back to authoring', async (t) => {
  const h = await hub(); t.after(h.close); const out = join(await mkdtemp(join(tmpdir(), 'cc-delivery-')), 'out');
  const closed = await run(h, await notes(NOTES), out);
  assert.equal(closed.code, 0, closed.stderr);
  const summary = JSON.parse(await readFile(join(out, 'delivery.json'), 'utf8'));
  assert.equal(summary.cases[3].status, 'unrun');
  assert.equal(summary.cases[3].closing, 'missing_fact');
  assert.deepEqual(summary.cases[3].missing, { kind: 'data_gap', plan_run: GAP, requirement: 'contract_methods', missing: GAP_WORDS });
  assert.deepEqual(summary.closings, { authoring_failure: 0, device_defect: 1, missing_fact: 1 });
  const report = await readFile(join(out, 'delivery_report.md'), 'utf8');
  assert.match(report, /上机未通过的终态：声明与设备行为冲突（待仲裁） 1。没有上机的终态：缺少 Hub 点名的事实（待补齐） 1。/);
  assert.ok(report.includes(`**结论**：缺少 Hub 点名的事实（待补齐）：它的计划在计划运行 ${GAP} 交给 Hub，Hub 判它缺少事实并点名了补证请求（Hub 原话：${GAP_WORDS}）；补齐前不生成工作簿、不上机。`));
  // A later plan run that holds the case but was never answered does not hide the record of the earlier one.
  const shadowed = await hub(undefined, undefined, {}, {}, undefined, false, [], 'shadowed'); t.after(shadowed.close);
  const shadowedOut = join(await mkdtemp(join(tmpdir(), 'cc-delivery-')), 'out');
  assert.equal((await run(shadowed, await notes(NOTES), shadowedOut)).code, 0);
  assert.equal(JSON.parse(await readFile(join(shadowedOut, 'delivery.json'), 'utf8')).cases[3].missing.plan_run, GAP);
  // The missing workbook of a plan run is no missing fact; a plan run with no accepted submission or none holding the case certifies nothing.
  for (const gap of ['workbook', 'unsubmitted', 'none'] as const) {
    const g = await hub(undefined, undefined, {}, {}, undefined, false, [], gap); t.after(g.close);
    const refusedOut = join(await mkdtemp(join(tmpdir(), 'cc-delivery-')), 'out');
    const refused = await run(g, await notes(NOTES), refusedOut);
    assert.equal(refused.code, 1, gap);
    assert.match(refused.stderr, new RegExp(`用例 ${CASES[3]} 没有上机，Hub 也没有给它的计划记下缺少的事实或修正轮次用完。说明里的判断不能让它定下结论：环境缺数据、缺拓扑、缺前置、缺命令这类文字主张不是依据，照用例原样编写、交卷，和其他用例一起整卷上机`), gap);
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
  assert.match(report, /没有上机的终态：模型未找到解决方案 1。/);
  assert.ok(report.includes(`**结论**：模型未找到解决方案：它的计划在计划运行 ${GAP} 交给 Hub，修正轮次用完也没有受理（Hub 原话：${SPENT_WORDS}），没有上机；按 InfoTest 的收口规则`));
});
