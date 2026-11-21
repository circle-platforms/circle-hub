import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fidelityBrief, fidelityProblems } from '../functions/fidelity.ts';
import { goodData } from '../functions/test-support.ts';
import { briefFile, main as brief, verdictFile } from './fidelity-brief.ts';
import { main as apply } from './fidelity-apply.ts';

const RECORD = { schema: 'recompose-record@1', contract: { intent: { text: '合成意图' } }, atoms: [{ id: 'a1', kind: 'intent', text: '合成意图' }, { id: 'a2', kind: 'action', text: '配置合成名字' }], ledgers: { original: [{ atom: 'a2', text: '配置合成名字' }], adapted: [], concretizations: [], rebindings: [] } };

async function quiet(run: () => Promise<number>) {
  const out: string[] = [], err: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout), stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { err.push(String(c)); return true; }) as typeof process.stderr.write;
  try { return { code: await run(), stdout: out.join(''), stderr: err.join('') }; } finally { process.stdout.write = stdout; process.stderr.write = stderr; }
}
async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'cc-fidelity-')); const plans = join(dir, 'plans'), briefs = join(dir, 'briefs'); await mkdir(plans);
  await writeFile(join(dir, 'run.json'), JSON.stringify({ run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', items: [{ id: 'doc-1:c-1', fields: { recomposition: { record: RECORD } } }, { id: 'doc-1:c-2', fields: {} }] }));
  const data = goodData() as unknown as Record<string, unknown>; (data.steps as Array<Record<string, unknown>>)[0].args = ['widget name {{name:40}}'];
  await writeFile(join(plans, '00.json'), JSON.stringify({ item: 'doc-1:c-1', handling: 'handled', slots: { plan: [{ data }] } }));
  await writeFile(join(plans, '01.json'), JSON.stringify({ item: 'doc-1:c-2', handling: 'handled', slots: { plan: [{ data: goodData() }] } }));
  const runBrief = () => quiet(() => brief(['--run', dir, '--plans', plans, '--out', briefs]));
  const runApply = () => quiet(() => apply(['--run', dir, '--plans', plans, '--briefs', briefs]));
  const planOf = async () => JSON.parse(await readFile(join(plans, '00.json'), 'utf8'));
  const verdictPath = async () => { const { fidelity: _f, ...rest } = (await planOf()).slots.plan[0].data; return verdictFile(briefs, '00', fidelityBrief('doc-1:c-1', RECORD, rest)!.brief_sha256); };
  return { dir, plans, briefs, runBrief, runApply, planOf, verdictPath, quiet };
}
const VERDICT = { steps: [{ n: 'a2', verdict: 'preserved', step_indices: [1], rationale: '合成理由：第 1 步配置了名字' }], disclosure: '合成说明：作者的一步由第 1 步实现。' };

test('--run is the run directory like task-brief.ts: the run.json file is refused by the brief and the merge tools with the one-line correct form, and nothing is written', async () => {
  const w = await workspace();
  const runFile = join(w.dir, 'run.json');
  const form = "合法写法：--run '<运行目录>'（放 run.json 的目录，不是 run.json 文件）。";
  for (const [name, refused] of [
    ['fidelity-brief', await w.quiet(() => brief(['--run', runFile, '--plans', w.plans, '--out', w.briefs]))],
    ['fidelity-apply', await w.quiet(() => apply(['--run', runFile, '--plans', w.plans, '--briefs', w.briefs]))],
  ] as const) {
    assert.equal(refused.code, 1, name);
    assert.equal(refused.stdout, '', name);
    assert.ok(refused.stderr.startsWith(`参数无效：--run ${runFile} 不是普通目录。`), `${name}: ${refused.stderr}`);
    assert.ok(refused.stderr.trimEnd().endsWith(form), `${name}: ${refused.stderr}`);
    assert.equal(refused.stderr.trim().split('\n').length, 1, name);
  }
  await assert.rejects(readdir(w.briefs), { code: 'ENOENT' }, 'a refused call creates no brief directory');
  const bare = await mkdtemp(join(tmpdir(), 'cc-fidelity-bare-'));
  const empty = await w.quiet(() => brief(['--run', bare, '--plans', w.plans, '--out', w.briefs]));
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /^不存在：找不到 --run 目录里的 run\.json 文件 /);
  assert.equal((await w.runBrief()).code, 0);
});

test('the brief is computed from the expanded plan the Hub will receive, with the literal measured, one file per case with authored actions', async () => {
  const w = await workspace();
  const { code, stdout, stderr } = await w.runBrief();
  assert.equal(code, 0, stderr);
  const printed = JSON.parse(stdout);
  assert.deepEqual(printed.skipped, [{ file: '01.json', reason: '缺少用例重组时的原始用例步骤，尚未核对自动化用例' }]);
  assert.equal(printed.briefs.length, 1);
  assert.equal(printed.briefs[0].state, '未知');
  assert.deepEqual(printed.to_audit, [printed.briefs[0].brief]);
  const expanded = await w.planOf();
  assert.doesNotMatch(JSON.stringify(expanded), /\{\{name:40\}\}/, 'the plan file was expanded and written back');
  const current = fidelityBrief('doc-1:c-1', RECORD, expanded.slots.plan[0].data)!;
  assert.equal(printed.briefs[0].brief, briefFile(w.briefs, '00', current.brief_sha256), 'named by the digest');
  assert.match(printed.briefs[0].verdict, /\/00\.[0-9a-f]{8}\.verdict\.json$/);
  const written = JSON.parse(await readFile(printed.briefs[0].brief, 'utf8'));
  assert.deepEqual(written, current);
  assert.equal(written.literal_lengths.length, 1); assert.equal(written.literal_lengths[0].length, 40);
  assert.equal(printed.briefs[0].brief_sha256, written.brief_sha256);
});

test('one brief directory lasts across repairs and nothing in it is overwritten: an unchanged plan keeps its verdict, a changed plan gets a new brief', async () => {
  const w = await workspace();
  const first = JSON.parse((await w.runBrief()).stdout).briefs[0];
  await writeFile(first.verdict, JSON.stringify(VERDICT));
  const again = JSON.parse((await w.runBrief()).stdout);
  assert.equal(again.briefs[0].state, '未确认'); assert.deepEqual(again.to_audit, []);
  const plan = await w.planOf(); plan.slots.plan[0].data.steps[1].args = ['echo 192.0.2.91'];
  await writeFile(join(w.plans, '00.json'), JSON.stringify(plan));
  const changed = JSON.parse((await w.runBrief()).stdout);
  assert.equal(changed.briefs[0].state, '未知'); assert.deepEqual(changed.to_audit, [changed.briefs[0].brief]);
  assert.notEqual(changed.briefs[0].brief, first.brief, 'another plan, another brief file');
  const names = (await readdir(w.briefs)).sort();
  assert.equal(names.filter((name) => name.endsWith('.brief.json')).length, 2, 'the earlier brief stays as it was');
  assert.equal(names.filter((name) => name.endsWith('.verdict.json')).length, 1, 'the earlier verdict stays under its own name');
  assert.equal(JSON.parse((await w.runApply()).stdout).attention[0].state, '未知', 'and is not merged into the changed plan');
});

test('a verdict is merged only for the plan it answered, with the digest the tool writes; what the Hub would return is said before submitting', async () => {
  const w = await workspace();
  const before = JSON.parse((await w.runApply()).stdout);
  assert.deepEqual([before.ready, before.attention[0].state], [false, '未知'], 'no brief yet');
  await w.runBrief();
  assert.equal(JSON.parse((await w.runApply()).stdout).attention[0].state, '未知');
  await writeFile(await w.verdictPath(), JSON.stringify({ ...VERDICT, brief_sha256: 'f'.repeat(64) }));
  assert.equal(JSON.parse((await w.runApply()).stdout).attention[0].state, '未知', 'the auditor writes two items; the digest is the tool’s');
  await writeFile(await w.verdictPath(), JSON.stringify({ ...VERDICT, steps: [] }));
  assert.equal(JSON.parse((await w.runApply()).stdout).attention[0].state, '未知');
  assert.equal((await w.planOf()).slots.plan[0].data.fidelity, undefined, 'nothing merged so far');

  await writeFile(await w.verdictPath(), JSON.stringify(VERDICT));
  const done = JSON.parse((await w.runApply()).stdout);
  assert.deepEqual([done.ready, done.merged, done.attention], [true, [{ file: '00.json', preserved: 1, changed: 0, unrealized: 0 }], []]);
  const plan = await w.planOf(), data = plan.slots.plan[0].data, { fidelity, ...rest } = data;
  const current = fidelityBrief('doc-1:c-1', RECORD, rest)!;
  assert.equal(fidelity.brief_sha256, current.brief_sha256);
  assert.deepEqual(fidelityProblems(current, fidelity).problems, [], 'what the Hub checks passes');
  assert.equal(JSON.parse((await w.runBrief()).stdout).briefs[0].state, '未确认', 'the merged verdict is not part of the brief');

  data.steps[1].args = ['echo 192.0.2.92']; await writeFile(join(w.plans, '00.json'), JSON.stringify(plan));
  assert.equal(JSON.parse((await w.runApply()).stdout).attention[0].state, '未知');
  await w.runBrief();
  await writeFile(await w.verdictPath(), JSON.stringify({ steps: [{ ...VERDICT.steps[0], verdict: 'changed' }], disclosure: VERDICT.disclosure }));
  const returned = JSON.parse((await w.runApply()).stdout);
  assert.deepEqual([returned.ready, returned.merged[0].changed, returned.attention[0].state], [false, 1, '未确认']);
  assert.match(returned.attention[0].message, /审计判作者步骤 a2 的场景被改了.*判断错误，原因编写模型的问题，下一步由编写模型修改这条自动化用例，再交给独立模型核对/);
  assert.equal((await w.planOf()).slots.plan[0].data.fidelity.steps[0].verdict, 'changed', 'the verdict is merged as the auditor gave it');
});

test('fidelityBrief populates added_precondition exemptions from sources.states, plan.precondition_source, and block_context.preconditions while hiding worker prose', () => {
  const recWithStates = {
    ...RECORD,
    sources: {
      governing: [],
      candidates: [],
      states: [
        { atom: 'a2', state: 'missing_prerequisite', reason: '手册要求本端与对端均需先配置 peer', prerequisites: ['配置 dut0 widget peer', '配置 dut0 widget challenge'] },
        { atom: 'a3', state: 'settled', reason: '已确定', prerequisites: [] },
      ],
    },
  };
  const plan = structuredClone(goodData());
  (plan.steps[0] as unknown as Record<string, unknown>).description = '编写自述：不应出现在 brief 中';
  (plan.steps[0] as unknown as Record<string, unknown>).precondition_source = { reference: 'knowledge:manual#widget-peer-ex1', text: 'Example: configure peer and challenge on the local and the peer device' };
  const briefSourced = fidelityBrief('doc-1:c-1', recWithStates, plan)!;
  assert.equal(briefSourced.mechanical.exemptions.length, 2);
  assert.equal(briefSourced.mechanical.exemptions[0]!.kind, 'added_precondition');
  assert.equal(briefSourced.mechanical.exemptions[0]!.origin, 'record.sources.states');
  assert.deepEqual(briefSourced.mechanical.exemptions[0]!.prerequisites, ['配置 dut0 widget peer', '配置 dut0 widget challenge']);
  assert.equal(briefSourced.mechanical.exemptions[1]!.kind, 'added_precondition');
  assert.equal(briefSourced.mechanical.exemptions[1]!.origin, 'plan.precondition_source');
  assert.deepEqual(briefSourced.mechanical.exemptions[1]!.step_indices, [1]);
  assert.equal(briefSourced.mechanical.exemptions[1]!.reference, 'knowledge:manual#widget-peer-ex1');
  assert.ok(briefSourced.mechanical.note.includes('mechanical.exemptions 列出了 2 条前置步骤豁免依据'));
  assert.ok(briefSourced.rules.some((r) => r.includes('added_precondition') && r.includes('recomposition.adapted 不是步骤白名单') && r.includes('前置不存在')));
  assert.equal(JSON.stringify(briefSourced.blocks).includes('编写自述'), false, 'step.description never leaks to fidelity audit');

  const blockPlanData = {
    bucket: 'bed-1',
    blocks: [
      { id: 'prep_peer', kind: 'CONFIG', call: { object: 'dut0', method: 'cmd_config', args: ['widget peer 192.0.2.2'], keywords: {} }, description: '隐藏描述' },
      { id: 'main_step', kind: 'CONFIG', call: { object: 'dut1', method: 'cmd_config', args: ['widget peer 192.0.2.1'], keywords: {} } },
    ],
    steps: [],
    expects: [],
    replacements: [],
    block_context: {
      preconditions: [
        { id: 'p1', state: 'present', for: 'main_step', established_by: ['prep_peer'], quote: { reference: 'knowledge:manual#widget-peer', text: 'Both peers must declare widget peer' } },
        { id: 'p2', state: 'absent', for: 'main_step', established_by: [], quote: { reference: 'knowledge:manual#missing', text: 'ignored when absent' } },
      ],
      causal_links: [],
      responders: [],
    },
  };
  const briefBlocks = fidelityBrief('doc-1:c-1', RECORD, blockPlanData)!;
  assert.equal(briefBlocks.mechanical.exemptions.length, 1);
  assert.equal(briefBlocks.mechanical.exemptions[0]!.origin, 'block_context.preconditions');
  assert.deepEqual(briefBlocks.mechanical.exemptions[0]!.step_indices, [1]);
  assert.deepEqual(briefBlocks.mechanical.exemptions[0]!.established_by, ['prep_peer']);

  const unsourcedPlan = structuredClone(goodData());
  (unsourcedPlan.steps[0] as unknown as Record<string, unknown>).description = '擅自添加但自称前置';
  const briefUnsourced = fidelityBrief('doc-1:c-1', RECORD, unsourcedPlan)!;
  assert.deepEqual(briefUnsourced.mechanical.exemptions, []);
  assert.ok(briefUnsourced.mechanical.note.includes('mechanical.exemptions 为空'));
  assert.equal(JSON.stringify(briefUnsourced).includes('擅自添加但自称前置'), false);
});

test('fidelity CLI missing arguments are declared parameter failures', async () => {
  for (const entry of [brief, apply]) {
    const reply = await quiet(() => entry([]));
    assert.equal(reply.code, 1);
    assert.match(reply.stderr, /^参数无效：/);
    assert.match(reply.stderr, /请/);
  }
});

test('Bug #17 & #18: handling=skipped is skipped by fidelity-brief, and standalone verdict + model_disclosure merge cleanly in fidelity-apply', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-fidelity-bugs-'));
  try {
    const plans = join(dir, 'plans'), briefs = join(dir, 'briefs');
    await mkdir(plans);
    await writeFile(join(dir, 'run.json'), JSON.stringify({
      run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa',
      items: [
        { id: 'doc-1:c-1', fields: { recomposition: { record: RECORD } } },
        { id: 'doc-1:c-skip', fields: { recomposition: { record: RECORD } } },
      ],
    }));
    await writeFile(join(plans, '00.json'), JSON.stringify({ item: 'doc-1:c-1', handling: 'handled', slots: { plan: [{ data: goodData() }] } }));
    await writeFile(join(plans, '01.json'), JSON.stringify({ item: 'doc-1:c-skip', handling: 'skipped', reason: '前置暂不具备' }));

    const briefRes = await quiet(() => brief(['--run', dir, '--plans', plans, '--out', briefs]));
    assert.equal(briefRes.code, 0, briefRes.stderr);
    const briefJson = JSON.parse(briefRes.stdout);
    assert.equal(briefJson.briefs.length, 1);
    assert.deepEqual(briefJson.skipped, [{ file: '01.json', reason: '模型声明跳过，理由尚未因此核验为真' }]);

    const sha = briefJson.briefs[0].brief_sha256;
    await writeFile(briefJson.briefs[0].verdict, JSON.stringify({
      steps: [{
        ...VERDICT.steps[0],
        model_judgment: {
          status: '未确认',
          decided_by: '模型',
          model_version: 'plumb-27b-0.5.0',
          task: 'sequence',
          choice: '保持',
          confidence: 0.91,
          gate: { action: 'pass' },
        },
      }],
      disclosure: VERDICT.disclosure,
      model_disclosure: {
        status: '未确认',
        decided_by: '模型',
        model_version: 'plumb-27b-0.5.0',
        review_required_steps: [],
      },
    }));
    const applyRes = await quiet(() => apply(['--run', dir, '--plans', plans, '--briefs', briefs]));
    assert.equal(applyRes.code, 0, applyRes.stderr);
    const applyJson = JSON.parse(applyRes.stdout);
    assert.equal(applyJson.ready, true);
    assert.deepEqual(applyJson.merged, [{ file: '00.json', preserved: 1, changed: 0, unrealized: 0 }]);

    const mergedPlan = JSON.parse(await readFile(join(plans, '00.json'), 'utf8'));
    assert.equal(mergedPlan.slots.plan[0].data.fidelity.brief_sha256, sha);
    assert.equal(mergedPlan.slots.plan[0].data.fidelity.model_disclosure.model_version, 'plumb-27b-0.5.0');
    assert.equal(mergedPlan.slots.plan[0].data.fidelity.steps[0].model_judgment.choice, '保持');
  } finally {
    await import('node:fs/promises').then((m) => m.rm(dir, { recursive: true, force: true }));
  }
});
