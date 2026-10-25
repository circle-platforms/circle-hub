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
  const run = { run: recipe.plan_run, pack: 'case-compile', pack_digest: 'b'.repeat(64), root:(recipe.fields.command_catalog as {root:string}).root, build: recipe.build, items: [{ id, fields: recipe.fields }], requirements: REQUIREMENTS.requirements.map((v) => ({ key: v.key, accepted_producer: v.accepted_producer })), sources: Object.entries({ contract, profile, inventory }).map(([slot, bytes]) => ({ slot, role: 'expected', reference: `src:${sha256(bytes)}` })) };
  const result = { schema: 'validation@1', run: run.run, submission: sha256(canonicalJson(submission)), acceptance: 'accepted', errors: [], locks: { pack: GENERATOR, pack_digest: run.pack_digest, root: run.root }, coverage: { complete: true, examined: 1, total: 1 }, partitions: { delivered: [{ item: id, requirements: REQUIREMENTS.requirements.map((v) => ({ requirement: v.key, status: v.key === 'workbook_verified' ? 'unresolved' : 'satisfied', claims: v.key==='commands_known'?[{statement:{verdict:'support',data:{command_catalog:recipe.fields.command_catalog}}}]:v.key === 'contract_methods' ? [{ statement: { verdict: 'support', data: { runtime_version: recipe.contract.runtimeVersion, contract_sha256: recipe.contract.pinned.identity } } }] : [] })) }] } };
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
    const out = join(dir, 'artifact.xlsx'); const result = spawnSync(process.execPath, ['packs/workflow/case-compile/tools/generate-workbook.ts', ...args, '--out', out], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); const printed = JSON.parse(result.stdout); assert.equal(printed.generator, GENERATOR); assert.equal(printed.sha256, sha256(readFileSync(out))); assert.deepEqual(readFileSync(out), Buffer.from(generateWorkbook(generationFixture()))); assert.ok(!result.stdout.includes(dir));
    const again = spawnSync(process.execPath, ['packs/workflow/case-compile/tools/generate-workbook.ts', ...args, '--out', out], { encoding: 'utf8' }); assert.equal(again.status, 1); assert.ok(!again.stderr.includes(dir)); assert.equal(sha256(readFileSync(out)), printed.sha256);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('normalizer CLI reports both digests and a client-normalization disclosure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mindmap-cli-')); try {
    const source = join(dir, 'source.json'); const out = join(dir, 'neutral.json'); writeFileSync(source, '\uffff\uffff[{"data":{},"children":[]}]');
    const result = spawnSync(process.execPath, ['packs/workflow/case-compile/tools/normalize-mindmap.ts', '--in', source, '--out', out], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); const data = JSON.parse(result.stdout); assert.equal(data.before_sha256, sha256(readFileSync(source))); assert.equal(data.after_sha256, sha256(readFileSync(out))); assert.match(data.note, /客户端规整/); assert.ok(!result.stdout.includes(dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('staging publishes identical client bytes under tools and the staged entry remains executable', async () => {
  const { stage } = await import('../pack-files.ts'); const dir = mkdtempSync(join(tmpdir(), 'staged-workbook-cli-'));
  try {
    const root = await stage(join(dir, 'pack')); const manifest = JSON.parse(readFileSync(join(root, 'pack.json'), 'utf8'));
    for (const name of ['files.ts', 'normalize-mindmap.ts', 'generate-workbook.ts']) { const entry = manifest.files.find((v: { path: string }) => v.path === `tools/${name}`); assert.ok(entry); assert.equal(entry.sha256, sha256(readFileSync(join(root, 'tools', name)))); assert.equal(entry.sha256, sha256(readFileSync(`packs/workflow/case-compile/tools/${name}`))); }
    const f = fixture(); const args: string[] = [];
    for (const [key, value] of Object.entries(f)) { const path = join(dir, `${key}.json`); writeFileSync(path, value instanceof Uint8Array ? value : JSON.stringify(value)); args.push(`--${key}`, path); }
    const result = spawnSync(process.execPath, [join(root, 'tools/generate-workbook.ts'), ...args, '--out', join(dir, 'artifact.xlsx')], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).generator, GENERATOR);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the client generator permits only the explicit pre-generation workbook gap',()=>{
  const value=fixture();const result:any=value.result;
  result.errors=[{code:'missing_input',message:'生成前尚未绑定工作簿',requirement:'workbook_verified',item:'fixture-case'}];
  const workbook=result.partitions.delivered[0].requirements.find((r:any)=>r.requirement==='workbook_verified');
  workbook.status='pending';workbook.layers=[{layer:'static',terminal:'unchecked',reason:'missing_input'}];
  assert.equal(satisfiedRecipe(value).plan_run,value.run.run);
  for(const error of [
    {code:'check_error',requirement:'workbook_verified',item:'fixture-case'},
    {code:'case-compile.workbook_invalid',requirement:'workbook_verified',item:'fixture-case'},
    {code:'missing_input',requirement:'commands_known',item:'fixture-case'},
    {code:'missing_input',requirement:'workbook_verified',item:'other-case'},
  ]){
    result.errors=[error];assert.throws(()=>satisfiedRecipe(value));
  }
  result.errors=[{code:'missing_input',requirement:'workbook_verified',item:'fixture-case'}];
  workbook.layers=[{layer:'static',terminal:'violation',code:'case-compile.workbook_invalid'}];
  assert.throws(()=>satisfiedRecipe(value),'a known workbook refutation never becomes a generation gap');
});
