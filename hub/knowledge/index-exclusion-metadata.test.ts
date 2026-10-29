import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { sha256Hex } from '../records/api.ts';
import { createKnowledgeReader } from './api.ts';
import { BASE_CATALOG, DEFAULT_PRODUCERS, casesProducer, catalogXml, makeWorld, mindMap, startPostgres } from './test-support.ts';

let postgres: Awaited<ReturnType<typeof startPostgres>>;
before(async () => { postgres = await startPostgres(); });
after(async () => { await postgres?.stop(); });

test('index read metadata binds its structural exclusion count to the delivered view bytes', async t => {
  const w = await makeWorld(postgres, { pack: { declaration: { producers: [DEFAULT_PRODUCERS[0], casesProducer()] } } });
  t.after(() => w.close());
  const name = 'Rel_ACME_10_8_1_71', tree = 'site:tree:synthetic', flagged = 'store:mindmap:flagged', clean = 'store:mindmap:clean';
  const raw = mindMap({ id: 'flagged', module: 'M1' }, [{ id: 'a', text: '[cmd: system show] password = SyntheticLab72#value', expected: ['ok'] }]);
  w.external.set(tree, { bytes: catalogXml(BASE_CATALOG), mediaType: 'application/xml' });
  w.external.set(flagged, { bytes: raw, mediaType: 'application/json' });
  w.external.set(clean, { bytes: mindMap({ id: 'clean', module: 'M1' }, [{ id: 'b', text: '[cmd: system show] synthetic clean case', expected: ['ok'] }]), mediaType: 'application/json' });
  const build = { name, family: 'ACME', line: '10.8.1', base: name, platform: null, built_at: null, released_at: null, root: null, sources: { tree, cases: [flagged, clean] } };
  const first = await w.knowledge.produceTree({ product: w.product, build });
  assert.equal(first.skippedCount, 1);
  const sha = sha256Hex(Buffer.from(raw));
  await w.kit.artifacts.acceptFindings(w.admin, sha, '合成来源中的示例');
  const produced = await w.knowledge.produceTree({ product: w.product, build });
  assert.equal(produced.skippedCount, 0, produced.reason ?? '');
  const reader = createKnowledgeReader(w.knowledge);
  const id = `knowledge:index:acme:${name}?kind=case&key=module`;
  const read = async () => {
    const result = await reader.read(id, { principal: w.user, run: null, purpose: 'synthetic index metadata' });
    assert.ok(result.ok, result.ok ? '' : result.reason);
    if (!result.ok) throw new Error('synthetic read failed');
    const original = result.artifacts.find(row => row.name === 'original');
    const meta = result.artifacts.find(row => row.name === 'meta');
    assert.ok(original && meta);
    const source = await w.kit.artifacts.source(w.user, meta.artifact.body.sha256, { consumer: 'function', record: meta.artifact.digest });
    assert.ok(source?.bytes);
    return { original, meta: JSON.parse(Buffer.from(source.bytes).toString('utf8')) };
  };
  const accepted = await read();
  assert.equal(accepted.meta.index_excluded_entries, 0);
  assert.equal(accepted.meta.index_view_sha256, accepted.original.artifact.body.sha256);
  await w.kit.artifacts.revokeFindings(w.admin, sha, '撤回合成受理');
  const withheld = await read();
  assert.equal(withheld.meta.index_excluded_entries, 1);
  assert.equal(withheld.meta.index_view_sha256, withheld.original.artifact.body.sha256);
});
