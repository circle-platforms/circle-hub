// The pack as files: pack.json lists exactly the pack's files, every declaration has its contract shape, the parameter
// schemas are ones the engine enforces, the codes the functions give are declared, the samples have both polarities per
// check, and the staged pack passes the registry's validation and publish check (offline; publish.test.ts publishes it
// for real).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { z } from 'zod';
import { ChecksFile, PackManifest, PackSample, RequirementsFile, SlotsFile, WorkflowFile } from '../../../contracts/src/pack.ts';
import { readPackDirectory, runPublishCheck, validatePack } from '../../../hub/runs/api.ts';
import { osIsolationAvailable } from '../../../hub/rules/api.ts';
import { PACK_DIR, computeManifest, manifestText, packFiles, stage } from './pack-files.ts';

const json = (path: string): unknown => JSON.parse(readFileSync(join(PACK_DIR, path), 'utf8'));
const text = (path: string): string => readFileSync(join(PACK_DIR, path), 'utf8');
const temporary: string[] = [];
after(async () => {
  for (const dir of temporary) await rm(dir, { recursive: true, force: true });
});

describe('the pack files', () => {
  it('pack.json lists exactly the pack files with their digests (run pack-files.ts --write after a change)', async () => {
    assert.equal(text('pack.json'), manifestText(await computeManifest()));
    const manifest = PackManifest.parse(json('pack.json'));
    assert.deepEqual([manifest.id, manifest.version, manifest.kind], ['traceability', '1.0.11', 'workflow']);
    const files = await packFiles();
    assert.ok(files.includes('functions/matrix.ts') && files.includes('samples/negative/status-conflict.json'));
    assert.ok(!files.some((f) => f.endsWith('.test.ts') || f === 'functions/test-support.ts' || f === 'README.md' || f === 'pack-files.ts'));
    // No examples are published until a verified run supplies them (T01 F[11]); the fixtures stay in testing/.
    assert.ok(!files.some((f) => f.startsWith('examples/') || f.startsWith('testing/')), files.join(', '));
  });

  it('binds no product line (the views name product and build), reads the two index views and declares the two fact requirements', () => {
    const workflow = WorkflowFile.parse(json('workflow.json'));
    assert.deepEqual(
      workflow.inputs.map((i) => ({ ...i, description: undefined })),
      [
        { slot: 'defects', role: 'subject', description: undefined, accepts: ['knowledge:index'], required: true, many: false },
        { slot: 'cases', role: 'expected', description: undefined, accepts: ['knowledge:index'], required: true, many: false, index_default: {only_from: {source: 'build_defects'}, fields: ['document', 'node', 'title', 'system', 'case', 'defects']} },
      ],
    );
    assert.deepEqual(workflow.product, { catalogs: [] });
    assert.deepEqual(
      workflow.parameters.map((p) => [p.name, p.required]),
      [['statuses', false]],
    );
    assert.deepEqual([workflow.subject, workflow.projection, workflow.expected_sources], ['defects', { module: 'functions/project.ts' }, { module: 'functions/expected.ts' }]);
    const requirements = RequirementsFile.parse(json('requirements.json')).requirements;
    assert.deepEqual(
      requirements.map((r) => ({ ...r, name: undefined, description: undefined })),
      [
        { key: 'traced', name: undefined, description: undefined, target: 'item', required: true, done_rule: 'bookkeeping', layers: ['static'], accepted_producer: 'fact', checks: ['traced'], error_handling: [] },
        { key: 'counts', name: undefined, description: undefined, target: 'run', required: true, done_rule: 'bookkeeping', layers: ['static'], accepted_producer: 'fact', checks: ['counts'], error_handling: [] },
      ],
    );
    const checks = ChecksFile.parse(json('checks.json')).checks;
    assert.deepEqual(
      checks.map((c) => ({ ...c, title: undefined })),
      [
        { id: 'traced', title: undefined, function: { module: 'functions/check.ts' }, table: 'tables/closed-statuses.json', reads: { roles: ['expected'], types: ['plm:bugs'] }, applies: 'run', subject: { module: 'functions/subject.ts' }, judges: 'subject', tier: 'advisory' },
        { id: 'counts', title: undefined, function: { module: 'functions/counts.ts' }, table: 'tables/closed-statuses.json', reads: { roles: ['expected'], types: ['plm:bugs'] }, applies: 'run', subject: { module: 'functions/subject.ts' }, judges: 'subject', tier: 'advisory' },
      ],
    );
    assert.deepEqual(SlotsFile.parse(json('slots.schema.json')), { schema: 'slots@1', item: {}, run: {} });
    // 1.0.11 的规程写明了精确指针，长于旧的 2000 字试探上限，仍是 start_run 交给模型的中文全文。
    assert.ok(/\p{Script=Han}/u.test(text('SKILL.md')) && text('SKILL.md').length < 2500, 'a short Chinese procedure (it is in every start_run answer)');
  });

  it('declares a parameter schema the engine can enforce (no regular expressions, zod reads it)', () => {
    const workflow = WorkflowFile.parse(json('workflow.json'));
    for (const p of workflow.parameters) {
      assert.ok(p.schema !== undefined, p.name);
      assert.ok(!JSON.stringify(p.schema).includes('"pattern'), p.name);
      const schema = z.fromJSONSchema(p.schema as Parameters<typeof z.fromJSONSchema>[0]);
      assert.ok(schema.safeParse(['fixed', 'known']).success, `${p.name} accepts the default set`);
      assert.ok(schema.safeParse(['known']).success, `${p.name} accepts one status`);
      for (const bad of [[], ['fixed', 'fixed'], ['fixed', 'open'], 'fixed']) assert.ok(!schema.safeParse(bad).success, `${p.name} refuses ${JSON.stringify(bad)}`);
    }
  });

  it('has positive and negative samples of both checks, with the shapes of the publish check', () => {
    const samples = PackManifest.parse(json('pack.json'))
      .files.map((f) => f.path)
      .filter((p) => p.startsWith('samples/'))
      .map((path) => ({ path, sample: PackSample.parse(json(path)) }));
    for (const check of ['traced', 'counts']) {
      const own = samples.filter((s) => s.sample.check === check);
      assert.ok(own.some((s) => s.path.startsWith('samples/positive/')), `${check}: a positive sample`);
      assert.ok(own.some((s) => s.path.startsWith('samples/negative/')), `${check}: a negative sample`);
    }
    for (const { path, sample } of samples) {
      if (path.startsWith('samples/positive/')) assert.ok(sample.expect.every((e) => e.verdict === 'support'), path);
      else assert.ok(sample.expect.some((e) => e.verdict === 'refute'), path);
    }
  });

  it('declares every code the functions give', () => {
    const codes = json('tables/codes.json') as { violations: Array<{ code: string }>; refusals: Array<{ code: string }>; warnings: Array<{ code: string }> };
    const declared = new Set([...codes.violations, ...codes.refusals, ...codes.warnings].map((c) => c.code));
    const used = new Set<string>();
    const sources = ['functions/project.ts', 'functions/views.ts', 'functions/check.ts', 'functions/counts.ts'].map(text).join('\n');
    for (const m of sources.matchAll(/refusal\('([a-z_]+)'/g)) used.add(`traceability.${m[1]}`);
    for (const m of sources.matchAll(/failure\('([a-z_]+)'/g)) used.add(`traceability.${m[1]}`);
    for (const m of sources.matchAll(/\$\{PACK\}\.([a-z_]+)/g)) used.add(`traceability.${m[1]}`);
    for (const m of sources.matchAll(/'(traceability\.[a-z_]+)'/g)) used.add(m[1]);
    assert.ok(used.size >= 10, [...used].join(', '));
    for (const code of used) assert.ok(declared.has(code), `${code} is not in tables/codes.json`);
  });
});

describe('the staged pack', { skip: (await osIsolationAvailable()) ? false : 'no OS network isolation on this machine (sandbox-exec)' }, () => {
  it('passes the validation and the publish check of the pack registry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traceability-'));
    temporary.push(dir);
    await stage(dir);
    const read = await readPackDirectory(dir);
    assert.ok(read.ok, read.ok ? '' : JSON.stringify(read.problems, null, 1));
    const validation = await validatePack(read.pack);
    assert.ok(validation.ok, validation.ok ? '' : JSON.stringify(validation.problems, null, 1));
    assert.deepEqual(validation.pack.warnings.map((w) => w.rule), []);
    const report = await runPublishCheck({ pack: validation.pack, packDir: dir });
    assert.deepEqual(report.failures, [], JSON.stringify(report.failures, null, 1));
    assert.deepEqual(report.unsampled, []);
    assert.deepEqual([report.samples.total, report.samples.passed, report.samples.failed], [6, 6, 0]);
    assert.deepEqual(
      report.checks.map((c) => [c.check, c.tier, c.positive, c.negative, c.marks]),
      [
        ['traced', 'advisory', 1, 3, ['author_samples_only']],
        ['counts', 'advisory', 1, 1, ['author_samples_only']],
      ],
    );
  });
});
