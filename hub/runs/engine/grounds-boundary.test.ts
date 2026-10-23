import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { createEngineContext } from './deps.ts';
import { buildScope, createResolver } from './exact.ts';
import { openHarness, sandboxSkip } from './testing/harness.ts';
import { standardDocument, toyMap, ITEM } from './testing/mindmap.ts';

let pg: TemporaryPostgres;
const skip = await sandboxSkip();
before(async () => { pg = await startPostgres(); });
after(async () => { await pg?.stop(); });

test('bound records may be locations but only groundable kinds may be quotes or grounds', { skip }, async t => {
  const h = await openHarness(pg); t.after(() => h.close());
  h.review.workflow.inputs.find(i => i.slot === 'notes')!.accepts.push('application/json');
  const map = await h.upload(h.alice, toyMap(standardDocument()));
  const owner = (await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: map } } }, h.call())).run!;
  const records = await h.kit.store.find({ key: 'runs.id', value: owner.run, kind: 'run' });
  const ref = `rec:${records.items[0].digest}`;
  const run = (await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: map }, notes: [{ reference: ref }] } }, h.call())).run!;
  const ctx = createEngineContext({ records: h.kit, workflows: h.workflows, packs: h.packs, knowledge: h.knowledge, external: h.external });
  const scope = await buildScope(ctx, (await h.service.getRun(h.alice, run.run))!.run, h.review, h.alice, 'function');
  const resolver = createResolver(ctx, scope, 'function');
  assert.equal((await resolver.resolve(ref)).ok, true, 'target/location remains readable');
  for (const form of ['quotes', 'grounds'] as const) {
    const answer = await h.service.submitResult(h.alice, {
      run: run.run, model: 'aster-7',
      items: Object.values(ITEM).map(item => ({ item, handling: 'handled', slots: { findings: item === ITEM.c4 ? [{ text: '合成', code: 'edge_case_gap', rank: 'major', ...(form === 'quotes' ? { quotes: [{ reference: `${ref}#/run`, text: owner.run }] } : { grounds: [ref] }) }] : [] } })),
      cross_item: [{ nature: 'judgment', statement: '一般', grounds: [], code: 'draft_level', rank: 'P4' }],
    }, h.call());
    assert.equal(answer.acceptance, 'not_accepted', form);
    assert.ok(answer.errors?.some(e => /B01 R\[4\].*结果.*动作.*效果/.test(e.message)), JSON.stringify(answer.errors));
  }
});
