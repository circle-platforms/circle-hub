// The opened build through the real PLM pack and read engine (decision 112): a readable build record gives the bug its
// build name; a build record held for suspected credentials gives no name, and the reader is told only that the record is
// not available (D05 R[3]: suspected credentials held is a credential class), never why; the coverage of the read names the
// response it left out (decision 113). Synthetic stub data only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestHub } from '../../../hub/server/testing-real.ts';

test('a bug read names its opened build when the build record is readable and stays neutral when the record is held', async () => {
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
    const readable = await content('4545');
    assert.deepEqual(readable.opened_build, { id: '601', name: 'Rel_DEMO_2_3_0_1' });
    const held = await content('4646');
    assert.equal(held.opened_build?.id, '602');
    assert.equal(held.opened_build?.name, null);
    assert.match(held.opened_build?.note ?? '', /^构建 602 的记录没读到：应答对你不可用（原因只记在管理员记录里）$/);
    assert.doesNotMatch(JSON.stringify(held), /凭据|只保留|Zq8-Hunter2|[0-9a-f]{64}/, 'neither the cause nor the held answer reaches the reader');
    // The coverage names the response it leaves out, in the same neutral words (decision 113).
    const of = (id: string) => coverage.get(id) as { complete: boolean; examined: number; total: number; note?: string };
    assert.deepEqual([of('4545').complete, of('4545').examined, of('4545').total], [true, 2, 2]);
    assert.doesNotMatch(of('4545').note ?? '', /没有读进的应答/);
    assert.deepEqual([of('4646').complete, of('4646').examined, of('4646').total], [false, 1, 2]);
    assert.match(of('4646').note ?? '', /^没有读进的应答 1 个：opened（路由 build-detail）：应答对你不可用（原因只记在管理员记录里）(；|$)/);
    assert.doesNotMatch(of('4646').note ?? '', /凭据|只保留|Zq8-Hunter2/);
  } finally {
    await hub.close();
  }
});
