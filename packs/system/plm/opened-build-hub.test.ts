// The opened build through the real PLM pack and read engine (decision 112): a readable build record gives the bug its
// build name. A record held for what else it says stays stored as it came and held, and the name comes from the parts the
// route keeps, generated from it; a kept part held for suspected credentials gives no name, and the reader is told only that
// the record is not available (D05 R[3]: suspected credentials held is a credential class), never why; the coverage of the
// read names the response it left out (decision 113). Synthetic stub data only.
import { credentialDetectorsFor } from '../../../hub/testing/records.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestHub } from '../../../hub/server/testing-real.ts';
import { PLM_BUGS, PLM_PRODUCTS } from '../../../hub/connectors/testing/plm.ts';
import { newId } from '../../../hub/records/api.ts';

test('a bug read names its opened build when the build record is readable and stays neutral when the record is held', async (t) => { credentialDetectorsFor(t);
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
    assert.deepEqual((await content('4646')).opened_build, { id: '602', name: 'Rel_DEMO_2_3_0_2' }, 'a credential-like text outside the parts the route keeps costs the read nothing');
    assert.equal(of('4646').complete, true);
    // That record is stored as it came and held; the name comes from a generated artifact that points at it and says nothing else.
    const read = await hub.hub.connectors.reader.read('plm:bug:4646', context);
    assert.ok(read.ok);
    const manifest = await hub.records.store.get<{ requests: { key: string; sha256: string; artifact: string; size: number }[] }>(read.manifest);
    const opened = manifest!.body.requests.find((entry) => entry.key === 'opened')!;
    const original = await hub.records.store.get<{ read_tier: string; provenance_type: string; origin: Record<string, unknown> }>(opened.artifact);
    assert.equal(original!.body.read_tier, 'retain_only');
    assert.ok('read' in original!.body.origin, 'what the source sent is the observed original');
    assert.match(new TextDecoder().decode((await hub.records.artifacts.trustedBytes(opened.sha256))!), /部署说明/, 'nothing was cut before it was stored');
    const content4646 = read.artifacts.find((a) => a.name === 'content')!.artifact.body.origin as { generated: { inputs: string[] } };
    const kept = (await Promise.all(content4646.generated.inputs.map((input) => hub.records.artifacts.records(input.slice('src:'.length))))).flat().find((record) => 'generated' in record.body.origin);
    assert.deepEqual((kept!.body.origin as { generated: { generator: string; inputs: string[] } }).generated.inputs, [`src:${opened.sha256}`]);
    assert.equal((kept!.body.origin as { generated: { generator: string } }).generated.generator, 'hub.kept-parts@1');
    assert.equal(kept!.body.provenance_type, 'projected');
    assert.doesNotMatch(new TextDecoder().decode((await hub.records.artifacts.trustedBytes(kept!.body.sha256))!), /部署说明|Zq8-Hunter2/);
    const held = await content('4747');
    assert.equal(held.opened_build?.id, '603');
    assert.equal(held.opened_build?.name, null);
    assert.match(held.opened_build?.note ?? '', /^构建 603 的记录没读到：应答对你不可用（原因只记在管理员记录里）$/);
    assert.doesNotMatch(JSON.stringify(held), /凭据|只保留|Zq8-Hunter2|[0-9a-f]{64}/, 'neither the cause nor the held answer reaches the reader');
    const read4747 = await hub.hub.connectors.reader.read('plm:bug:4747', context);
    assert.ok(read4747.ok);
    const heldEntry = (await hub.records.store.get<{ requests: { key: string; sha256: string }[] }>(read4747.manifest))!.body.requests.find((entry) => entry.key === 'opened')!;
    assert.ok(heldEntry.sha256);
    assert.ok(!JSON.stringify(read4747.artifacts.find((a) => a.name === 'content')!.artifact.body.origin).includes(heldEntry.sha256), 'no function saw the held answer, so what it made does not name it');
    const unwritable = await content('5050');
    assert.equal(unwritable.opened_build?.name, null, 'kept parts that cannot be written stay held');
    assert.match(unwritable.opened_build?.note ?? '', /^构建 604 的记录没读到：应答对你不可用（原因只记在管理员记录里）$/);
    // The coverage names the response it leaves out, in the same neutral words (decision 113).
    assert.deepEqual([of('4545').complete, of('4545').examined, of('4545').total], [true, 2, 2]);
    assert.doesNotMatch(of('4545').note ?? '', /没有读进的应答/);
    assert.deepEqual([of('4747').complete, of('4747').examined, of('4747').total], [false, 1, 2]);
    assert.match(of('4747').note ?? '', /^没有读进的应答 1 个：opened（路由 build-detail）：应答对你不可用（原因只记在管理员记录里）(；|$)/);
    assert.doesNotMatch(of('4747').note ?? '', /凭据|只保留|Zq8-Hunter2/);
  } finally {
    await hub.close();
  }
});

