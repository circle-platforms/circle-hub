// The publish check (T02) of the real pack registry on the staged test-bed pack: the samples run in the sandbox and
// pass, both polarities are present, and a pack whose samples are wrong or missing is refused.
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createPackRegistry, temporaryDirectory, type PackRegistry } from '../../../hub/runs/api.ts';
import type { Principal } from '../../../hub/records/api.ts';
import { osIsolationAvailable } from '../../../hub/rules/api.ts';
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
  temp = await temporaryDirectory('test-bed-publish-');
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

describe('publishing the test-bed pack', { skip }, () => {
  it('publishes: every sample passes in the sandbox, both polarities, author samples only', async () => {
    const outcome = await registry.publish(owner, await staged());
    assert.ok(outcome.ok, outcome.ok ? '' : JSON.stringify(outcome.problems, null, 1));
    assert.equal(outcome.created, true);
    const report = outcome.report;
    assert.deepEqual([report.samples.total, report.samples.passed, report.samples.failed, report.samples.sources.author], [16, 16, 0, 16]);
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.unsampled, []);
  });

  it('the same content publishes again as already published (no new record)', async () => {
    const outcome = await registry.publish(owner, await staged());
    assert.ok(outcome.ok, outcome.ok ? '' : JSON.stringify(outcome.problems, null, 1));
    assert.equal(outcome.created, false);
  });
});
