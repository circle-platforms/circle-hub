// The publish check (T02) of the real pack registry on the staged pack: the samples run in the sandbox and pass, both
// polarities per check are present, and a pack whose samples are wrong or missing is refused.
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createPackRegistry, signPack, temporaryDirectory, type PackRegistry } from '../../../hub/runs/api.ts';
import type { Principal } from '../../../hub/records/api.ts';
import { osIsolationAvailable } from '../../../hub/rules/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { openTestRecords, type TestRecordsKit } from '../../../hub/testing/records.ts';
import { IDENTITY, stage } from './pack-files.ts';

const nextVersion = (offset: number) => { const [major, minor, patch] = IDENTITY.version.split('.'); return `${major}.${minor}.${Number(patch) + offset}`; };
const skip = (await osIsolationAvailable()) ? false : 'no OS network isolation on this machine (sandbox-exec)';
let postgres: TemporaryPostgres;
let kit: TestRecordsKit;
let registry: PackRegistry;
let owner: Principal;
let temp: { path: string; remove: () => Promise<void> };

before(async () => {
  postgres = await startPostgres();
  if (skip) return;
  kit = await openTestRecords({ postgres });
  temp = await temporaryDirectory('story-traceability-publish-');
  const admin = (await kit.principals.bootstrapAdmin('管理员')).user;
  const user = await kit.principals.createUser(admin, '甲');
  await kit.authorizations.grantPublishRight(admin, user.id);
  owner = { id: user.id, name: user.name, role: user.role };
  registry = createPackRegistry({ records: kit, extractDir: join(temp.path, 'extracted') });
});
after(async () => {
  await kit?.close();
  await temp?.remove();
  await postgres?.stop();
});

let n = 0;
const staged = async (): Promise<string> => stage(join(temp.path, `staged-${++n}`));

describe('publishing the story-traceability pack', { skip }, () => {
  it('publishes: every sample passes in the sandbox, both polarities per check, author samples only', async () => {
    const outcome = await registry.publish(owner, await staged());
    assert.ok(outcome.ok, outcome.ok ? '' : JSON.stringify(outcome.problems, null, 1));
    assert.equal(outcome.created, true);
    const report = outcome.report;
    assert.deepEqual([report.samples.total, report.samples.passed, report.samples.failed, report.samples.sources.author], [4, 4, 0, 4]);
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.unsampled, []);
    assert.deepEqual(
      report.checks.map((c) => [c.check, c.positive, c.negative, c.marks]),
      [
        ['traced', 1, 1, ['author_samples_only']],
        ['counts', 1, 1, ['author_samples_only']],
      ],
    );
    assert.deepEqual(
      report.warnings.map((w) => w.rule),
      ['publish.author_samples_only', 'publish.author_samples_only'],
    );
    assert.deepEqual([outcome.version.id, outcome.version.version, outcome.version.kind], ['story-traceability', '1.0.15', 'workflow']);
    // The same content again is the same publication.
    const again = await registry.publish(owner, await staged());
    assert.ok(again.ok && again.created === false);
  });

  it('refuses a version whose sample expects what the check does not say', async () => {
    const dir = await staged();
    const path = join(dir, 'samples/negative/traced.json');
    const sample = JSON.parse(await readFile(path, 'utf8')) as { expect: Array<{ code?: string }> };
    sample.expect[0].code = 'story-traceability.no_such_code';
    await writeFile(path, `${JSON.stringify(sample, null, 2)}\n`);
    await signPack(dir, { version: nextVersion(1) });
    const outcome = await registry.publish(owner, dir);
    assert.ok(!outcome.ok);
    assert.ok(outcome.problems.some((p) => p.rule === 'publish.sample_failed' && p.message.includes('join_mismatch')), JSON.stringify(outcome.problems, null, 1));
  });

  it('refuses a version without a negative sample of the counts check', async () => {
    const dir = await staged();
    await rm(join(dir, 'samples/negative/counts.json'));
    await signPack(dir, { version: nextVersion(2) });
    const outcome = await registry.publish(owner, dir);
    assert.ok(!outcome.ok);
    assert.ok(outcome.problems.some((p) => p.rule === 'publish.unsampled'), JSON.stringify(outcome.problems, null, 1));
  });
});
