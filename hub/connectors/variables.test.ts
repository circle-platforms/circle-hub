// Synthetic deployment references, migration and live credential binding.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { openConnectorKit } from './testing/kit.ts';
import { SecretReference } from '../../contracts/src/variables.ts';
let pg: TemporaryPostgres;
before(async () => { pg = await startPostgres(); });
after(() => pg?.stop());
const input = { system_pack: 'agile-test', name: 'DEMO_RESOURCE', environment: 'test' as const, origins: { 'agile-api': 'http://192.0.2.10', 'agile-oauth': 'http://192.0.2.10' }, allow_plaintext: ['http://192.0.2.10'] };
test('resource credentials require explicit names and references preserve their exact grammar', async (t) => {
    const k = await openConnectorKit(pg);
    t.after(() => k.close());
    assert.equal(SecretReference.safeParse('${secret:DEMO_PASSWORD}').success, true);
    await assert.rejects(k.connectors.admin.addResource(k.admin, input), /凭据项/);
    const r = await k.connectors.admin.addResource(k.admin, { ...input, credentials: { username: 'DEMO_USER', password: 'DEMO_PASSWORD' } });
    assert.deepEqual(r.credentials, { username: '${secret:DEMO_USER}', password: '${secret:DEMO_PASSWORD}' });
    const d = await k.connectors.admin.describe(k.admin, r.id);
    assert.equal(d?.credentials[0].set, false);
});
test('resource variable references are required, settings merge by key, and credentials never resolve in settings', async (t) => {
    const k = await openConnectorKit(pg);
    t.after(() => k.close());
    const named = { ...input, credentials: { username: 'DEMO_USER', password: 'DEMO_PASSWORD' } };
    await assert.rejects(k.connectors.admin.addResource(k.admin, { ...named, settings: { root: '${var:DEMO_ROOT}' } }), /var set/);
    await k.records.variables.setVariable(k.admin, 'DEMO_ROOT', 'demo-root', 'DEMO_REASON');
    const r = await k.connectors.admin.addResource(k.admin, { ...named, settings: { root: '${var:DEMO_ROOT}', keep: 'demo' } });
    const changed = await k.connectors.admin.updateResource(k.admin, r.id, { settings: { other: 'value' } });
    assert.deepEqual(changed.settings, { root: '${var:DEMO_ROOT}', keep: 'demo', other: 'value' });
    await assert.rejects(k.connectors.admin.updateResource(k.admin, r.id, { settings: { bad: '${secret:DEMO_PASSWORD}' } }), /普通变量/);
});
test('two resources share credential versions: rotation refreshes sessions and one refused version stops both processes', async (t) => {
    const { startAgileStub, agileFixture } = await import('./testing/agile.ts');
    const { resourceConsumer } = await import('./resources.ts');
    const k = await openConnectorKit(pg);
    t.after(() => k.close());
    const stub = await startAgileStub(agileFixture('demo-document', { password: 'DEMO!Password42' }));
    t.after(() => stub.close());
    const common = { ...input, origins: { 'agile-api': stub.origin, 'agile-oauth': stub.origin }, allow_plaintext: [stub.origin], credentials: { username: 'DEMO_USER', password: 'DEMO_PASSWORD' }, settings: { 'root#': '${var:DEMO_ROOT}' } };
    await k.records.variables.setVariable(k.admin, 'DEMO_ROOT', 'demo-root', 'DEMO_REASON');
    const first = await k.connectors.admin.addResource(k.admin, common), second = await k.connectors.admin.addResource(k.admin, { ...common, name: 'DEMO_SECOND' });
    const set = async (password: string) => k.records.variables.setSecrets(k.admin, [{ name: 'DEMO_USER', value: 'reader', short: true, consumers: [first, second].map(r => resourceConsumer(r, 'username')) }, { name: 'DEMO_PASSWORD', value: password, consumers: [first, second].map(r => resourceConsumer(r, 'password')) }], 'DEMO_ROTATION');
    await set('DEMO!Password42');
    const other = k.make();
    const read = (r: typeof first, c = k.connectors) => c.executeRead(r.id, 'tree', { id: '7714' }, { principal: k.user, purpose: 'DEMO' });
    for (const [r, c] of [[first, k.connectors], [second, other]] as const) {
        const answer = await read(r, c);
        assert.equal(answer.ok, true, answer.ok ? '' : answer.reason);
    }
    assert.equal(stub.logins, 2);
    stub.setPassword('DEMO!Password43');
    stub.expireTokens();
    await set('DEMO!Password43');
    for (const [r, c] of [[first, k.connectors], [second, other]] as const)
        assert.equal((await read(r, c)).ok, true);
    assert.equal(stub.logins, 4);
    const outcome = await read(first);
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
        const row = await k.records.store.get<any>(outcome.manifest);
        assert.equal(row?.body.variables[0].name, 'DEMO_ROOT');
        assert.equal(row?.body.variables[0].at, first.id + '#/settings/root#');
        assert.ok(row?.body.inputs.length >= 4);
    }
    await set('DEMO!Incorrect44');
    const before = stub.logins;
    const answers = await Promise.all([read(first), read(second, other)]);
    assert.ok(answers.every(a => !a.ok));
    assert.equal(stub.logins, before + 1);
    const sent = stub.requests.length;
    await read(second, other);
    assert.equal(stub.requests.length, sent);
    await k.connectors.admin.resetLogin(k.admin, first.id);
    await read(second, other);
    assert.equal(stub.logins, before + 2);
});
test('legacy migration commits both decisions, rejects a destination change, and removes the old entry last', async (t) => {
    const { canonicalBytes } = await import('../records/api.ts');
    const k = await openConnectorKit(pg);
    t.after(() => k.close());
    const r = await k.connectors.admin.addResource(k.admin, { ...input, credentials: { username: 'DEMO_USER', password: 'DEMO_PASSWORD' } });
    const old = { ...r, credentials: { username: `connector.${r.id}.username`, password: `connector.${r.id}.password` } };
    const object = await k.records.objects.put(canonicalBytes(old), 'application/json');
    await k.records.authorizations.configureResource(k.admin, r.id, object.sha256, 'DEMO_LEGACY');
    await k.records.vault.put(old.credentials.username, 'demo-reader');
    await assert.rejects(k.connectors.admin.updateResource(k.admin, r.id, { credentials: { username: 'DEMO_USER' }, allow_plaintext: ['http://192.0.2.11'], origins: { 'agile-api': 'http://192.0.2.11', 'agile-oauth': 'http://192.0.2.11' } }), /分开做/);
    const changed = await k.connectors.admin.updateResource(k.admin, r.id, { credentials: { username: 'DEMO_USER' } });
    assert.equal(changed.credentials.username, '${secret:DEMO_USER}');
    assert.equal(await k.records.vault.has(old.credentials.username), false);
    assert.equal((await k.records.variables.list(k.admin)).find(v => v.name === 'DEMO_USER')?.version, 1);
    const again = await k.connectors.admin.updateResource(k.admin, r.id, { credentials: { password: 'DEMO_PASSWORD' } });
    assert.equal(again.credentials.password, '${secret:DEMO_PASSWORD}');
});
