import assert from 'node:assert/strict';
import { test } from 'node:test';
import { secretNameOf } from '../../contracts/src/variables.ts';
import { VaultReadinessError } from '../records/api.ts';
import { setup } from './testing/context.ts';

test('executor configuration isolates unrelated names but precheck still requires complete redaction material', async t => {
  const c = await setup();
  t.after(() => c.close());
  const nameA = secretNameOf(c.executor.source.credential!)!, nameB = 'DEMO_KEY_B';
  const failure = (name: string) => new VaultReadinessError([{ name, entry: 'secret.' + name.toLowerCase() + '.' + 'b'.repeat(24) + '.sealed',
    missing: ['metadata'], reason: '合成未认证材料', next_action: '管理员恢复认证元数据' }]);
  const badA = failure(nameA), badB = failure(nameB);
  const recent = c.kit.variables.recentSecrets.bind(c.kit.variables);
  const scopes: Array<readonly string[] | undefined> = [];
  let ownBroken = false;
  c.kit.variables.recentSecrets = async names => {
    scopes.push(names);
    if (names === undefined || names.includes(nameB)) throw badB;
    if (ownBroken && names.includes(nameA)) throw badA;
    return recent(names);
  };
  await c.registry.update(c.admin, c.executor.id, { ...c.executor.source, max_bytes: 524288 });
  assert.deepEqual(scopes, [[nameA], [nameA]]);
  const before = await c.kit.authorizations.resourceConfig('executor.' + c.executor.id);
  ownBroken = true;
  await assert.rejects(c.registry.update(c.admin, c.executor.id, { ...c.executor.source, max_bytes: 1048576 }), error => error === badA);
  assert.equal((await c.kit.authorizations.resourceConfig('executor.' + c.executor.id))!.digest, before!.digest);
  ownBroken = false;
  await assert.rejects(c.service.precheck(c.admin, c.executor.id), error => error === badB);
  assert.equal(scopes.at(-1), undefined);
  assert.equal(c.endpoint.calls.length, 0);
});
