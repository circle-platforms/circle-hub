// The run lineage a client tool walks (decision 162): the runs started from a run, reduced to pack, start, parameters and bound
// references, at the reader's own visibility. Synthetic packs and documents only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startPostgres } from '../../testing/postgres.ts';
import { openHarness, sandboxSkip } from './testing/harness.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';

test('the runner exports the runs started from its run, with what each bound; a stranger gets nothing', async t => {
  const skip = await sandboxSkip(); if (skip) return t.skip(skip);
  const postgres = await startPostgres(); const h = await openHarness(postgres);
  try {
    const source = await h.upload(h.alice, toyMap(standardDocument()));
    const draft = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: source } } }, h.call('draft'));
    assert.equal(draft.call_result, 'ok', JSON.stringify(draft.errors));
    const input = { run: draft.run!.run, model: 'synthetic-model', items: draft.run!.items.map(item => ({ item: item.id, handling: 'handled' as const, slots: { findings: [] } })), cross_item: [{ nature: 'judgment', statement: '合成初评', grounds: [], code: 'draft_level', rank: 'P4' }] };
    const submitted = await h.service.submitResult(h.alice, input, h.call('draft')); assert.equal(submitted.acceptance, 'accepted', JSON.stringify(submitted.errors));
    const result = await h.service.getResult(h.alice, draft.run!.run); assert.ok(result);
    assert.deepEqual(await h.service.exportSuccessors!(h.alice, draft.run!.run), { run: draft.run!.run, successors: [] });
    const verification = await h.service.startRun(h.alice, { pack: 'toy-verify', product: 'Meadow', version: '3.2', predecessor: draft.run!.run, inputs: { draft: { reference: `rec:${result.record}` }, map: { reference: source } } }, h.call('verify'));
    assert.equal(verification.call_result, 'ok', JSON.stringify(verification.errors));
    const exported = await h.service.exportSuccessors!(h.alice, draft.run!.run);
    assert.equal(exported!.successors.length, 1);
    const [only] = exported!.successors;
    assert.equal(only.run, verification.run!.run);
    assert.equal(only.pack.split('@')[0], 'toy-verify');
    assert.equal(only.predecessor, draft.run!.run);
    assert.equal(only.started_at, verification.run!.started_at);
    assert.ok(only.sources.some((s) => s.slot === 'draft' && s.reference === `rec:${result.record}`), JSON.stringify(only.sources));
    assert.ok(only.sources.some((s) => s.slot === 'map' && s.reference === source));
    assert.deepEqual(Object.keys(only).sort(), ['pack', 'parameters', 'predecessor', 'run', 'sources', 'started_at'], 'nothing beyond what places it in a lineage');
    assert.equal(await h.service.exportSuccessors!({ id: 'u_01aaaaaaaaaaaaaaaaaaaaaaaa', name: '合成路人', role: 'user' }, draft.run!.run), null);
  } finally { await h.close(); await postgres.stop(); }
});
