import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { HubConfig } from '../../config/index.ts';
import { MemberEnvironments } from '../../dispatch/api.ts';
import { Database, createPool, migrateRecords, openRecords } from '../../records/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { openTestRecords } from '../../testing/records.ts';
import { requireProductionUpgradeActivation } from '../upgrade-production.ts';
import { assembleHub, type AssembledHub } from './hub.ts';

let postgres: TemporaryPostgres;
const runtimeRole = 'synthetic_policy_runtime';
before(async () => {
  postgres = await startPostgres({ socket: true, passwordless: true });
  const owner = new Database(createPool(postgres.config, 1));
  try { await owner.query(`CREATE ROLE ${runtimeRole} LOGIN NOSUPERUSER`); } finally { await owner.end(); }
});
after(async () => { await postgres?.stop(); });
const configOf = (kit: Awaited<ReturnType<typeof openTestRecords>>): HubConfig => ({
  dataDir: kit.dataDir, logDir: join(kit.dataDir, 'logs'), host: '127.0.0.1', port: 0,
  database: kit.database, limits: { ...kit.config.limits },
});

async function fixture() {
  const kit = await openTestRecords({ postgres });
  const owner = new Database(createPool(kit.database, 1));
  try {
    await owner.query(`REVOKE TEMPORARY ON DATABASE "${kit.database.database}" FROM PUBLIC`);
    await migrateRecords({ database: kit.database }, { runtimeRole });
    const config = { ...configOf(kit), database: { ...kit.database, user: runtimeRole } };
    const records = await openRecords(config, { migrate: false, keyProvider: kit.keyProvider });
    return { config, records, close: async () => { await records.close(); await owner.end(); await kit.close(); } };
  } catch (error) { await owner.end(); await kit.close(); throw error; }
}

test('activated assignment policy remains disclosed when the lease provider is not ready', async () => {
  const f = await fixture();
  let hub: AssembledHub | undefined;
  try {
    const admin = (await f.records.principals.bootstrapAdmin('合成策略管理员')).user;
    const config = f.config;
    assert.equal(await requireProductionUpgradeActivation(config), true, 'the actual verified production activation is the authority');
    hub = await assembleHub(config, f.records, { leases: null, requireOsIsolation: false, log: () => {} });
    const view = await hub.deps.memberCapabilities(admin);
    assert.equal(view.environmentAccess.ready, false);
    assert.equal(view.environmentAccess.enforced, true, 'unready service is not an OFF policy');
    assert.match(view.environmentAccess.missing ?? '', /未接线/);
    assert.deepEqual(view.environments, []);
    assert.equal(view.unattributed_holdings, null);
  } finally { await hub?.deps.close?.(); await f.close(); }
});

test('administrator preview of a disabled target retains actual policy without extra provider reads or granting use', async () => {
  const f = await fixture();
  let hub: AssembledHub | undefined;
  const original = MemberEnvironments.prototype.list;
  let reads = 0;
  MemberEnvironments.prototype.list = async function(actor) { reads += 1; return original.call(this, actor); };
  try {
    const admin = (await f.records.principals.bootstrapAdmin('合成预览管理员')).user;
    const member = await f.records.principals.createUser(admin, '合成已停用成员');
    const config = f.config;
    assert.equal(await requireProductionUpgradeActivation(config), true);
    hub = await assembleHub(config, f.records, { requireOsIsolation: false, log: () => {} });
    assert.equal((await hub.deps.memberCapabilities(admin)).environmentAccess.ready, true, 'this case has a real ready provider');
    reads = 0;
    await f.records.principals.setDisabled(admin, member.id, true);
    const view = await hub.deps.memberCapabilities(admin, member.id);
    assert.equal(reads, 0, 'metadata must not defeat the disabled projection early return');
    assert.equal(view.member.enabled, false);
    assert.equal(view.environmentAccess.ready, false);
    assert.equal(view.environmentAccess.enforced, true, 'disabled target does not turn the actual policy OFF');
    assert.deepEqual(view.environments, []);
    assert.deepEqual(view.workflows, []);
    assert.equal(view.unattributed_holdings, null);
    assert.deepEqual(view.denials, [{ reason: '账户已停用或删除', nextAction: '由管理员核对账户状态；未启用前不能使用分配' }]);
  } finally { MemberEnvironments.prototype.list = original; await hub?.deps.close?.(); await f.close(); }
});
