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
import { generationFixture } from '../testing/workbook.ts';
import { satisfiedRecipes } from './generate-workbook.ts';
import { main } from './assemble-delivery.ts';
import { assemble, timeline } from '../functions/delivery.ts';

const TOKEN = 'synthetic-token-1234';
const BOOKING = 'run_01zzzzzzzzzzzzzzzzzzzzzzzz', RECOMPOSED = `rec:${'7'.repeat(64)}`;
const [WHOLE, FINAL, PLAN1, PLAN2, RECOMPOSE] = ['run_01aaaaaaaaaaaaaaaaaaaaaaaa', 'run_01bbbbbbbbbbbbbbbbbbbbbbbb', 'run_01cccccccccccccccccccccccc', 'run_01dddddddddddddddddddddddd', 'run_01eeeeeeeeeeeeeeeeeeeeeeee'];
const CASES = ['990000000000000101', '990000000000000102', '990000000000000103', '990000000000000104'];
const contract = Buffer.from(JSON.stringify(CONTRACT_DOC)), profile = Buffer.from(JSON.stringify(PROFILE_DOC)), inventory = Buffer.from(JSON.stringify(MANIFEST_DOC));
const log = Buffer.from('合成日志：第 3 步断言没有命中\n');

/** A satisfied plan run over `autoids`, as the Hub exports it, with `exclude` frozen in its parameters. */
function planRun(run: string, autoids: string[], exclude: string[]) {
  const recipe = generationFixture();
  const items = autoids.map((autoid) => ({ id: `case-${autoid}`, fields: { ...recipe.fields, autoid, title: `合成用例 ${autoid.slice(-3)}`, path: ['合成文档', '合成分组', `合成用例 ${autoid.slice(-3)}`], steps: [{ text: '合成步骤', expected: ['合成期望'] }] } }));
  const submission = { run, model: 'synthetic-model', items: items.map((item) => ({ item: item.id, handling: 'handled', slots: { plan: [{ data: recipe.slots }] } })) };
  const record = { run, pack: 'case-compile', predecessor: BOOKING, pack_digest: 'b'.repeat(64), root: (recipe.fields.command_catalog as { root: string }).root, build: recipe.build, parameters: { exclude }, items, requirements: REQUIREMENTS.requirements.map((v) => ({ key: v.key, accepted_producer: v.accepted_producer })), sources: [...Object.entries({ contract, profile, inventory }).map(([slot, bytes]) => ({ slot, role: 'expected', reference: `src:${sha256(bytes)}` })), { slot: 'recomposition_result', role: 'expected', reference: RECOMPOSED }] };
  const result = { schema: 'validation@1', run, submission: sha256(canonicalJson(submission)), acceptance: 'accepted', errors: [], locks: { pack: GENERATOR, pack_digest: record.pack_digest, root: record.root }, coverage: { complete: true, examined: items.length, total: items.length }, partitions: { delivered: items.map((item) => ({ item: item.id, requirements: REQUIREMENTS.requirements.map((v) => ({ requirement: v.key, status: v.key === 'workbook_verified' ? 'unresolved' : 'satisfied', claims: v.key === 'commands_known' ? [{ statement: { verdict: 'support', data: { command_catalog: recipe.fields.command_catalog } } }] : v.key === 'contract_methods' ? [{ statement: { verdict: 'support', data: { runtime_version: recipe.contract.runtimeVersion, contract_sha256: recipe.contract.pinned.identity } } }] : [] })) })) } };
  const workbook = generateWorkbookSet(satisfiedRecipes({ run: record, result, submission, contract, profile, inventory }));
  return { record, result, submission, workbook };
}
const plan1 = planRun(PLAN1, CASES.slice(0, 3), [CASES[3]]);
const plan2 = planRun(PLAN2, [CASES[0], CASES[2]], [CASES[1], CASES[3]]);
const recomposed = { run: RECOMPOSE, items: CASES.map((autoid, k) => ({ id: `n/${k}`, fields: { case_id: autoid, atoms: [{ id: 'a1', kind: 'intent', content: `合成意图 ${k + 1}`, after: [] }, { id: 'a2', kind: 'action', content: '合成动作', after: [] }, { id: 'a3', kind: 'expectation', content: '合成期望', after: ['a2'] }] } })) };
const job = (id: string, run: string, plan: string, items: string[], workbook: Uint8Array, verdicts: string[]) => ({ job: id.repeat(64), verification_run: run, plan_run: plan, items, sha256: sha256(workbook), ended: 'done', outcome: 'effective', frozen: false, result: `src:${'9'.repeat(64)}`, device_return: `src:${'8'.repeat(64)}`, rows: items.map((item, k) => ({ item, dynamic_terminal: verdicts[k], ...(verdicts[k] === 'fail' ? { evidence: { log: `src:${sha256(log)}` } } : {}) })) });

