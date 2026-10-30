import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FacetView, IndexView } from '../../contracts/src/views.ts';
import { buildCompactIndex } from '../../packs/workflow/defect-to-case/functions/compact-index.ts';
import { createKnowledgeReader } from './api.ts';
import { startPostgres } from './test-support.ts';
import { world } from './testing/feeding-bounds-fixture.ts';

test('unparsed author steps do not become an empty, complete command set in case views', async t => {
  const pg = await startPostgres();
  t.after(() => pg.stop());
  const xml = '<commands><menu name="system"><item name="status"><arguments/></item></menu></commands>';
  const w = await world(pg, false, undefined, xml);
  t.after(() => w.close());
  const receipt = await w.knowledge.feeding!.observeSource(w.user, w.document.body.sha256, w.scope);
  assert.equal(receipt.objects.length, 40);

  async function view(kind: string, query: string) {
    const result = await createKnowledgeReader(w.knowledge).read(`knowledge:${kind}:apv:${w.name}?${query}`, { principal: w.user, run: null, purpose: 'Synthetic unresolved command steps' });
    assert.ok(result.ok, result.ok ? '' : result.reason);
    const original = result.artifacts.find(row => row.name === 'original');
    assert.ok(original);
    const source = await w.kit.artifacts.source(w.user, original.artifact.body.sha256, { consumer: 'function' });
    assert.ok(source?.bytes);
    return JSON.parse(new TextDecoder().decode(source.bytes));
  }

  const documents = IndexView.parse(await view('index', 'kind=case&key=document&only=SYN-DOC&fields=document,node,commands,command_identities,unparsed_steps'));
  assert.equal(documents.keys['SYN-DOC']?.length, 40);
  assert.equal(documents.truncated, true);
  // The truncation is only the unknown command identities: the view says how many entries and that nothing else was cut.
  assert.equal(documents.unknown_entries, 40);
  assert.equal(documents.unknown_only, true);
  assert.ok(documents.notes.some(note => note.includes('缺完整命令身份') && note.includes('下一步')));
  for (const entry of Object.values(documents.entries)) {
    assert.equal(entry.data.unparsed_steps, 1);
    assert.equal(Object.hasOwn(entry.data, 'commands'), false);
    assert.equal(Object.hasOwn(entry.data, 'command_identities'), false);
  }

  const commands = IndexView.parse(await view('index', 'kind=case&key=commands&only=%2Fcommands%2Fsystem%2Fshow'));
  assert.equal(commands.total_entries, 0);
  assert.equal(commands.truncated, true);
  assert.equal(commands.unknown_entries, 40);
  assert.equal(commands.unknown_only, true);
  assert.ok(commands.notes.some(note => note.includes('缺完整命令身份') && note.includes('下一步')));
  const compact = buildCompactIndex(commands);
  assert.equal(compact.complete, false);
  assert.equal(compact.sourceTruncated, true);
  const facets = FacetView.parse(await view('facets', 'kind=case&by=commands'));
  assert.equal(facets.total, 0);
  assert.equal(facets.truncated, true);
  assert.equal(facets.unknown_entries, 40);
  assert.equal(facets.unknown_only, true);
  assert.ok(facets.notes.some(note => note.includes('缺完整命令身份') && note.includes('下一步')));
  const lines = FacetView.parse(await view('facets', 'kind=case&by=line'));
  assert.equal(lines.total, 40);
  assert.equal(lines.truncated, false);
  assert.equal(Object.hasOwn(lines, 'unknown_entries'), false);
  assert.equal(Object.hasOwn(lines, 'unknown_only'), false);
  const otherDocument = IndexView.parse(await view('index', 'kind=case&key=document&only=OTHER&fields=document,commands'));
  assert.equal(otherDocument.truncated, false);
  assert.equal(Object.hasOwn(otherDocument, 'unknown_entries'), false);
});
