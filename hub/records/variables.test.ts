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
    await assert.rejects(kit.variables.setSecrets(admin, [{ name: 'DEMO_DATA', value: key(), consumers: [consumer()] }], '合成互斥'), /另一种/);
    assert.deepEqual(await kit.authorizations.resourceConfigs([newId('res')]), new Map());
});
test('ordinary data refuses credential shaped values and notes unless explicitly confirmed as non secret', async (t) => {
    const { kit, admin } = await setup(t);
    const value = 'SyntheticMixedToken42';
    await assert.rejects(kit.variables.setVariable(admin, 'DEMO_DATA', value, '合成设置'), /值像是凭据/);
    const stored = await kit.variables.setVariable(admin, 'DEMO_DATA', value, '合成确认', { notSecret: true });
    assert.match(stored.value.decision.body.note!, /--not-secret/);
    await assert.rejects(kit.variables.setVariable(admin, 'DEMO_OTHER', 1, ''), /理由必填/);
    await assert.rejects(kit.variables.setSecrets(admin, [{ name: 'DEMO_KEY', value, consumers: [consumer()] }], '含 ' + value), /理由不能含/);
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
    const result = await Promise.allSettled([kit.variables.setVariable(admin, 'DEMO_NAME', 1, '合成并发'), kit.variables.setSecrets(admin, [{ name: 'DEMO_NAME', value: key(), consumers: [consumer()] }], '合成并发')]);
    assert.equal(result.filter(v => v.status === 'fulfilled').length, 1);
});
test('secret batches are read coherently, rotate without hashes in objects, and enroll exact consumers', async (t) => {
    const { kit, admin, user } = await setup(t);
    const c = consumer(), a = key(), b = key();
    await kit.variables.setSecrets(admin, [{ name: 'DEMO_USER', value: a, consumers: [c] }, { name: 'DEMO_PASSWORD', value: b, consumers: [c] }], '合成初版');
    const requests = [{ name: 'DEMO_USER', consumer: c }, { name: 'DEMO_PASSWORD', consumer: c }];
    const before = await kit.variables.readSecrets(requests);
    assert.deepEqual(before.map(v => v.value), [a, b]);
    let stop = false;
    const observed: string[][] = [];
    const reading = (async () => { while (!stop)
        observed.push((await kit.variables.readSecrets(requests)).map(v => v.value)); })();
    const nextA = key(), nextB = key();
    try {
        await kit.variables.setSecrets(admin, [{ name: 'DEMO_USER', value: nextA, consumers: [c] }, { name: 'DEMO_PASSWORD', value: nextB, consumers: [c] }], '合成换值');
    }
    finally {
        stop = true;
        await reading;
    }
    for (const values of observed)
        assert.ok(canonicalize(values) === canonicalize([a, b]) || canonicalize(values) === canonicalize([nextA, nextB]));
    assert.equal(await kit.vault.getText(before[0].metadata.entry), a);
    await assert.rejects(kit.variables.readSecrets([{ name: 'DEMO_USER', consumer: { ...c, sends_to: 'b'.repeat(64) } }]), /secret set --name DEMO_USER/);
    await assert.rejects(kit.variables.history(user, 'secret', 'DEMO_USER'), /只有管理员/);
    for (const folder of await readdir(join(kit.dataDir, 'objects')))
        for (const name of await readdir(join(kit.dataDir, 'objects', folder))) {
            const bytes = await readFile(join(kit.dataDir, 'objects', folder, name));
            for (const value of [a, b, nextA, nextB])
                assert.ok(!bytes.includes(Buffer.from(value)));
        }
    await kit.variables.setSecrets(admin, [{ name: 'DEMO_USER', value: nextA, consumers: [c] }], '合成同值新版本');
    assert.equal(await kit.vault.getText(before[0].metadata.entry), null);
    await kit.variables.unset(admin, 'secret', 'DEMO_USER', '合成撤回');
    await assert.rejects(kit.variables.readSecrets([{ name: 'DEMO_USER', consumer: c }]), /secret set/);
});
test('missing or wrong length vault entries fail deterministically and old rows keep their named identity', async (t) => {
    const { kit, admin } = await setup(t);
    const c = consumer();
    const set = await kit.variables.setSecrets(admin, [{ name: 'DEMO_KEY', value: key(), consumers: [c] }], '合成设置');
    const entry = (set[0].definition as any).entry;
    const meta = await kit.vault.stat(entry);
    assert.ok(meta?.written_at);
    await kit.vault.put(entry, 'wrong');
    await assert.rejects(kit.variables.readSecrets([{ name: 'DEMO_KEY', consumer: c }]), /secret set/);
    await kit.vault.remove(entry);
    await assert.rejects(kit.variables.readSecrets([{ name: 'DEMO_KEY', consumer: c }]), /secret set/);
    assert.equal((await kit.variables.history(admin, 'secret', 'DEMO_KEY'))[0].version, 1);
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

test('orphan collection uses read only write metadata and retains a young unbound entry', async t => {
 const {kit,admin}=await setup(t);const prefix='secret.demo_key.';const stale=prefix+'f'.repeat(24),young=prefix+'e'.repeat(24);
 await kit.vault.put(stale,key());await kit.vault.put(young,key());const old=new Date(Date.now()-7200000);await utimes(join(kit.dataDir,'vault',stale+'.sealed'),old,old);
 await kit.variables.setSecrets(admin,[{name:'DEMO_KEY',value:key(),consumers:[consumer()]}],'合成孤儿清理');assert.equal(await kit.vault.has(stale),false);assert.equal(await kit.vault.has(young),true);
});
test('prepared batches join the caller transaction and rollback every decision together', async t => {
 const {kit,admin}=await setup(t);const prepared=await kit.variables.prepareSecrets(admin,[{name:'DEMO_A',value:key(),consumers:[consumer()]},{name:'DEMO_B',value:key(),consumers:[consumer()]}],'合成准备');
 await assert.rejects(kit.store.withTransaction(async tx=>{await kit.variables.commitSecrets(admin,prepared,tx);throw new Error('synthetic rollback');}),/synthetic rollback/);
 assert.equal((await kit.variables.list(admin)).length,0);for(const item of prepared.items)assert.equal(await kit.vault.has(item.metadata.entry),true);
});

test('withdrawal never deletes a secret version committed after its revocation decision',async t=>{
 const {kit,admin}=await setup(t);const use=consumer();await kit.variables.setSecrets(admin,[{name:'DEMO_AUTH',value:key(),consumers:[use]}],'DEMO_INITIAL');
 const transaction=kit.store.withTransaction.bind(kit.store);let interposed=false;
 kit.store.withTransaction=async(fn,outer)=>{const result=await transaction(fn,outer);const row=(result as {decision?:{body:{object:string;revoked:boolean}}})?.decision?.body;
  if(!interposed&&row?.object==='secret:DEMO_AUTH'&&row.revoked){interposed=true;await kit.variables.setSecrets(admin,[{name:'DEMO_AUTH',value:'Demo!FutureKey42',consumers:[use]}],'DEMO_LATER');}
  return result;
 };
 await kit.variables.unset(admin,'secret','DEMO_AUTH','DEMO_WITHDRAW');assert.equal(interposed,true);
 const [latest]=await kit.variables.readSecrets([{name:'DEMO_AUTH',consumer:use}]);assert.equal(latest.value,'Demo!FutureKey42');assert.equal(latest.version,2);
});
