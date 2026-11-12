// The opened build through the real PLM pack and read engine (decision 112): a readable build record gives the bug its
// build name. A record held for what else it says stays stored as it came and held, and the name comes from the parts the
// route keeps, generated from it; a kept part held for suspected credentials gives no name, and the reader is told only that
// the record is not available (D05 R[3]: suspected credentials held is a credential class), never why; the coverage of the
// read names the response it left out (decision 113). Synthetic stub data only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestHub } from '../../../hub/server/testing-real.ts';
import { PLM_BUGS, PLM_PRODUCTS } from '../../../hub/connectors/testing/plm.ts';
import { newId } from '../../../hub/records/api.ts';

test('a bug read names its opened build, also when the build record has text that looks like a credential', async (t) => {
  const hub = await createTestHub({ repositoryPacks: ['plm'] });
  try {
    const resource = await hub.addResource({ system_pack: 'plm', name: '合成缺陷资源', environment: 'test', credentials: { username: 'SYNTHETIC_PLM_USER', password: 'SYNTHETIC_PLM_PASSWORD' }, origins: { 'plm-oauth': hub.stubs!.agile.origin, 'plm-api': hub.stubs!.plm.origin }, allow_plaintext: [hub.stubs!.agile.origin, hub.stubs!.plm.origin] });
    await hub.setCredential(resource.id, 'username', hub.stubs!.agileAccount.username);
    await hub.setCredential(resource.id, 'password', hub.stubs!.agileAccount.password);
    const context = { principal: hub.admin.principal, run: null, purpose: '合成开出构建核对' };
    const coverage = new Map<string, unknown>();
    const content = async (id: string): Promise<{ opened_build?: { id: string | null; name: string | null; note?: string } }> => {
      const read = await hub.hub.connectors.reader.read(`plm:bug:${id}`, context);
      assert.ok(read.ok, JSON.stringify(read));
      coverage.set(id, read.coverage);
      const artifact = read.artifacts.find((a) => a.name === 'content');
      assert.ok(artifact);
      const bytes = await hub.records.artifacts.trustedBytes(artifact.artifact.body.sha256);
      assert.ok(bytes);
      return JSON.parse(new TextDecoder().decode(bytes));
    };
    const of = (id: string) => coverage.get(id) as { complete: boolean; examined: number; total: number; note?: string };
    const readable = await content('4545');
    assert.deepEqual(readable.opened_build, { id: '601', name: 'Rel_DEMO_2_3_0_1' });
    assert.deepEqual((await content('4646')).opened_build, { id: '602', name: 'Rel_DEMO_2_3_0_2' }, 'a credential-like text costs the read nothing');
    assert.equal(of('4646').complete, true);
    // Decisions 154 and 161: that record is stored as it came and read like any other; nothing is held for it.
    assert.deepEqual([of('4545').complete, of('4545').examined, of('4545').total], [true, 2, 2]);
    assert.doesNotMatch(of('4545').note ?? '', /没有读进的应答/);
  } finally {
    await hub.close();
  }
});
