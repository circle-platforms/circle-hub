// The pack as files: pack.json lists exactly the pack's files, every declaration has its contract shape, the parameter
// schemas are ones the engine enforces, the codes the functions give are declared, the examples agree with the scheme, and
// the staged pack passes the registry's validation and publish check (offline; publish.test.ts publishes it for real).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { IDENTITY } from './pack-files.ts';
import { z } from 'zod';
import { ChecksFile, PackManifest, PackSample, RequirementsFile, SlotsFile, WorkflowFile } from '../../../contracts/src/pack.ts';
import { readPackDirectory, runPublishCheck, validatePack } from '../../../hub/runs/api.ts';
import { osIsolationAvailable } from '../../../hub/rules/api.ts';
import { LABELS } from './functions/convention.ts';
import { locateItem, summaryOf } from './functions/locate.ts';
import type { LocateInput } from './functions/types.ts';
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
    assert.deepEqual([manifest.id, manifest.version, manifest.kind], ['case-location', IDENTITY.version, 'workflow'], 'the manifest carries the declared identity; the version is not written down twice');
    const files = await packFiles();
    assert.ok(files.includes('functions/locate.ts') && files.includes('samples/negative/declared-line-conflict.json'));
    assert.ok(!files.some((f) => f.endsWith('.test.ts') || f === 'functions/test-support.ts' || f === 'README.md' || f === 'pack-files.ts'));
    // No examples are published until a verified run supplies them (T01 F[11]); the synthetic ones are test fixtures.
    assert.ok(!files.some((f) => f.startsWith('examples/') || f.startsWith('testing/')), files.join(', '));
  });

  it('binds one product line, asks for its builds, and declares the location fact and the build candidates check', () => {
    const workflow = WorkflowFile.parse(json('workflow.json'));
    assert.deepEqual(workflow.inputs, [
      { slot: 'documents', role: 'subject', description: workflow.inputs[0].description, accepts: ['agile:mindmap'], required: true, many: true },
    ]);
    // One workflow binds one product line (W03 R[5]): the conventions in functions/ are this line's.
    assert.deepEqual(workflow.product, { id: 'famx', catalogs: [] });
    assert.deepEqual(
      workflow.parameters.map((p) => [p.name, p.required]),
      [
        ['product', false],
        ['line', false],
        ['granularity', false],
        ['id_ranges', false],
      ],
    );
    assert.deepEqual(workflow.context, ['builds'], 'the workflow asks for the builds of the bound product (K01 R[10])');
    assert.deepEqual([workflow.subject, workflow.projection, workflow.expected_sources], ['documents', { module: 'functions/project.ts' }, { module: 'functions/expected.ts' }]);
    const requirements = RequirementsFile.parse(json('requirements.json')).requirements;
    assert.deepEqual(
      requirements.map((r) => ({ ...r, name: undefined, description: undefined })),
      [
        { key: 'location', name: undefined, description: undefined, target: 'item', required: true, done_rule: 'bookkeeping', layers: ['static'], accepted_producer: 'fact', checks: ['locate'], error_handling: [] },
        { key: 'build_candidates', name: undefined, description: undefined, target: 'item', required: true, done_rule: 'bookkeeping', layers: ['static'], accepted_producer: 'fact', checks: ['candidates'], error_handling: [] },
      ],
    );
    assert.match(requirements[1].description, /知识库/);
    const checks = ChecksFile.parse(json('checks.json')).checks;
    assert.deepEqual(checks, [
      { id: 'locate', title: '按目录树定位', function: { module: 'functions/check.ts' }, applies: 'run', subject: { module: 'functions/subject.ts' }, judges: 'subject', tier: 'advisory' },
      { id: 'candidates', title: '构建候选与写出名核对', function: { module: 'functions/candidates.ts' }, applies: 'run', subject: { module: 'functions/subject.ts' }, judges: 'subject', tier: 'advisory' },
    ]);
    assert.deepEqual(SlotsFile.parse(json('slots.schema.json')), { schema: 'slots@1', item: {}, run: {} });
    assert.ok(/\p{Script=Han}/u.test(text('SKILL.md')) && text('SKILL.md').length < 2000, 'a short Chinese procedure (it is in every start_run answer)');
  });

  it('declares parameter schemas the engine can enforce (no regular expressions, zod reads them)', () => {
    const workflow = WorkflowFile.parse(json('workflow.json'));
    for (const p of workflow.parameters) {
      assert.ok(p.schema !== undefined, p.name);
      assert.ok(!JSON.stringify(p.schema).includes('"pattern'), p.name);
      const schema = z.fromJSONSchema(p.schema as Parameters<typeof z.fromJSONSchema>[0]);
      const good = { product: 'FAMY', line: '10.6.1', granularity: 'case', id_ranges: { story: { max: 49999 }, bug: { min: 50000 } } }[p.name];
      const bad = { product: '', line: 7, granularity: 'every', id_ranges: { story: { min: -1 } } }[p.name];
      assert.ok(schema.safeParse(good).success, `${p.name} accepts ${JSON.stringify(good)}`);
      assert.ok(!schema.safeParse(bad).success, `${p.name} refuses ${JSON.stringify(bad)}`);
    }
  });

  it('has positive and negative samples of the locate check, with the shapes of the publish check', () => {
    const files = readFileSync(join(PACK_DIR, 'pack.json'), 'utf8');
    const samples = (PackManifest.parse(JSON.parse(files)).files.map((f) => f.path).filter((p) => p.startsWith('samples/'))).map((path) => ({ path, sample: PackSample.parse(json(path)) }));
    assert.ok(samples.some((s) => s.path.startsWith('samples/positive/')) && samples.some((s) => s.path.startsWith('samples/negative/')));
    for (const { path, sample } of samples) {
      assert.ok(['locate', 'candidates'].includes(sample.check), path);
      if (path.startsWith('samples/positive/')) assert.ok(sample.expect.every((e) => e.verdict === 'support'), path);
      else assert.ok(sample.expect.some((e) => e.verdict === 'refute'), path);
    }
    for (const check of ['locate', 'candidates']) {
      const own = samples.filter((s) => s.sample.check === check);
      assert.ok(own.some((s) => s.path.startsWith('samples/positive/')) && own.some((s) => s.path.startsWith('samples/negative/')), `${check}: both polarities`);
    }
  });

  it('declares every code the functions give and the labels they show', () => {
    const codes = json('tables/codes.json') as {
      violations: Array<{ code: string }>;
      refusals: Array<{ code: string }>;
      warnings: Array<{ code: string }>;
      version_source: Array<{ code: string; label: string }>;
      confidence: Array<{ code: string; label: string }>;
    };
    const declared = new Set([...codes.violations, ...codes.refusals, ...codes.warnings].map((c) => c.code));
    const sources = ['functions/project.ts', 'functions/expected.ts', 'functions/convention.ts', 'functions/check.ts', 'functions/candidates.ts', 'functions/locate.ts'].map(text).join('\n');
    const used = new Set<string>();
    for (const m of sources.matchAll(/refusal\('([a-z_]+)'/g)) used.add(`case-location.${m[1]}`);
    for (const m of sources.matchAll(/\$\{PACK\}\.([a-z_]+)/g)) used.add(`case-location.${m[1]}`);
    assert.ok(used.size >= 12, [...used].join(', '));
    for (const code of used) assert.ok(declared.has(code), `${code} is not in tables/codes.json`);
    assert.deepEqual(Object.fromEntries(codes.version_source.map((v) => [v.code, v.label])), LABELS.version_source);
    assert.deepEqual(Object.fromEntries(codes.confidence.map((v) => [v.code, v.label])), LABELS.confidence);
  });

  it('answers the hand-written synthetic examples (test fixtures, not pack files) as they state', () => {
    const examples = json('testing/examples.json') as { examples: Array<{ id: string; input: LocateInput; verdict: string; summary: string; answer: Record<string, unknown> }> };
    assert.ok(examples.examples.length >= 4);
    assert.deepEqual([...new Set(examples.examples.map((e) => e.verdict))].sort(), ['refute', 'support', 'unknown']);
    for (const e of examples.examples) {
      const { answer, judgment } = locateItem(e.input);
      // Every field the example states, written by hand from the rules; the notes are explanations and not stated.
      const { notes: _notes, ...stated } = answer;
      assert.deepEqual(stated, e.answer, e.id);
      assert.deepEqual([judgment.verdict, summaryOf(answer, judgment)], [e.verdict, e.summary], e.id);
    }
  });
});

