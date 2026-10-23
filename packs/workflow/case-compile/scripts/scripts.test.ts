import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeMindmap } from './normalize-mindmap.ts';
import { satisfiedRecipe } from './generate-workbook.ts';
import { sha256 } from './files.ts';
import { canonicalJson } from '../functions/canonical-json.ts';
import { GENERATOR, generateWorkbook } from '../functions/generate.ts';
import { CONTRACT_DOC, PROFILE_DOC, MANIFEST_DOC } from '../functions/test-support.ts';
import { generationFixture } from '../testing/workbook.ts';
import REQUIREMENTS from '../requirements.json' with { type: 'json' };
function fixture() {
  const recipe = generationFixture(); const id = 'fixture-case';
  const contract = Buffer.from(JSON.stringify(CONTRACT_DOC)); const profile = Buffer.from(JSON.stringify(PROFILE_DOC)); const inventory = Buffer.from(JSON.stringify(MANIFEST_DOC));
  const submission = { run: recipe.plan_run, model: 'synthetic-model', items: [{ item: id, handling: 'handled', slots: { plan: [{ data: recipe.slots }] } }] };
  const run = { run: recipe.plan_run, pack: 'case-compile', pack_digest: 'b'.repeat(64), root: 'c'.repeat(64), build: recipe.build, items: [{ id, fields: recipe.fields }], requirements: REQUIREMENTS.requirements, sources: Object.entries({ contract, profile, inventory }).map(([slot, bytes]) => ({ slot, role: 'expected', reference: `src:${sha256(bytes)}` })) };
  const result = { schema: 'validation@1', run: run.run, submission: sha256(canonicalJson(submission)), acceptance: 'accepted', errors: [], locks: { pack: GENERATOR, pack_digest: run.pack_digest, root: run.root }, coverage: { complete: true, examined: 1, total: 1 }, partitions: { delivered: [{ item: id, requirements: REQUIREMENTS.requirements.map((v) => ({ requirement: v.key, status: v.key === 'workbook_verified' ? 'unresolved' : 'satisfied', claims: v.key === 'contract_methods' ? [{ statement: { verdict: 'support', data: { runtime_version: recipe.contract.runtimeVersion, contract_sha256: recipe.contract.digest } } }] : [] })) }] } };
  return { run, submission, result, contract, profile, inventory };
}
test('normalization changes only declared wrappers and never rounds long numeric spelling', () => {
  const original = Buffer.from('\uffff\uffff[{"data":{"id":"fixture","autoid":990000000000000031},"children":[]}]');
  const result = normalizeMindmap(original); assert.equal(result.transformations.length, 2); assert.ok(Buffer.from(result.bytes).toString().includes('990000000000000031')); assert.equal(result.before_sha256, sha256(original)); assert.notEqual(result.before_sha256, result.after_sha256);
  const normal = Buffer.from('{ "root": {"data":{},"children":[]} }\n'); assert.deepEqual(normalizeMindmap(normal).bytes, normal);
  for (const raw of ['[]', '[{},{}]', '\uffff{}', '{"root":null}']) assert.throws(() => normalizeMindmap(Buffer.from(raw)));
});
test('local recipe comes from the exact accepted submission and bound bytes', () => {
  const value = fixture(); const recipe = satisfiedRecipe(value); assert.equal(recipe.plan_run, value.run.run); assert.deepEqual(recipe.slots, generationFixture().slots);
  assert.deepEqual(generateWorkbook(recipe), generateWorkbook(generationFixture()));
});
for (const [name, mutate] of Object.entries({
  stale: (v: any) => { v.submission.items[0].slots.plan[0].data.steps[0].args[0] += 'x'; }, unsatisfied: (v: any) => { v.result.partitions.delivered[0].requirements[0].status = 'unresolved'; }, identity: (v: any) => { v.contract = Buffer.from('{}'); }, version: (v: any) => { v.result.locks.pack = 'case-compile@0.0.0'; }, missing: (v: any) => { v.run.requirements = []; }, coverage: (v: any) => { v.result.coverage.complete = false; },
})) test(`local recipe refuses ${name} without fabricating satisfaction`, () => { const value = fixture(); mutate(value); assert.throws(() => satisfiedRecipe(value)); });
test('client CLI imports the same generator, writes only a new file and prints digest metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workbook-cli-')); try {
    const f = fixture(); const args: string[] = [];
    for (const [key, value] of Object.entries(f)) { const path = join(dir, `${key}.json`); writeFileSync(path, value instanceof Uint8Array ? value : JSON.stringify(value)); args.push(`--${key}`, path); }
    const out = join(dir, 'artifact.xlsx'); const result = spawnSync(process.execPath, ['packs/workflow/case-compile/scripts/generate-workbook.ts', ...args, '--out', out], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); const printed = JSON.parse(result.stdout); assert.equal(printed.generator, GENERATOR); assert.equal(printed.sha256, sha256(readFileSync(out))); assert.deepEqual(readFileSync(out), Buffer.from(generateWorkbook(generationFixture()))); assert.ok(!result.stdout.includes(dir));
    const again = spawnSync(process.execPath, ['packs/workflow/case-compile/scripts/generate-workbook.ts', ...args, '--out', out], { encoding: 'utf8' }); assert.equal(again.status, 1); assert.ok(!again.stderr.includes(dir)); assert.equal(sha256(readFileSync(out)), printed.sha256);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('normalizer CLI reports both digests and a client-normalization disclosure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mindmap-cli-')); try {
    const source = join(dir, 'source.json'); const out = join(dir, 'neutral.json'); writeFileSync(source, '\uffff\uffff[{"data":{},"children":[]}]');
    const result = spawnSync(process.execPath, ['packs/workflow/case-compile/scripts/normalize-mindmap.ts', '--in', source, '--out', out], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); const data = JSON.parse(result.stdout); assert.equal(data.before_sha256, sha256(readFileSync(source))); assert.equal(data.after_sha256, sha256(readFileSync(out))); assert.match(data.note, /客户端规整/); assert.ok(!result.stdout.includes(dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
