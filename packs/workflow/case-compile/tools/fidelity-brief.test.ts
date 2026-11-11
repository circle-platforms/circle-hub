// The brief and merge tools on synthetic files only: placeholders are expanded first, as submit-plans does, so the brief the
// audit answers is the one the Hub recomputes; one brief directory lasts across repairs; a verdict is merged only for the plan
// it answered, with the digest written by the tool.
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
/** A plan directory of two cases (one with authored actions, one without) beside its run.json. */
async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'cc-fidelity-')); const plans = join(dir, 'plans'), briefs = join(dir, 'briefs'); await mkdir(plans);
  await writeFile(join(dir, 'run.json'), JSON.stringify({ run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', items: [{ id: 'doc-1:c-1', fields: { recomposition: { record: RECORD } } }, { id: 'doc-1:c-2', fields: {} }] }));
  const data = goodData() as unknown as Record<string, unknown>; (data.steps as Array<Record<string, unknown>>)[0].args = ['widget name {{name:40}}'];
  await writeFile(join(plans, '00.json'), JSON.stringify({ item: 'doc-1:c-1', handling: 'handled', slots: { plan: [{ data }] } }));
  await writeFile(join(plans, '01.json'), JSON.stringify({ item: 'doc-1:c-2', handling: 'handled', slots: { plan: [{ data: goodData() }] } }));
  const runBrief = () => quiet(() => brief(['--run', join(dir, 'run.json'), '--plans', plans, '--out', briefs]));
  const runApply = () => quiet(() => apply(['--run', join(dir, 'run.json'), '--plans', plans, '--briefs', briefs]));
  const planOf = async () => JSON.parse(await readFile(join(plans, '00.json'), 'utf8'));
  /** Where the auditor of the plan as it stands writes its verdict: beside the brief, named by the brief's digest. */
  const verdictPath = async () => { const { fidelity: _f, ...rest } = (await planOf()).slots.plan[0].data; return verdictFile(briefs, '00', fidelityBrief('doc-1:c-1', RECORD, rest)!.brief_sha256); };
  return { dir, plans, briefs, runBrief, runApply, planOf, verdictPath };
}
const VERDICT = { steps: [{ n: 'a2', verdict: 'preserved', step_indices: [1], rationale: '合成理由：第 1 步配置了名字' }], disclosure: '合成说明：作者的一步由第 1 步实现。' };

test('the brief is computed from the expanded plan the Hub will receive, with the literal measured, one file per case with authored actions', async () => {
  const w = await workspace();
  const { code, stdout, stderr } = await w.runBrief();
  assert.equal(code, 0, stderr);
  const printed = JSON.parse(stdout);
  assert.deepEqual(printed.skipped, [{ file: '01.json', reason: '没有重组记录里的作者动作原句，不用审计' }]);
  assert.equal(printed.briefs.length, 1);
  assert.equal(printed.briefs[0].state, '需要审计');
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
  assert.equal(changed.briefs[0].state, '需要审计'); assert.deepEqual(changed.to_audit, [changed.briefs[0].brief]);
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

  // The plan is edited after the audit: the old verdict is not merged again, and a changed verdict is reported, not hidden.
  data.steps[1].args = ['echo 192.0.2.92']; await writeFile(join(w.plans, '00.json'), JSON.stringify(plan));
  assert.equal(JSON.parse((await w.runApply()).stdout).attention[0].state, '未知');
  await w.runBrief();
  await writeFile(await w.verdictPath(), JSON.stringify({ steps: [{ ...VERDICT.steps[0], verdict: 'changed' }], disclosure: VERDICT.disclosure }));
  const returned = JSON.parse((await w.runApply()).stdout);
  assert.deepEqual([returned.ready, returned.merged[0].changed, returned.attention[0].state], [false, 1, '审计判这条计划要改']);
  assert.match(returned.attention[0].message, /审计判作者步骤 a2 的场景被改了.*判断错误，原因编写模型的问题，下一步由编写模型修改这条自动化用例，再交给独立模型核对/);
  assert.equal((await w.planOf()).slots.plan[0].data.fidelity.steps[0].verdict, 'changed', 'the verdict is merged as the auditor gave it');
});
