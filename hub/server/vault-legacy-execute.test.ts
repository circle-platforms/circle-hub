import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, createHash } from 'node:crypto';
import { cp, copyFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setup } from '../dispatch/testing/context.ts';
import { FileVault } from '../records/vault.ts';
import { canonicalBytes } from '../records/api.ts';

test('copied legacy v1 ciphertext and authenticated metadata execute under a new executor ID without a secret database decision', async t => {
    const source = await setup(); t.after(() => source.close());
    const name = 'DEMO_OLD_EXECUTOR', value = randomBytes(24).toString('base64url');
    const entry = 'secret.demo_old_executor.' + randomBytes(12).toString('hex');
    await source.kit.vault.put(entry, value);
    const legacy = { schema: 'secret@1', name, entry, digest_rule: 'plain', length: [...value].length, consumers: [{ definition: source.executor.id, item: 'credential', sends_to: 'a'.repeat(64) }] };
    const object = await source.kit.objects.put(canonicalBytes(legacy), 'application/json');
    const decision = await source.kit.authorizations.configureResource(source.admin, 'secret:' + name, object.sha256, '合成旧执行器设置事实');
    const original = await readFile(join(source.kit.dataDir, 'vault', entry + '.sealed'));
    await (source.kit.vault as FileVault).writeSecretMetadata({ name, versions: [{ metadata: { schema: 'secret@1', name, entry: 'secret.demo_old_executor', version: 1,
        digest_rule: 'plain', length: legacy.length, set_by: decision.body.decided_by, set_at: decision.body.decided_at, revoked: false }, sealed_entry: entry,
        sealed_sha256: createHash('sha256').update(original).digest('hex'), current: true }] });
    const fresh = await setup(); t.after(() => fresh.close());
    assert.ok(fresh.executor.id !== source.executor.id);
    await copyFile(source.kit.keyProvider.path, fresh.kit.keyProvider.path);
    await rm(join(fresh.kit.dataDir, 'vault'), { recursive: true, force: true });
    await cp(join(source.kit.dataDir, 'vault'), join(fresh.kit.dataDir, 'vault'), { recursive: true });
    assert.equal(await fresh.kit.authorizations.resourceConfig('secret:' + name), null);
    await fresh.registry.update(fresh.admin, fresh.executor.id, { ...fresh.executor.source, credential: '${secret:' + name + '}' });
    await fresh.freezeExecutor();
    const state = await fresh.service.dispatch(fresh.admin, fresh.run, fresh.executor.id);
    assert.equal(state.outcome, 'effective');
    assert.equal(fresh.submitted.length, 1);
    assert.ok(fresh.endpoint.calls.every(call => call.headers.authorization === 'Bearer ' + value));
    const events = await fresh.service.journal.events(state.job);
    const used = events.find(event => event.body.detail.phase === 'credential_used');
    assert.deepEqual(used?.body.detail.variables, [{ kind: 'secret', at: fresh.executor.id + '#/credential', name, version: 1, sealed_sha256: createHash('sha256').update(original).digest('hex') }]);
    assert.deepEqual(used?.body.inputs, []);
    assert.equal(await fresh.kit.authorizations.resourceConfig('secret:' + name), null);
    assert.equal((await fresh.kit.vault.secretMetadata(name))?.set_by, source.admin.id);
    assert.ok((await readFile(join(fresh.kit.dataDir, 'vault', entry + '.sealed'))).equals(original));
    assert.ok(!JSON.stringify({ state, events }).includes(value));
});
