// The brief tool on synthetic files only: placeholders are expanded first, as submit-plans does, so the brief the audit answers
// is the one the Hub recomputes from the submitted plan; a case without authored actions is skipped.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fidelityBrief } from '../functions/fidelity.ts';
import { goodData } from '../functions/test-support.ts';
import { main } from './fidelity-brief.ts';

const RECORD = { schema: 'recompose-record@1', contract: { intent: { text: '合成意图' } }, atoms: [{ id: 'a1', kind: 'intent', text: '合成意图' }, { id: 'a2', kind: 'action', text: '配置合成名字' }], ledgers: { original: [{ atom: 'a2', text: '配置合成名字' }], adapted: [], concretizations: [], rebindings: [] } };

async function quiet(run: () => Promise<number>) {
  const out: string[] = [], err: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout), stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { err.push(String(c)); return true; }) as typeof process.stderr.write;
  try { return { code: await run(), stdout: out.join(''), stderr: err.join('') }; } finally { process.stdout.write = stdout; process.stderr.write = stderr; }
}

test('the brief is computed from the expanded plan the Hub will receive, one file per case with authored actions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-fidelity-')); const plans = join(dir, 'plans'); await mkdir(plans);
  const run = { run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', items: [{ id: 'doc-1:c-1', fields: { recomposition: { record: RECORD } } }, { id: 'doc-1:c-2', fields: {} }] };
  await writeFile(join(dir, 'run.json'), JSON.stringify(run));
  const data = goodData() as unknown as Record<string, unknown>; (data.steps as Array<Record<string, unknown>>)[0].args = ['widget name {{name:12}}'];
  await writeFile(join(plans, '00.json'), JSON.stringify({ item: 'doc-1:c-1', handling: 'handled', slots: { plan: [{ data }] } }));
  await writeFile(join(plans, '01.json'), JSON.stringify({ item: 'doc-1:c-2', handling: 'handled', slots: { plan: [{ data: goodData() }] } }));
  const { code, stdout, stderr } = await quiet(() => main(['--run', join(dir, 'run.json'), '--plans', plans, '--out', join(dir, 'briefs')]));
  assert.equal(code, 0, stderr);
  const printed = JSON.parse(stdout);
  assert.deepEqual(printed.skipped, [{ file: '01.json', reason: '没有重组记录里的作者动作原句，不用审计' }]);
  assert.equal(printed.briefs.length, 1);
  const expanded = JSON.parse(await readFile(join(plans, '00.json'), 'utf8'));
  assert.doesNotMatch(JSON.stringify(expanded), /\{\{name:12\}\}/, 'the plan file was expanded and written back');
  const brief = JSON.parse(await readFile(join(dir, 'briefs', '00.brief.json'), 'utf8'));
  assert.deepEqual(brief, fidelityBrief('doc-1:c-1', RECORD, expanded.slots.plan[0].data)!);
  assert.equal(printed.briefs[0].brief_sha256, brief.brief_sha256);
  assert.equal((await quiet(() => main(['--run', join(dir, 'run.json'), '--plans', plans, '--out', join(dir, 'briefs')]))).code, 1, 'never overwrites');
});
