// The pack as files: pack.json lists exactly the pack's files, every declaration has its contract shape, the parameter
// schema is one the engine enforces, the codes the functions give are declared, and the staged pack passes the
// registry's validation and publish check (offline; publish.test.ts publishes it for real).
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
    assert.deepEqual([manifest.id, manifest.version, manifest.kind], ['maintenance-sweep', '1.8.9', 'workflow']);
    const files = await packFiles();
    assert.ok(files.includes('functions/sweep.ts') && files.includes('functions/diff.ts') && files.includes('samples/negative/command-removed.json') && files.includes('examples/sweep.json'));
    assert.ok(!files.some((f) => f.endsWith('.test.ts') || f === 'functions/test-support.ts' || f === 'README.md' || f === 'pack-files.ts'));
  });

  it('binds no product line and declares the two fact requirements', () => {
    const workflow = WorkflowFile.parse(json('workflow.json'));
    assert.deepEqual(workflow.inputs.map((input) => [input.slot, input.role, input.accepts, input.required, input.many]), [['impact', 'subject', ['knowledge:impact'], true, false], ['behaviour', 'hint', ['knowledge:impact'], false, false], ['facets', 'hint', ['knowledge:facets'], true, false]]);
    assert.equal(Object.hasOwn(workflow.product, 'id'), false);
    assert.deepEqual(workflow.product, { catalogs: [] });
    assert.deepEqual(
      workflow.parameters.map((p) => [p.name, p.required]),
      [['ignore_fields', false]],
    );
    assert.deepEqual([workflow.subject, workflow.projection], ['impact', { module: 'functions/project.ts' }]);
    const requirements = RequirementsFile.parse(json('requirements.json')).requirements;
    assert.deepEqual(
      requirements.map((r) => ({ key: r.key, target: r.target, required: r.required, done_rule: r.done_rule, layers: r.layers, accepted_producer: r.accepted_producer, checks: r.checks, error_handling: r.error_handling })),
      [
        { key: 'command_exists', target: 'item', required: true, done_rule: 'bookkeeping', layers: ['static'], accepted_producer: 'fact', checks: ['command_exists'], error_handling: [] },
        { key: 'command_unchanged', target: 'item', required: true, done_rule: 'bookkeeping', layers: ['static'], accepted_producer: 'fact', checks: ['command_unchanged'], error_handling: [] },
      ],
    );
    const checks = ChecksFile.parse(json('checks.json')).checks;
    assert.equal(checks[0].tier, 'blocking');
    assert.match(checks[0].basis ?? '', /C05 R\[1\]/);
    assert.equal(checks[1].tier, 'advisory');
    assert.equal(checks[1].basis, undefined);
    assert.deepEqual(SlotsFile.parse(json('slots.schema.json')), { schema: 'slots@1', item: {}, run: {} });
    assert.ok(/\p{Script=Han}/u.test(text('SKILL.md')) && text('SKILL.md').length < 3600);
    assert.match(text('SKILL.md'), /阻断/);
    assert.match(text('SKILL.md'), /提示/);
  });

  it('declares a parameter schema the engine can enforce (no regular expressions, zod reads it)', () => {
    const workflow = WorkflowFile.parse(json('workflow.json'));
    const p = workflow.parameters[0];
    assert.ok(p.schema !== undefined);
    assert.ok(!JSON.stringify(p.schema).includes('"pattern'));
    const schema = z.fromJSONSchema(p.schema as Parameters<typeof z.fromJSONSchema>[0]);
    assert.equal(schema.safeParse(['help']).success, true);
    assert.equal(schema.safeParse([]).success, true);
    assert.equal(schema.safeParse(['']).success, false);
    assert.equal(schema.safeParse([1]).success, false);
  });

  it('has a positive and a negative sample of each check', () => {
    const files = readFileSync(join(PACK_DIR, 'pack.json'), 'utf8');
    const samples = PackManifest.parse(JSON.parse(files)).files
      .map((f) => f.path)
      .filter((p) => p.startsWith('samples/'))
      .map((path) => ({ path, sample: PackSample.parse(json(path)) }));
    for (const check of ['command_exists', 'command_unchanged']) {
      assert.ok(samples.some((s) => s.path.startsWith('samples/positive/') && s.sample.check === check), check);
      assert.ok(samples.some((s) => s.path.startsWith('samples/negative/') && s.sample.check === check), check);
    }
    for (const { path, sample } of samples) {
      if (path.startsWith('samples/positive/')) assert.ok(sample.expect.every((e) => e.verdict === 'support'), path);
      else assert.ok(sample.expect.some((e) => e.verdict === 'refute'), path);
    }
  });

  it('declares every code the functions give', () => {
    const codes = json('tables/codes.json') as { violations: Array<{ code: string }>; refusals: Array<{ code: string }>; warnings: Array<{ code: string }> };
    const declared = new Set([...codes.violations, ...codes.refusals, ...codes.warnings].map((c) => c.code));
    const sources = ['functions/project.ts', 'functions/sweep.ts', 'functions/check.ts'].map(text).join('\n');
    const used = new Set<string>();
    for (const m of sources.matchAll(/refusal\('([a-z0-9_]+)'/g)) used.add(`maintenance-sweep.${m[1]}`);
    for (const m of sources.matchAll(/\$\{PACK\}\.([a-z0-9_.]+)/g)) used.add(`maintenance-sweep.${m[1]}`);
    for (const m of sources.matchAll(/\$\{PACK\}\.case\.([a-z0-9_]+)/g)) used.add(`maintenance-sweep.case.${m[1]}`);
    assert.ok(used.size >= 10, [...used].join(', '));
    for (const code of used) assert.ok(declared.has(code), `${code} is not in tables/codes.json`);
    assert.ok(declared.has('maintenance-sweep.case.command_removed'));
    assert.ok(declared.has('maintenance-sweep.case.command_changed'));
  });

  it('marks the published example as synthetic', () => {
    const example = json('examples/sweep.json') as { synthetic: boolean; note: string; removed: { tier: string }; changed: { tier: string } };
    assert.equal(example.synthetic, true);
    assert.match(example.note, /合成/);
    assert.deepEqual([example.removed.tier, example.changed.tier], ['blocking', 'advisory']);
  });
});

