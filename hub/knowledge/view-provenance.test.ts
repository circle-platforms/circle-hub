import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IndexView, ScopedDocument } from '../../contracts/src/views.ts';
import { CREDENTIAL_SCANNER, type SourceArtifactBody } from '../records/api.ts';
import { createTestParserRegistry } from '../testing/parsers.ts';
import { createKnowledge, createKnowledgeReader } from './api.ts';
import { makeUnversionedWorld, startPostgres } from './test-support.ts';

test('a scanner upgrade changes composition provenance and cursors without changing index content', async t => {
  const postgres = await startPostgres();
  t.after(() => postgres.stop());
  const w = await makeUnversionedWorld(postgres, true, { entries: 5, statementBytes: 1600 });
  t.after(() => w.close());
  const knowledge = createKnowledge({
    records: w.kit, parsers: createTestParserRegistry(), packs: w.packs,
    external: w.external, admin: w.admin, limits: { maxViewBytes: 65536 + 2600 },
  });
  const build = await knowledge.rootOfBuild('acme', 'Synthetic_10_6');
  assert.ok(build);
  const current = await knowledge.store.composition(build.composition);
  assert.ok(current);
  assert.equal(current.parts, undefined, 'the small fixture keeps its source observations inline');

  // Replay legacy synthetic observations as new append-only fixtures. Only their scanner identity differs.
  const sources: typeof current.sources = [];
  for (const source of current.sources) {
    const capture = await w.kit.store.get<SourceArtifactBody>(source.artifact);
    assert.ok(capture);
    assert.equal(capture.body.scan.scanner, CREDENTIAL_SCANNER);
    const legacy = await w.kit.store.put({
      kind: capture.kind, schema: capture.schema, provenance: capture.provenance,
      created_at: capture.created_at,
      body: { ...capture.body, scan: { ...capture.body.scan, scanner: 'credential-scan@2' } },
    });
    assert.notEqual(legacy.digest, capture.digest);
    sources.push({ ...source, artifact: legacy.digest });
  }
  assert.ok(sources.length > 0);
  const previous = await w.kit.store.withTransaction(tx => knowledge.store.putRoot({ ...current, sources }, tx));
  assert.notEqual(previous.digest, build.composition);
  assert.equal(previous.body.root, current.root);

  const reader = createKnowledgeReader(knowledge);
  const context = { principal: w.user, run: null, purpose: 'synthetic scanner provenance', build: build.build.name };
  const first = `knowledge:index:acme:${build.build.name}?kind=case&key=document`;
  async function read(id: string, composition: string): Promise<IndexView> {
    const result = await reader.read(id, { ...context, composition });
    assert.ok(result.ok, JSON.stringify(result));
    const source = await w.kit.artifacts.source(w.user, result.artifacts[0].artifact.body.sha256, { consumer: 'function' });
    assert.ok(source?.bytes);
    return IndexView.parse(JSON.parse(Buffer.from(source.bytes).toString()));
  }
  const oldView = await read(first, previous.digest);
  const newView = await read(first, build.composition);
  assert.ok(oldView.next && newView.next);
  assert.notEqual(oldView.next, newView.next);
  assert.ok(oldView.scope && newView.scope);
  assert.equal(oldView.scope.roots[0].composition, previous.digest);
  assert.equal(newView.scope.roots[0].composition, build.composition);
  assert.equal(oldView.scope.listed_documents.parts.length, 1);
  assert.equal(newView.scope.listed_documents.parts.length, 1);
  assert.notEqual(oldView.scope.listed_documents.parts[0].sha256, newView.scope.listed_documents.parts[0].sha256);

  function content(view: IndexView) {
    assert.ok(view.scope);
    return {
      ...view, next: null,
      scope: {
        ...view.scope,
        roots: view.scope.roots.map(({ composition, ...root }) => root),
        listed_documents: {
          ...view.scope.listed_documents,
          parts: view.scope.listed_documents.parts.map(({ reference, sha256, ...part }) => part),
        },
      },
    };
  }
  assert.deepEqual(content(newView), content(oldView), 'only the composition, scope-part identities and cursor may change');
  async function listed(view: IndexView, composition: string) {
    const rows = [];
    for (const part of view.scope!.listed_documents.parts) {
      const source = await w.kit.artifacts.source(w.user, part.sha256, { consumer: 'function' });
      assert.ok(source?.bytes);
      const page = ScopedDocument.array().parse(JSON.parse(Buffer.from(source.bytes).toString()));
      assert.equal(page.length, part.rows);
      for (const { at, ...row } of page) {
        assert.deepEqual(at, [composition]);
        rows.push(row);
      }
    }
    return rows;
  }
  assert.deepEqual(await listed(newView, build.composition), await listed(oldView, previous.digest));
  for (const [view, own, other] of [[oldView, previous.digest, build.composition], [newView, build.composition, previous.digest]] as const) {
    const next = await read(view.next!, own);
    assert.ok(Object.keys(next.entries).length > 0, 'the cursor advances within its original composition');
    const mismatch = await reader.read(view.next!, { ...context, composition: other });
    assert.equal(mismatch.ok, false, 'the same tree root does not authorize mixing observation snapshots');
    if (!mismatch.ok) assert.match(mismatch.reason, /游标/);
  }
});
