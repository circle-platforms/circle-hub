// The test-bed pack as files: pack.json lists exactly the pack's files, every declaration has its contract shape, the
// samples cover the check in both polarities, and the staged pack passes the registry's validation and publish check
// (offline; publish.test.ts publishes it for real).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ChecksFile, PackManifest, PackSample, RequirementsFile, SlotsFile, WorkflowFile } from '../../../contracts/src/pack.ts';
import { readPackDirectory, runPublishCheck, validatePack } from '../../../hub/runs/api.ts';
import { osIsolationAvailable } from '../../../hub/rules/api.ts';
import { parseManifest } from './functions/manifest.ts';
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
    assert.deepEqual([manifest.id, manifest.version, manifest.kind], ['test-bed', '1.2.8', 'workflow']);
    const files = await packFiles();
    assert.ok(files.includes('functions/project.ts') && files.includes('functions/check-bed.ts') && files.includes('samples/negative/acquire-mismatch.json') && files.includes('examples/bed-topology.json'));
    assert.ok(!files.some((f) => f.endsWith('.test.ts') || f === 'functions/test-support.ts' || f === 'README.md' || f === 'pack-files.ts'));
  });

  it('binds nothing, reads the inventory named document, and declares the leases context and the bed/ namespace without an expiry cap', () => {
    const workflow = WorkflowFile.parse(json('workflow.json'));
    assert.deepEqual(workflow.inputs, [
      { slot: 'inventory', role: 'subject', description: workflow.inputs[0].description, accepts: ['doc:doc'], required: true, many: false },
    ]);
    assert.deepEqual(workflow.product, { catalogs: [] }, 'unbound: the inventory names everything');
    assert.deepEqual(workflow.context, ['leases'], 'the workflow asks for the frozen lease view (D04)');
    assert.deepEqual(workflow.leases, { prefix: 'bed/' }, 'the reservation has no expiry cap');
    assert.deepEqual(
      workflow.parameters.map((p) => p.name),
      ['action', 'need', 'bed', 'hours', 'booking', 'addresses', 'devices', 'reason'],
    );
    assert.deepEqual([workflow.subject, workflow.projection], ['inventory', { module: 'functions/project.ts' }]);
    const requirements = RequirementsFile.parse(json('requirements.json')).requirements;
    assert.deepEqual(
      requirements.map((r) => ({ ...r, name: undefined, description: undefined })),
      [{ key: 'bed', name: undefined, description: undefined, target: 'item', required: true, done_rule: 'bookkeeping', layers: ['static'], accepted_producer: 'fact', checks: ['bed'], error_handling: [] }],
    );
    assert.match(requirements[0].description, /Hub 记录里空闲（未排除本地操作）/, 'the qualifier is in the requirement text');
    const checks = ChecksFile.parse(json('checks.json')).checks;
    assert.deepEqual(checks, [{ id: 'bed', title: '台架结论复核', function: { module: 'functions/check-bed.ts' }, applies: 'run', subject: { module: 'functions/subject.ts' }, judges: 'subject', tier: 'advisory' }]);
    assert.deepEqual(SlotsFile.parse(json('slots.schema.json')), { schema: 'slots@1', item: {}, run: {} });
    assert.ok(/\p{Script=Han}/u.test(text('SKILL.md')) && text('SKILL.md').includes('Hub 记录里空闲（未排除本地操作）'), 'the qualifier is in the procedure');
  });

  it('has positive and negative samples of the bed check, all in the publish-check shapes and passing the check', async () => {
    const { bedOutcomes } = await import('./functions/check-bed.ts');
    const samples = (PackManifest.parse(json('pack.json')).files.map((f) => f.path).filter((p) => p.startsWith('samples/'))).map((path) => ({ path, sample: PackSample.parse(json(path)) }));
    assert.ok(samples.length >= 12);
    for (const { path, sample } of samples) {
      assert.equal(sample.check, 'bed', path);
      const outcomes = bedOutcomes(sample.subject);
      if (path.startsWith('samples/positive/')) {
        assert.ok(outcomes.length > 0 && outcomes.every((o) => o.verdict === 'support'), `${path}: every outcome is a support`);
      } else {
        assert.ok(outcomes.some((o) => o.verdict === 'refute' && o.code === sample.expect[0]?.code), `${path}: the stated refute happens`);
      }
    }
    assert.ok(samples.some((s) => s.path.startsWith('samples/positive/')) && samples.some((s) => s.path.startsWith('samples/negative/')), 'both polarities');
  });

  it('the synthetic example manifest parses and has both a listener and a blind address for the facts example', () => {
    const manifest = parseManifest(json('examples/bed-topology.json'));
    assert.ok(manifest.ok, manifest.ok ? '' : JSON.stringify(manifest.ok ? undefined : manifest.problems));
    assert.deepEqual(manifest.beds.map((b) => b.name), ['bed-a', 'bed-b']);
  });
});

describe('the staged pack', { skip: (await osIsolationAvailable()) ? false : 'no OS network isolation on this machine (sandbox-exec)' }, () => {
  it('passes the validation and the publish check of the pack registry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'test-bed-'));
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
    assert.deepEqual([report.samples.total, report.samples.passed, report.samples.failed], [16, 16, 0]);
    assert.deepEqual(
      report.checks.map((c) => [c.check, c.tier, c.positive, c.negative, c.marks]),
      [['bed', 'advisory', 8, 8, ['author_samples_only']]],
    );
  });
});
