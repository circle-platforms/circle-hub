import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { readdir, readFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { openTestRecords } from '../testing/records.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { canonicalize, newId, type RecordsKit } from './api.ts';
let postgres: TemporaryPostgres;
before(async () => { postgres = await startPostgres(); });
after(() => postgres?.stop());
async function setup(t: any) { const kit = await openTestRecords({ postgres }); t.after(() => kit.close()); const admin = (await kit.principals.bootstrapAdmin('合成管理员')).user; const user = await kit.principals.createUser(admin, '合成用户'); return { kit, admin, user }; }
const consumer = () => ({ definition: newId('res'), item: 'password', sends_to: 'a'.repeat(64) });
const key = () => randomBytes(24).toString('base64url');
test('named variable versions are append only, idempotent by canonical content, private and mutually exclusive', async (t) => {
    const { kit, admin, user } = await setup(t);
    const first = await kit.variables.setVariable(admin, 'DEMO_DATA', { b: 2, a: 1 }, '合成设置');
    assert.equal(first.value.version, 1);
    const same = await kit.variables.setVariable(admin, 'DEMO_DATA', { a: 1, b: 2 }, '合成同值');
    assert.equal(same.created, false);
    assert.equal(same.value.version, 1);
    const second = await kit.variables.setVariable(admin, 'DEMO_DATA', null, '合成改值');
    assert.equal(second.value.version, 2);
    assert.equal(second.value.decision.body.supersedes, first.value.decision.digest);
    await kit.variables.unset(admin, 'var', 'DEMO_DATA', '合成撤回');
    assert.equal((await kit.variables.snapshot()).has('DEMO_DATA'), false);
    assert.equal((await kit.variables.setVariable(admin, 'DEMO_DATA', [], '合成再设')).value.version, 3);
    assert.equal((await kit.variables.history(admin, 'var', 'DEMO_DATA')).length, 4);
    await assert.rejects(kit.variables.list(user), /只有管理员/);
    await assert.rejects(kit.variables.setVariable(user, 'DEMO_OTHER', 1, '合成设置'), /只有管理员/);
    await assert.rejects(kit.variables.setSecrets(admin, [{ name: 'DEMO_DATA', value: key() }], '合成互斥'), /另一种/);
    assert.deepEqual(await kit.authorizations.resourceConfigs([newId('res')]), new Map());
});
test('ordinary data refuses credential shaped values and notes unless explicitly confirmed as non secret', async (t) => {
    const { kit, admin } = await setup(t);
    const value = 'SyntheticMixedToken42';
    await assert.rejects(kit.variables.setVariable(admin, 'DEMO_DATA', value, '合成设置'), /值像是凭据/);
    const stored = await kit.variables.setVariable(admin, 'DEMO_DATA', value, '合成确认', { notSecret: true });
    assert.match(stored.value.decision.body.note!, /--not-secret/);
    await assert.rejects(kit.variables.setVariable(admin, 'DEMO_OTHER', 1, ''), /理由必填/);
    await assert.rejects(kit.variables.setSecrets(admin, [{ name: 'DEMO_KEY', value }], '含 ' + value), /理由不能含/);
});
test('fifty concurrent writers serialize one name into continuous version and supersedes chains', async (t) => {
    const { kit, admin } = await setup(t);
    const writes = await Promise.all(Array.from({ length: 50 }, (_, index) => kit.variables.setVariable(admin, 'DEMO_COUNT', index, '合成并发')));
    assert.deepEqual(writes.map(v => v.value.version).sort((a, b) => a - b), Array.from({ length: 50 }, (_, i) => i + 1));
    const history = await kit.variables.history(admin, 'var', 'DEMO_COUNT');
    for (let i = 0; i < history.length - 1; i++)
        assert.equal(history[i].decision.body.supersedes, history[i + 1].decision.digest);
});
test('ordinary and secret first writers use the same name lock and exactly one kind wins', async (t) => {
    const { kit, admin } = await setup(t);
    const result = await Promise.allSettled([kit.variables.setVariable(admin, 'DEMO_NAME', 1, '合成并发'), kit.variables.setSecrets(admin, [{ name: 'DEMO_NAME', value: key() }], '合成并发')]);
    assert.equal(result.filter(v => v.status === 'fulfilled').length, 1);
});
test('secret versions resolve by exact name, retain two values and never put values in audit objects', async t => {
    const { kit, admin, user } = await setup(t);
    const a = key(), b = key();
    await kit.variables.setSecrets(admin, [{ name: 'DEMO_USER', value: a }, { name: 'DEMO_PASSWORD', value: b }], '合成初版');
    const requests = [{ name: 'DEMO_USER' }, { name: 'DEMO_PASSWORD' }];
    const before = await kit.variables.readSecrets(requests);
    assert.ok(before[0].value === a && before[1].value === b);
    const nextA = key(), nextB = key();
    await kit.variables.setSecrets(admin, [{ name: 'DEMO_USER', value: nextA }, { name: 'DEMO_PASSWORD', value: nextB }], '合成换值');
    const after = await kit.variables.readSecrets(requests);
    assert.ok(after[0].value === nextA && after[1].value === nextB);
    await assert.rejects(kit.variables.secretHistory(user, 'DEMO_USER'), /只有管理员/);
    for (const folder of await readdir(join(kit.dataDir, 'objects')))
        for (const name of await readdir(join(kit.dataDir, 'objects', folder))) {
            const bytes = await readFile(join(kit.dataDir, 'objects', folder, name));
            for (const value of [a, b, nextA, nextB]) assert.ok(!bytes.includes(Buffer.from(value)));
        }
    await kit.variables.setSecrets(admin, [{ name: 'DEMO_USER', value: nextA }], '合成同值新版本');
    const retained = (await kit.variables.recentSecrets()).filter(v => v.name === 'DEMO_USER');
    assert.equal(retained.length, 2);
    assert.ok(retained.every(v => v.value === nextA));
    await kit.variables.unsetSecret(admin, 'DEMO_USER', '合成撤回');
    await assert.rejects(kit.variables.readSecrets([{ name: 'DEMO_USER' }]), /secret set/);
});
test('corrupted or missing vault metadata fails and a database audit cannot supply material', async t => {
    const { kit, admin } = await setup(t);
    const set = await kit.variables.setSecrets(admin, [{ name: 'DEMO_KEY', value: key() }], '合成设置');
    const entry = set[0].entry;
    const meta = await kit.vault.stat(entry);
    assert.ok(meta?.written_at);
    await kit.vault.put(entry, 'wrong');
    await assert.rejects(kit.variables.readSecrets([{ name: 'DEMO_KEY' }]), /没有取值/);
    await kit.vault.remove(entry);
    await assert.rejects(kit.variables.readSecrets([{ name: 'DEMO_KEY' }]), /名字不存在/);
    assert.equal((await kit.variables.secretHistory(admin, 'DEMO_KEY')).length, 0);
    assert.ok(await kit.authorizations.resourceConfig('secret:DEMO_KEY'));
    assert.equal(await kit.vault.stat(entry), null);
});
test('variable snapshots keep prior decisions after later settings and do not recursively expand values', async (t) => {
    const { kit, admin } = await setup(t);
    await kit.variables.setVariable(admin, 'DEMO_FIELD', 'before', '合成初版');
    const snapshot = await kit.variables.snapshot();
    await kit.variables.setVariable(admin, 'DEMO_FIELD', 'after', '合成换值');
    const bound = await kit.variables.resolveVariables({ field: '${var:DEMO_FIELD}' }, 'res_synthetic', snapshot);
    assert.deepEqual(bound.value, { field: 'before' });
    assert.equal(bound.uses[0].decision, snapshot.get('DEMO_FIELD'));
    assert.deepEqual((await kit.variables.resolveVariables({ field: '${var:DEMO_FIELD}' }, 'res_synthetic')).value, { field: 'after' });
});

test('old unbound random versions are not collected or selected using filesystem times', async t => {
    const { kit, admin } = await setup(t);
    const stale = 'secret.demo_key.' + 'f'.repeat(24), young = 'secret.demo_key.' + 'e'.repeat(24);
    await kit.vault.put(stale, key()); await kit.vault.put(young, key());
    const old = new Date(Date.now() - 7200000);
    await utimes(join(kit.dataDir, 'vault', stale + '.sealed'), old, old);
    await assert.rejects(kit.variables.setSecrets(admin, [{ name: 'DEMO_KEY', value: key() }], '合成旧文件'), /元数据/);
    assert.equal(await kit.vault.has(stale), true);
    assert.equal(await kit.vault.has(young), true);
});
test('an audit transaction rollback does not pretend to roll back already updated independent vault material', async t => {
    const { kit, admin } = await setup(t);
    const a = key(), b = key();
    const prepared = await kit.variables.prepareSecrets(admin, [{ name: 'DEMO_A', value: a }, { name: 'DEMO_B', value: b }], '合成准备');
    await assert.rejects(kit.store.withTransaction(async tx => { await kit.variables.commitSecrets(admin, prepared, tx); throw new Error('synthetic rollback'); }), /synthetic rollback/);
    assert.equal(await kit.authorizations.resourceConfig('secret:DEMO_A'), null);
    assert.equal(await kit.authorizations.resourceConfig('secret:DEMO_B'), null);
    assert.ok((await kit.variables.readSecrets([{ name: 'DEMO_A' }]))[0].value === a);
    assert.ok((await kit.variables.readSecrets([{ name: 'DEMO_B' }]))[0].value === b);
});
test('a later vault set survives a revocation audit committed afterwards', async t => {
    const { kit, admin } = await setup(t);
    await kit.variables.setSecrets(admin, [{ name: 'DEMO_AUTH', value: key() }], 'DEMO_INITIAL');
    const unset = kit.vault.unsetSecret.bind(kit.vault), later = key();
    let interposed = false;
    kit.vault.unsetSecret = async (name, by, at) => {
        const result = await unset(name, by, at);
        interposed = true;
        await kit.variables.setSecrets(admin, [{ name, value: later }], 'DEMO_LATER');
        return result;
    };
    await kit.variables.unsetSecret(admin, 'DEMO_AUTH', 'DEMO_WITHDRAW');
    assert.ok(interposed);
    const [latest] = await kit.variables.readSecrets([{ name: 'DEMO_AUTH' }]);
    assert.ok(latest.value === later);
    assert.equal(latest.version, 3);
});
