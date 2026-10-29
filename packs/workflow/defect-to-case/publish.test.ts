// Publish check of the defect-to-case pack through the real registry.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Principal } from '../../../hub/records/api.ts';
import { osIsolationAvailable } from '../../../hub/rules/api.ts';
import { createPackRegistry, temporaryDirectory, type PackRegistry } from '../../../hub/runs/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { openTestRecords, type TestRecordsKit } from '../../../hub/testing/records.ts';
import { stage } from './pack-files.ts';

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
  temp = await temporaryDirectory('defect-to-case-publish-');
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

describe('publishing the defect-to-case pack', { skip }, () => {
  it('publishes: every sample passes in the sandbox, both polarities, author samples only', async () => {
    const outcome = await registry.publish(owner, await staged());
    assert.ok(outcome.ok, outcome.ok ? '' : JSON.stringify(outcome.problems, null, 1));
    assert.equal(outcome.created, true);
    const report = outcome.report;
    assert.ok(report.samples.total >= 6, `expected at least 6 samples, got ${report.samples.total}`);
    assert.equal(report.samples.failed, 0);
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.unsampled, []);
    for (const check of report.checks) {
      assert.ok(check.positive > 0, `${check.check} missing positive samples`);
      assert.ok(check.negative > 0, `${check.check} missing negative samples`);
    }

    const skill = await readFile(join(temp.path, `staged-${n}`, 'SKILL.md'), 'utf8');
    assert.ok(skill.length <= 8000, `SKILL.md length ${skill.length} exceeds 8000`);
    assert.deepEqual([outcome.version.id, outcome.version.version, outcome.version.kind], ['defect-to-case', '1.6.22', 'workflow']);
  });
});