/** A synthetic Hub: the verification runs in `order` (default: every one, in insertion order) stand in the lineage booking → plan run → verification run, each started after the one before. */
async function hub(finalVerdicts = ['pass', 'pass'], finalWorkbook = plan2.workbook, extraJobs: Record<string, unknown[]> = {}, extraPlans: Record<string, ReturnType<typeof planRun>> = {}, order?: string[]) {
  const all: Record<string, unknown[]> = { [WHOLE]: [job('a', WHOLE, PLAN1, CASES.slice(0, 3), plan1.workbook, ['pass', 'fail', 'pass'])], [FINAL]: [job('b', FINAL, PLAN2, [CASES[0], CASES[2]], finalWorkbook, finalVerdicts)], ...extraJobs };
  const runsInOrder = order ?? Object.keys(all);
  const jobs = Object.fromEntries(runsInOrder.map((run) => [run, all[run]]));
  const plans: Record<string, ReturnType<typeof planRun>> = { [PLAN1]: plan1, [PLAN2]: plan2, ...extraPlans };
  const planOfRun = (run: string) => (jobs[run][0] as { plan_run: string }).plan_run;
  const at = (k: number) => `2026-11-08T0${Math.floor(k / 60)}:${String(k % 60).padStart(2, '0')}:00.000Z`;
  const successors: Record<string, unknown[]> = { [BOOKING]: [...new Set(runsInOrder.map(planOfRun))].map((plan, k) => ({ run: plan, pack: 'case-compile@9.9.9', started_at: at(2 * k), predecessor: BOOKING, parameters: { exclude: [] }, sources: plans[plan].record.sources.map((s) => ({ slot: s.slot, reference: s.reference })) })) };
  runsInOrder.forEach((run, k) => { (successors[planOfRun(run)] ??= []).push({ run, pack: 'case-compile@9.9.9', started_at: at(2 * k + 1), predecessor: planOfRun(run), parameters: { plan_run: planOfRun(run) }, sources: [] }); });
  const originals = new Map([contract, profile, inventory, log].map((bytes) => [sha256(bytes), bytes]));
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    if (request.headers.authorization !== `Bearer ${TOKEN}`) { response.statusCode = 401; response.end(); return; }
    const jobsOf = /^\/run-export\/(run_\w+)\/jobs$/.exec(url); if (jobsOf && jobs[jobsOf[1]]) { response.end(JSON.stringify({ schema: 'run-jobs@1', run: jobsOf[1], jobs: jobs[jobsOf[1]] })); return; }
    const next = /^\/run-export\/(run_\w+)\/successors$/.exec(url); if (next) { response.end(JSON.stringify({ schema: 'run-successors@1', run: next[1], successors: successors[next[1]] ?? [] })); return; }
    const whole = /^\/run-export\/(run_\w+)$/.exec(url); if (whole && plans[whole[1]]) { const p = plans[whole[1]]; response.end(JSON.stringify({ schema: 'run-export@1', run: p.record, result: p.result, submission: p.submission })); return; }
    if (url === `/run-export/${RECOMPOSE}/run`) { response.end(JSON.stringify({ schema: 'run-export@1', run: recomposed })); return; }
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
const NOTES = { [CASES[1]]: { judged: '合成判断：计划写错', remedy: '合成修法：改计划后重跑' }, [CASES[3]]: { judged: '合成判断：缺事实', remedy: '合成取舍：等补证' } };
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

test('a passed case left out of the pass volume is reported, not delivered; with no pass volume a pass is refused; an all-fail last dispatch delivers nothing', () => {
  const d = (run: string, items: string[], verdicts: string[]) => ({ run, job: 'j-' + run, plan_run: PLAN1, sha256: 'c'.repeat(64), items, rows: items.map((item, k) => ({ item, dynamic_terminal: verdicts[k] })) });
  const left = assemble(CASES.slice(0, 3), [d(WHOLE, CASES.slice(0, 3), ['pass', 'fail', 'pass']), d(FINAL, [CASES[0]], ['pass'])]);
  assert.equal(left.pass?.run, FINAL);
  assert.deepEqual(left.totals, { cases: 3, delivered: 1, failed: 1, unsettled: 1, unrun: 0 });
  const out = left.cases.find((c) => c.autoid === CASES[2])!;
  assert.equal(out.status, 'unsettled');
  assert.match(timeline(out, false), /第 1 次上机（核验运行 run_01a+）：通过；最近一次通过了，但不在终验（核验运行 run_01b+）的通过卷里，没有交付。/);
  assert.deepEqual(left.unsuccessful?.items, [CASES[1], CASES[2]]);
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
  const notesPath = await notes({ ...NOTES, [CASES[2]]: { judged: '合成判断：返工后仍失败', remedy: '合成取舍：继续加轮' } });
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
  // A later volume that passed whole becomes the pass volume; passes outside it are not delivered.
  const extra = { ...retry, run: 'run_01rrrrrrrrrrrrrrrrrrrrrrrr', items: [CASES[1]], rows: [{ item: CASES[1], dynamic_terminal: 'pass' }] };
  const later = assemble(CASES, [...dispatches, retry, extra]);
  assert.equal(later.pass?.run, extra.run);
  assert.deepEqual(later.cases.filter((c) => c.status === 'unsettled').map((c) => c.autoid), [CASES[0], CASES[2]]);
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
  assert.equal(printed.reply, [`交付目录：${out}`, '共 4 条：交付 2，上机未通过 1，上机没有结论 0，没有上机 1。', ...['case.xlsx', 'unsuccessful_cases.xlsx', 'delivery_report.md', 'unsuccessful_cases.md', 'delivery.json'].map((name) => `- ${join(out, name)}`)].join('\n'));
  const summary = JSON.parse(await readFile(join(out, 'delivery.json'), 'utf8'));
  assert.deepEqual(summary.added_runs, [WHOLE]);
  assert.match(await readFile(join(out, 'delivery_report.md'), 'utf8'), new RegExp(`第 1 次上机（核验运行 ${WHOLE}）：失败`));
});
