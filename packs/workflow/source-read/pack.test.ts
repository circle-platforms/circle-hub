// Pack file integrity, schema compliance and publication checks for source-read.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ChecksFile, PackManifest, PublishableRequirementsFile, RequirementsFile, SlotsFile, WorkflowFile } from '../../../contracts/src/pack.ts';
import { readPackDirectory, runPublishCheck, validatePack } from '../../../hub/runs/api.ts';
import { osIsolationAvailable } from '../../../hub/rules/api.ts';
import { PACK_DIR, computeManifest, manifestText, packFiles, stage } from './pack-files.ts';

const json = (path: string): unknown => JSON.parse(readFileSync(join(PACK_DIR, path), 'utf8'));
const text = (path: string): string => readFileSync(join(PACK_DIR, path), 'utf8');
const temporary: string[] = [];
after(async () => {
  for (const dir of temporary) await rm(dir, { recursive: true, force: true });
});

describe('the source-read pack files', () => {
  it('pack.json lists exactly the pack files with their digests', async () => {
    assert.equal(text('pack.json'), manifestText(await computeManifest()));
    const manifest = PackManifest.parse(json('pack.json'));
    assert.deepEqual([manifest.id, manifest.version, manifest.kind], ['source-read', '0.1.2', 'workflow']);
    const files = await packFiles();
    assert.ok(files.includes('workflow.json') && files.includes('requirements.json') && files.includes('checks.json') && files.includes('slots.schema.json') && files.includes('SKILL.md') && files.includes('functions/project.ts'));
    assert.ok(!files.some((f) => f.endsWith('.test.ts') || f === 'README.md' || f === 'pack-files.ts' || f === 'api.ts'));
  });

  it('declares 7 optional system read routes, unbound product catalogs, and zero requirements', () => {
    const workflow = WorkflowFile.parse(json('workflow.json'));
    assert.equal(workflow.schema, 'workflow@1');
    assert.deepEqual(workflow.product, { catalogs: [] });
    assert.equal(workflow.subject, 'defect');
    assert.deepEqual(workflow.projection, { module: 'functions/project.ts' });
    assert.equal(workflow.inputs.length, 7);
    for (const input of workflow.inputs) {
      assert.equal(input.required, false, `slot ${input.slot} must be optional`);
      assert.equal(input.role, 'subject');
    }
    const slots = workflow.inputs.map((i) => i.slot);
    assert.deepEqual(slots, ['defect', 'story', 'build', 'mindmap', 'build_page', 'manual_file', 'svn_file']);

    const requirements = RequirementsFile.parse(json('requirements.json'));
    assert.equal(requirements.schema, 'requirements@1');
    assert.deepEqual(requirements.requirements, []);

    const publishable = PublishableRequirementsFile.parse(json('requirements.json'));
    assert.deepEqual(publishable.requirements, []);

    const checks = ChecksFile.parse(json('checks.json'));
    assert.deepEqual(checks.checks, []);

    const slotsSchema = SlotsFile.parse(json('slots.schema.json'));
    assert.deepEqual(slotsSchema.schema, 'slots@1');
  });
});

describe('the staged source-read pack', { skip: (await osIsolationAvailable()) ? false : 'no OS network isolation on this machine (sandbox-exec)' }, () => {
  it('passes the validation and publish check of the pack registry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'source-read-'));
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
    assert.deepEqual([report.samples.total, report.samples.passed, report.samples.failed], [0, 0, 0]);
    assert.deepEqual(report.checks, []);
  });
});
