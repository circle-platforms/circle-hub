import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import REQUIREMENTS from '../requirements.json' with { type: 'json' };
import { canonicalJson } from '../functions/canonical-json.ts';
import { GENERATOR, type GenerationInput } from '../functions/generate.ts';
import { readWorkbook } from '../functions/workbook.ts';
import { assemble, deliveryReport, type ReportInput } from '../functions/delivery.ts';
import { sha256 } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { MANIFEST_DOC } from '../functions/test-support.ts';
import { coreModel } from '../testing/workbook-model.ts';
import { AUTOIDS, BOOT, ROOT, contractDoc, profileDoc, recipe } from '../testing/channels.ts';

const [A, B, C] = AUTOIDS;
const SHOW = 'show pool', STORE = 'demo store file backup', BOOT_ON = 'demo mirror boot on', RELOAD = 'demo reload file backup';
const PLAN_RUN = 'run_00000000000000000000000000';

function planRunFiles(recipes: GenerationInput[]) {
  const contract = Buffer.from(JSON.stringify(contractDoc)), profile = Buffer.from(JSON.stringify(profileDoc)), inventory = Buffer.from(JSON.stringify(MANIFEST_DOC));
  const ids = recipes.map((_, k) => `case-${k + 1}`);
  const submission = { run: PLAN_RUN, model: 'synthetic-model', items: recipes.map((input, k) => ({ item: ids[k], handling: 'handled', slots: { plan: [{ data: input.slots }] } })) };
  const run = { run: PLAN_RUN, pack: 'case-compile', pack_digest: 'b'.repeat(64), root: ROOT, build: 'Fixture_Build_A', items: recipes.map((input, k) => ({ id: ids[k], fields: input.fields })), requirements: REQUIREMENTS.requirements.map((v) => ({ key: v.key, accepted_producer: v.accepted_producer })), sources: Object.entries({ contract, profile, inventory }).map(([slot, bytes]) => ({ slot, role: 'expected', reference: `src:${sha256(bytes)}` })) };
  const result = { schema: 'validation@1', run: PLAN_RUN, submission: sha256(canonicalJson(submission)), acceptance: 'accepted', errors: [], locks: { pack: GENERATOR, pack_digest: run.pack_digest, root: ROOT }, coverage: { complete: true, examined: recipes.length, total: recipes.length }, partitions: { delivered: recipes.map((input, k) => ({ item: ids[k], requirements: REQUIREMENTS.requirements.map((v) => ({ requirement: v.key, status: v.key === 'workbook_verified' ? 'unresolved' : 'satisfied', claims: v.key === 'commands_known' ? [{ statement: { verdict: 'support', data: { command_catalog: input.fields.command_catalog } } }] : v.key === 'contract_methods' ? [{ statement: { verdict: 'support', data: { runtime_version: input.contract.runtimeVersion, contract_sha256: input.contract.pinned.identity } } }] : [] })) })) } };
  return { run, submission, result, contract, profile, inventory };
}
function generate(recipes: GenerationInput[], withManifest = false) {
  const dir = mkdtempSync(join(tmpdir(), 'volume-order-'));
  try {
    const args: string[] = [];
    for (const [key, value] of Object.entries(planRunFiles(recipes))) { const path = join(dir, `${key}.json`); writeFileSync(path, value instanceof Uint8Array ? value : JSON.stringify(value)); args.push(`--${key}`, key === 'run' ? dir : path); }
    if (withManifest) {
      mkdirSync(join(dir, 'sources'));
      const input = planRunFiles(recipes), manifest: unknown[] = [];
      for (const [index, slot] of (['contract', 'profile', 'inventory'] as const).entries()) {
        const file = `sources/source-${index}.bin`;
        writeFileSync(join(dir, file), input[slot]);
        manifest.push({ slot, file, reference: `src:${sha256(input[slot])}` });
        const at = args.indexOf('--' + slot); args.splice(at, 2);
      }
      writeFileSync(join(dir, 'sources.json'), JSON.stringify(manifest));
    }
    const out = join(dir, 'case.xlsx');
    const done = spawnSync(process.execPath, ['packs/workflow/case-compile/tools/generate-workbook.ts', ...args, '--out', out], { encoding: 'utf8' });
    return { status: done.status, stdout: done.stdout, stderr: done.stderr, written: existsSync(out), bytes: existsSync(out) ? readFileSync(out) : null };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('the client generator writes the cases that leave state behind last and names them', () => {
  const recipes = [recipe(A, [STORE]), recipe(B, [SHOW]), recipe(C, [SHOW])];
  const done = generate(recipes);
  assert.equal(done.status, 0, done.stderr);
  const printed = JSON.parse(done.stdout);
  assert.equal(printed.generator, GENERATOR);
  assert.deepEqual(printed.moved_tail.map((row: { autoid: string; channels: Array<{ id: string }> }) => [row.autoid, row.channels.map((channel) => channel.id)]), [[A, ['disk']]]);
  assert.match(printed.moved_text, new RegExp(`原始用例 ${A} 合成用例 41 的命令会留下用例结束后仍未清除的配置，已在自动化用例 Excel 中排到最后。决定者程序。$`));
  const read = readWorkbook(coreModel(done.bytes!), recipes);
  assert.ok(read.ok, JSON.stringify(read)); if (read.ok) assert.deepEqual(read.autoids, [B, C, A]);
  const plain = generate([recipe(B, [SHOW]), recipe(C, [SHOW])]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.deepEqual(Object.keys(JSON.parse(plain.stdout)).sort(), ['bytes', 'generator', 'sha256']);
});

test('the client generator refuses a volume with both sides of a forbidden combination and writes nothing', () => {
  const done = generate([recipe(A, [BOOT_ON]), recipe(B, [SHOW]), recipe(C, [RELOAD])]);
  assert.equal(done.status, 1);
  assert.equal(done.written, false);
  assert.equal(done.stdout, '');
  for (const part of ['参数无效：同一份自动化用例 Excel 中有产品文档声明不能一起使用的命令', A, C, BOOT_ON, RELOAD, '未生成自动化用例 Excel', '请使用者决定是否修改原始用例']) assert.ok(done.stderr.includes(part), part);
  assert.ok(!done.stderr.includes(B), 'a case on neither side is not named');
});

test('the delivery report declares the cases placed last in each volume', () => {
  const dispatch = { run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', job: 'a'.repeat(64), plan_run: PLAN_RUN, sha256: 'c'.repeat(64), items: [A, B], rows: [{ item: A, dynamic_terminal: 'pass' }, { item: B, dynamic_terminal: 'pass' }] };
  const assembly = assemble([A, B], [dispatch]);
  const input: ReportInput = { name: '合成交付', generatedAt: '2026-11-11 12:00', build: 'Fixture_Build_A', assembly, notes: { cases: {} }, originals: { [A]: { title: '合成用例一', lines: [] }, [B]: { title: '合成用例二', lines: [] } }, excluded: [], files: { pass: { sha256: 'c'.repeat(64) }, unsuccessful: null }, logs: {} };
  assert.ok(!deliveryReport(input).includes('排到最后'), 'nothing is said when no case was placed last');
  const moved = [{ autoid: A, channels: [{ id: 'disk', source: 'x', commands: [STORE] }] }];
  const report = deliveryReport({ ...input, placedLast: { pass: moved, unsuccessful: [] } });
  assert.ok(report.includes(`原始用例 ${A} 合成用例一 的命令会留下用例结束后仍未清除的配置，已在自动化用例 Excel 中排到最后。`), report);
  assert.ok(!report.includes('未通过卷'));
});

test('the generator isolates skipped cases while keeping current submission identity mandatory', async () => {
  const { satisfiedRecipes } = await import('./generate-workbook.ts');
  const input = planRunFiles([recipe(A, [SHOW]), recipe(B, [SHOW])]);
  (input.submission.items[1] as unknown as { handling: string }).handling = 'skipped';
  input.result.submission = sha256(canonicalJson(input.submission));
  (input.result.errors as unknown[]).push({ item: 'case-2', requirement: 'plan_present', code: 'missing_input' });
  assert.deepEqual(satisfiedRecipes(input).map(row => row.fields.autoid), [A]);
  input.submission.items[0].slots.plan[0].data = recipe(A, [STORE]).slots;
  assert.throws(() => satisfiedRecipes(input), /原始资料与核对结果不一致/);
});


test('the generator reads downloaded source pointers rather than assumed slot filenames', () => {
  const done = generate([recipe(B, [SHOW])], true);
  assert.equal(done.status, 0, done.stderr);
  assert.ok(done.written);
});
