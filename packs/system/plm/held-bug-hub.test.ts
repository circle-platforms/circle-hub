// A bug whose text a credential scan flags, through the real PLM pack and read engine: the answer stays stored as it came and held,
// and the reader gets the record without the matched value, told that something is left out and not why (B02 R[4], R[6], D05 R[3]).
// Synthetic stub data only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestHub } from '../../../hub/server/testing-real.ts';

test('a bug with a scan hit reads without the matched value, and its original stays held', async () => {
  const hub = await createTestHub({ repositoryPacks: ['plm'] });
  try {
    const resource = await hub.addResource({ system_pack: 'plm', name: '合成缺陷资源', environment: 'test', credentials: { username: 'SYNTHETIC_PLM_USER', password: 'SYNTHETIC_PLM_PASSWORD' }, origins: { 'plm-oauth': hub.stubs!.agile.origin, 'plm-api': hub.stubs!.plm.origin }, allow_plaintext: [hub.stubs!.agile.origin, hub.stubs!.plm.origin] });
    await hub.setCredential(resource.id, 'username', hub.stubs!.agileAccount.username);
    await hub.setCredential(resource.id, 'password', hub.stubs!.agileAccount.password);
    const context = { principal: hub.admin.principal, run: null, purpose: '合成凭据命中核对' };
    const bytes = async (sha: string): Promise<string> => new TextDecoder().decode((await hub.records.artifacts.trustedBytes(sha))!);
    const sources = async (id: string) => {
      const read = await hub.hub.connectors.reader.read(`plm:bug:${id}`, context);
      assert.ok(read.ok, JSON.stringify(read));
      const of = (name: string) => read.artifacts.find((a) => a.name === name)!.artifact;
      return { read, original: of('original'), content: of('content'), text: await bytes(of('content').body.sha256) };
    };

    for (const [id, secret] of [['4848', 'Account-Default-42'], ['4949', 'Account-Default-43']] as const) {
      const { read, original, content, text } = await sources(id);
      assert.doesNotMatch(text, new RegExp(secret), 'the value does not reach the content');
      assert.match(text, /\[已隐去\]/);
      assert.equal(JSON.parse(text).opened_build.name, 'Rel_DEMO_2_3_0_1', 'the rest of the record is there');
      assert.equal(original.body.read_tier, 'retain_only', 'the original stays held');
      assert.ok('read' in original.body.origin, 'what is called the original is what the source sent');
      assert.match(await bytes(original.body.sha256), new RegExp(secret), 'and it was not cut');
      assert.equal(content.body.read_tier, 'model_readable');
      assert.deepEqual([read.coverage?.complete, read.coverage?.note?.includes('部分内容已隐去')], [false, true], 'the reader is told something is left out');
      assert.doesNotMatch(read.coverage?.note ?? '', /凭据|密码|只保留/, 'and not why');
      const inputs = (content.body.origin as { generated: { inputs: string[] } }).generated.inputs;
      const copies = (await Promise.all(inputs.map((input) => hub.records.artifacts.records(input.slice('src:'.length))))).flat().filter((record) => 'generated' in record.body.origin);
      assert.deepEqual(copies.map((record) => (record.body.origin as { generated: { generator: string; inputs: string[] } }).generated).filter((made) => made.generator === 'hub.masked-answer@1').map((made) => made.inputs), [[`src:${original.body.sha256}`]], 'the content comes from a generated copy that names the original');
    }

    const split = await sources('5050');
    assert.doesNotMatch(split.text, /Account-Default-44/, 'a hit that only the projection brings into view is masked too');
    assert.equal(split.original.body.read_tier, 'model_readable', 'there the answer itself had no hit');
    assert.equal(split.read.coverage?.complete, false);

    const clean = await sources('4545');
    assert.doesNotMatch(clean.text, /已隐去/);
    assert.equal(clean.read.coverage?.complete, true, 'a record with no hit reads as before');
  } finally {
    await hub.close();
  }
});