describe('the staged pack', { skip: (await osIsolationAvailable()) ? false : 'no OS network isolation on this machine (sandbox-exec)' }, () => {
  it('passes the validation and the publish check of the pack registry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'case-location-'));
    temporary.push(dir);
    await stage(dir);
    const read = await readPackDirectory(dir);
    assert.ok(read.ok, read.ok ? '' : JSON.stringify(read.problems, null, 1));
    const validation = await validatePack(read.pack);
    assert.ok(validation.ok, validation.ok ? '' : JSON.stringify(validation.problems, null, 1));
    assert.deepEqual(
      validation.pack.warnings.map((w) => w.rule),
      [],
    );
    const report = await runPublishCheck({ pack: validation.pack, packDir: dir });
    assert.deepEqual(report.failures, [], JSON.stringify(report.failures, null, 1));
    assert.deepEqual(report.unsampled, []);
    assert.deepEqual([report.samples.total, report.samples.passed, report.samples.failed], [9, 9, 0]);
    assert.deepEqual(
      report.checks.map((c) => [c.check, c.tier, c.positive, c.negative, c.marks]),
      [
        ['locate', 'advisory', 2, 4, ['author_samples_only']],
        ['candidates', 'advisory', 2, 1, ['author_samples_only']],
      ],
    );
  });
});