describe('the staged pack', { skip: (await osIsolationAvailable()) ? false : 'no OS network isolation on this machine (sandbox-exec)' }, () => {
  it('passes the validation and the publish check of the pack registry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maintenance-sweep-'));
    temporary.push(dir);
    await stage(dir);
    const read = await readPackDirectory(dir);
    assert.ok(read.ok, read.ok ? '' : JSON.stringify(read.problems, null, 1));
    const validation = await validatePack(read.pack);
    assert.ok(validation.ok, validation.ok ? '' : JSON.stringify(validation.problems, null, 1));
    const report = await runPublishCheck({ pack: validation.pack, packDir: dir });
    assert.deepEqual(report.failures, [], JSON.stringify(report.failures, null, 1));
    assert.deepEqual(report.unsampled, []);
    assert.deepEqual([report.samples.total, report.samples.passed, report.samples.failed], [4, 4, 0]);
    assert.deepEqual(
      report.checks.map((c) => [c.check, c.tier, c.positive, c.negative, c.marks]),
      [
        ['command_exists', 'blocking', 1, 1, ['author_samples_only']],
        ['command_unchanged', 'advisory', 1, 1, ['author_samples_only']],
      ],
    );
  });
});

import { test } from 'node:test';
test('unplaced followup is bounded and never demands enumeration to the facet total', () => {
  assert.match(text('SKILL.md'), /最多展示一页/); assert.match(text('SKILL.md'), /下一页引用或游标/); assert.ok(!text('SKILL.md').includes('列出的去重数量必须与披露计数一致'));
});

test('skill distinguishes exact unplaced counts from skipped-source lower bounds',()=>{
 const skill=text('SKILL.md').split('6. 客户端必须')[1]!;
 assert.match(skill,/truncated=false 且 skipped=0/);assert.match(skill,/skipped>0/);assert.match(skill,/至少 N 个用例没有解析出命令/);assert.match(skill,/另有 K 份来源未读，其中的用例不知道/);assert.match(skill,/N=0 也不能/);assert.match(skill,/重新生产根/);assert.match(skill,/自动重读/);
});
