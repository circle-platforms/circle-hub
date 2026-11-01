// The bed-install pack as files: pack.json lists exactly the pack's files, every declaration has its contract shape, the
// effect row releases on both requirements, the samples cover both checks in both polarities, and the staged pack passes
// the registry's validation and publish check (offline; publish.test.ts publishes it for real).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
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
    assert.deepEqual([manifest.id, manifest.version, manifest.kind], ['bed-install', '1.0.0', 'workflow']);
    const files = await packFiles();
    assert.ok(files.includes('functions/install.ts') && files.includes('policies/install.json') && files.includes('samples/negative/install-booking-missing.json'));
    assert.ok(!files.some((f) => f.endsWith('.test.ts') || f === 'README.md' || f === 'pack-files.ts'));
  });

  it('reads the inventory and an uploaded request, binds no catalog, sees the bed/ lease rows, and dispatches on both requirements', () => {
    const workflow = WorkflowFile.parse(json('workflow.json'));
    assert.deepEqual(workflow.inputs.map((input) => [input.slot, input.role, input.accepts, input.required]), [
      ['inventory', 'subject', ['doc:doc'], true],
      ['request', 'artifact_under_verification', ['application/json'], true],
    ]);
    assert.deepEqual([workflow.product, workflow.context, workflow.leases, workflow.subject], [{ catalogs: [] }, ['leases'], { prefix: 'bed/' }, 'inventory']);
    assert.deepEqual(workflow.parameters.map((p) => [p.name, p.required]), [['bed', true]]);
    const file = RequirementsFile.parse(json('requirements.json'));
    assert.deepEqual(file.requirements.map((r) => [r.key, r.accepted_producer, r.checks]), [['reason', 'judgment', []], ['install', 'fact', ['install', 'dispatch_policy']]]);
    assert.deepEqual(file.effects?.map((row) => [row.id, row.trigger, row.release, row.parameters, row.budget.count]), [
      ['install_build', 'hub_template', { requirements: ['reason', 'install'], artifact: 'install' }, { policy: 'policies/install.json', check: 'dispatch_policy' }, 1],
    ]);
    const checks = ChecksFile.parse(json('checks.json')).checks;
    assert.deepEqual(checks.map((c) => [c.id, c.applies, c.judges, c.tier, c.table]), [
      ['install', 'item', 'artifact_under_verification', 'blocking', 'policies/install.json'],
      ['dispatch_policy', 'item', 'artifact_under_verification', 'blocking', 'policies/install.json'],
    ]);
    assert.deepEqual(Object.keys(SlotsFile.parse(json('slots.schema.json')).item), ['reason']);
    assert.ok(/\p{Script=Han}/u.test(text('SKILL.md')) && text('SKILL.md').includes('未排除本地操作'));
  });

  it('has positive and negative samples of both checks that the checks reproduce', async () => {
    const { default: install } = await import('./functions/install.ts');
    const { default: dispatchPolicy } = await import('./functions/dispatch-policy.ts');
    const table = json('policies/install.json');
    const samples = PackManifest.parse(json('pack.json')).files.map((f) => f.path).filter((p) => p.startsWith('samples/')).map((path) => ({ path, sample: PackSample.parse(json(path)) }));
    for (const check of ['install', 'dispatch_policy']) {
      const own = samples.filter((s) => s.sample.check === check);
      assert.ok(own.some((s) => s.path.startsWith('samples/positive/')) && own.some((s) => s.path.startsWith('samples/negative/')), `${check}: both polarities`);
    }
    for (const { path, sample } of samples) {
      const outcomes = (sample.check === 'install' ? install : dispatchPolicy)({ subject: sample.subject, table });
      for (const expected of sample.expect) {
        assert.ok(outcomes.some((o) => o.verdict === expected.verdict && o.code === expected.code && o.item === expected.item), `${path}: ${JSON.stringify(expected)} in ${JSON.stringify(outcomes)}`);
      }
    }
  });
});

describe('the staged pack', { skip: (await osIsolationAvailable()) ? false : 'no OS network isolation on this machine (sandbox-exec)' }, () => {
  it('passes the validation and the publish check of the pack registry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bed-install-'));
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
    assert.deepEqual([report.samples.total, report.samples.passed, report.samples.failed], [8, 8, 0]);
  });
});
