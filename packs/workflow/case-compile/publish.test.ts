// The publish check (T02) of the real pack registry on the staged case-compile pack: the samples run in the sandbox
// and pass, both polarities are present, and the published version is this pack's.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { join } from 'node:path';
import { osIsolationAvailable } from '../../../hub/rules/api.ts';
import { createPackRegistry, temporaryDirectory } from '../../../hub/runs/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { openTestRecords, type TestRecordsKit } from '../../../hub/testing/records.ts';
import { stage } from './pack-files.ts';

const skip = (await osIsolationAvailable()) ? false : 'no OS network isolation on this machine (sandbox-exec)';
let postgres: TemporaryPostgres;
let kit: TestRecordsKit;
let temp: { path: string; remove(): Promise<void> };

before(async () => {
  postgres = await startPostgres();
  if (skip) return;
  kit = await openTestRecords({ postgres });
  temp = await temporaryDirectory('case-compile-publish-');
});
after(async () => {
  await kit?.close();
  await temp?.remove();
  await postgres?.stop();
});

describe('publishing the case-compile pack', { skip }, () => {
  it('publishes: every sample passes in the sandbox, both polarities, author samples only', async () => {
    const admin = (await kit.principals.bootstrapAdmin('管理员')).user;
    const owner = await kit.principals.createUser(admin, '所有者');
    await kit.authorizations.grantPublishRight(admin, owner.id);
    const registry = createPackRegistry({ records: kit, extractDir: join(temp.path, 'extracted') });
    const outcome = await registry.publish(owner, await stage(join(temp.path, 'staged')));
    assert.equal(outcome.ok, true, JSON.stringify(outcome.ok ? '' : outcome.problems));
    if (!outcome.ok) return;
    assert.equal(outcome.created, true);
    const report = outcome.report;
    assert.deepEqual([report.samples.total, report.samples.passed, report.samples.failed, report.samples.sources.author], [28, 28, 0, 28]);
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.unsampled, []);
    assert.deepEqual(
      report.checks.map((check) => [check.check, check.positive, check.negative]),
      [
        ['contract_shape', 3, 3],
        ['bed_addresses', 2, 2],
        ['commands_catalog', 4, 4],
        ['expected_sources', 2, 2],
        ['expected_quotes', 1, 1],
        ['workbook_verified', 1, 1],
        ['dispatch_policy',1,1],
      ],
    );
    assert.deepEqual([outcome.version.id, outcome.version.version, outcome.version.kind], ['case-compile', '3.4.4', 'workflow']);
    const again = await registry.publish(owner, await stage(join(temp.path, 'staged-again')));
    assert.equal(again.ok && again.created, false, '同样内容再发布不新建版本');
  });
});