test('a bug whose own answer is held tells the reader it exists and asks a named administrator; a list says nothing of what is in it', async (t) => { credentialDetectorsFor(t);
  const hit = ['pass', 'word=Zq8-', 'Hunter2-Secret-79'].join('');
  PLM_BUGS['5151'] = { id: '5151', title: '组件升级后报错', status: 'active', openedDate: '2026-02-07 09:00:00', steps: `<p>${hit}</p>` };
  const products = PLM_PRODUCTS.length;
  const hub = await createTestHub({ repositoryPacks: ['plm'] });
  try {
    const resource = await hub.addResource({ system_pack: 'plm', name: '合成缺陷资源', environment: 'test', credentials: { username: 'SYNTHETIC_PLM_USER', password: 'SYNTHETIC_PLM_PASSWORD' }, origins: { 'plm-oauth': hub.stubs!.agile.origin, 'plm-api': hub.stubs!.plm.origin }, allow_plaintext: [hub.stubs!.agile.origin, hub.stubs!.plm.origin] });
    await hub.setCredential(resource.id, 'username', hub.stubs!.agileAccount.username);
    await hub.setCredential(resource.id, 'password', hub.stubs!.agileAccount.password);
    const context = { principal: hub.admin.principal, run: newId('run'), purpose: '合成待核看' };
    const read = await hub.hub.connectors.reader.read('plm:bug:5151', context);
    assert.ok(!read.ok, JSON.stringify(read));
    assert.equal(read.inputError?.code, 'SOURCE_PENDING_REVIEW');
    assert.doesNotMatch(JSON.stringify(read.inputError), /Zq8-Hunter2|password/);
    const asked = (await hub.records.store.find<{ detail: { credential?: { external: string }; audience_user: string; deadline: string } }>({ key: 'action.kind', value: 'read', kind: 'action', limit: 100 })).items.filter((row) => row.body.detail?.credential?.external === 'plm:bug:5151');
    assert.equal(asked.length, 1, 'the assembly reaches the knowledge requests');
    assert.equal(asked[0].body.detail.audience_user, hub.admin.principal.id);
    assert.ok(Date.parse(asked[0].body.detail.deadline) > Date.now());
    // The answer of a list or a lookup shows no object: neither the ids in a set, nor a name the held product list was to resolve.
    const several = await hub.hub.connectors.reader.read('plm:bugs:5151+9999', context);
    assert.ok(!several.ok && several.inputError === undefined, JSON.stringify(several));
    PLM_PRODUCTS.push({ id: 90, name: '合成产品', code: hit });
    const unknown = await hub.hub.connectors.reader.read('plm:builds:Ghost', context);
    assert.ok(!unknown.ok && unknown.inputError === undefined, JSON.stringify(unknown));
  } finally {
    delete PLM_BUGS['5151'];
    PLM_PRODUCTS.length = products;
    await hub.close();
  }
});
