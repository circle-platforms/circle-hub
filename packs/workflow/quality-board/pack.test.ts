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
    assert.deepEqual([manifest.id, manifest.version, manifest.kind], ['quality-board', '2.0.11', 'workflow']);
    const files = await packFiles();
    assert.ok(files.includes('functions/board.ts') && files.includes('samples/negative/thresholds-exceeded.json'));
    assert.ok(!files.some((f) => f.endsWith('.test.ts') || f === 'functions/test-support.ts' || f === 'README.md' || f === 'pack-files.ts'));
    assert.ok(!files.some((f) => f.startsWith('examples/') || f.startsWith('testing/')), files.join(', '));
  });

  it('binds no product line (the view names product and build), reads the one facet view and declares the three fact requirements', () => {
    const workflow = WorkflowFile.parse(json('workflow.json'));
    assert.deepEqual(workflow.inputs.map((i) => ({ ...i, description: undefined })), [
      { slot: 'facets', role: 'subject', description: undefined, accepts: ['knowledge:facets'], required: true, many: true },
      { slot: 'placement', role: 'hint', description: undefined, accepts: ['knowledge:facets'], required: true, many: false },
      // 含糊率只认已受理评审。cases 和 reviews 是后来加上的可选输入，没有它们时全部未判断。
      { slot: 'cases', role: 'subject', description: undefined, accepts: ['knowledge:index'], required: false, many: false },
      { slot: 'reviews', role: 'artifact_under_verification', description: undefined, accepts: ['application/json'], required: false, many: true },
    ]);
    assert.deepEqual(workflow.product, { catalogs: [] });
    assert.deepEqual(
      workflow.parameters.map((p) => [p.name, p.required]),
      [
        ['max_missing_ratio', false],
        ['max_vague_ratio', false],
        ['min_negative_ratio', false],
      ],
    );
    assert.deepEqual([workflow.subject, workflow.projection, workflow.expected_sources], ['facets', { module: 'functions/project.ts' }, undefined]);
    const requirements = RequirementsFile.parse(json('requirements.json')).requirements;
    assert.deepEqual(
      requirements.map((r) => ({ ...r, name: undefined, description: undefined })),
      [
        { key: 'board', name: undefined, description: undefined, target: 'item', required: true, done_rule: 'bookkeeping', layers: ['static'], accepted_producer: 'fact', checks: ['board'], error_handling: [] },
        { key: 'thresholds', name: undefined, description: undefined, target: 'item', required: true, done_rule: 'bookkeeping', layers: ['static'], accepted_producer: 'fact', checks: ['thresholds'], error_handling: [] },
        { key: 'totals', name: undefined, description: undefined, target: 'run', required: true, done_rule: 'bookkeeping', layers: ['static'], accepted_producer: 'fact', checks: ['totals'], error_handling: [] },
      ],
    );
    const checks = ChecksFile.parse(json('checks.json')).checks;
    assert.deepEqual(
      checks.map((c) => ({ ...c, title: undefined })),
      [
        // 三条检查核的是已受理评审主张，不是主题本身；basis 写明含糊语义不能升成事实。
        { id: 'board', title: undefined, function: { module: 'functions/board.ts' }, applies: 'run', subject: { module: 'functions/subject.ts' }, judges: 'artifact_under_verification', tier: 'advisory', basis: 'R3：对受理评审主张做算术聚合，所有结论以判断为前提；不把含糊语义升级为事实' },
        { id: 'thresholds', title: undefined, function: { module: 'functions/thresholds.ts' }, applies: 'run', subject: { module: 'functions/subject.ts' }, judges: 'artifact_under_verification', tier: 'advisory', basis: 'R3：对受理评审主张做算术聚合，所有结论以判断为前提；不把含糊语义升级为事实' },
        { id: 'totals', title: undefined, function: { module: 'functions/totals.ts' }, applies: 'run', subject: { module: 'functions/subject.ts' }, judges: 'artifact_under_verification', tier: 'advisory', basis: 'R3：对受理评审主张做算术聚合，所有结论以判断为前提；不把含糊语义升级为事实' },
      ],
    );
    assert.deepEqual(SlotsFile.parse(json('slots.schema.json')), { schema: 'slots@1', item: {}, run: {} });
    assert.ok(/\p{Script=Han}/u.test(text('SKILL.md')) && text('SKILL.md').length < 3400, 'a short Chinese procedure (it is in every start_run answer)');
  });

  it('declares parameter schemas the engine can enforce (no regular expressions, zod reads them)', () => {
    const workflow = WorkflowFile.parse(json('workflow.json'));
    for (const p of workflow.parameters) {
      assert.ok(p.schema !== undefined, p.name);
      assert.ok(!JSON.stringify(p.schema).includes('"pattern'), p.name);
      const schema = z.fromJSONSchema(p.schema as Parameters<typeof z.fromJSONSchema>[0]);
      assert.ok(schema.safeParse(0.05).success && schema.safeParse(0).success && schema.safeParse(1).success, `${p.name} accepts ratios`);
      assert.ok(!schema.safeParse(2).success && !schema.safeParse(-0.1).success && !schema.safeParse('0.05').success, `${p.name} refuses non-ratios`);
    }
  });

  it('has positive and negative samples of all three checks, with the shapes of the publish check', () => {
    const samples = PackManifest.parse(json('pack.json'))
      .files.map((f) => f.path)
      .filter((p) => p.startsWith('samples/'))
      .map((path) => ({ path, sample: PackSample.parse(json(path)) }));
    for (const check of ['board', 'thresholds', 'totals']) {
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
    const codes = json('tables/codes.json') as { violations: Array<{ code: string }>; refusals: Array<{ code: string }>; warnings: Array<{ code: string }>; checks: Array<{ code: string }> };
    // undeclared_tag 写在 checks 段，和 template-gap、case-review 一样，不在 violations 里。
    const declared = new Set([...codes.violations, ...codes.refusals, ...codes.warnings, ...codes.checks].map((c) => c.code));
    const used = new Set<string>();
    const sources = ['functions/project.ts', 'functions/views.ts', 'functions/board.ts', 'functions/thresholds.ts', 'functions/totals.ts'].map(text).join('\n');
    for (const m of sources.matchAll(/refusal\('([a-z_]+)'/g)) used.add(`quality-board.${m[1]}`);
    for (const m of sources.matchAll(/failure\('([a-z_]+)'/g)) used.add(`quality-board.${m[1]}`);
    for (const m of sources.matchAll(/\$\{PACK\}\.([a-z_]+)/g)) used.add(`quality-board.${m[1]}`);
    for (const m of sources.matchAll(/'(quality-board\.[a-z_]+)'/g)) used.add(m[1]);
    assert.ok(used.size >= 10, [...used].join(', '));
    for (const code of used) assert.ok(declared.has(code), `${code} is not in tables/codes.json`);
  });
});

describe('the staged pack', { skip: (await osIsolationAvailable()) ? false : 'no OS network isolation on this machine (sandbox-exec)' }, () => {
  it('passes the validation and the publish check of the pack registry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quality-board-'));
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
        ['board', 'advisory', 1, 1, ['author_samples_only']],
        ['thresholds', 'advisory', 1, 1, ['author_samples_only']],
        ['totals', 'advisory', 1, 1, ['author_samples_only']],
      ],
    );
  });
});
