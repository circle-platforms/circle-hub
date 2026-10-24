import { assertLayers } from './testing/assertions.ts';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { after, before, test } from 'node:test';
import type { RunSummary } from '../../../contracts/src/run.ts';
import { LayerResult } from '../../../contracts/src/validation.ts';
import type { ItemResult, ValidationResult } from '../../../contracts/src/validation.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { openHarness, sandboxSkip, type Harness, type HarnessOptions } from './testing/harness.ts';
import { ROOTS } from './testing/knowledge.ts';
import { ITEM, standardDocument, toyMap } from './testing/mindmap.ts';

let postgres: TemporaryPostgres;
const skip = await sandboxSkip();

before(async () => {
  postgres = await startPostgres();
});
after(async () => {
  await postgres?.stop();
});

function terminalFields(layers: LayerResult[]): Omit<LayerResult, 'missing' | 'exit' | 'gaps'>[] {
  return layers.map(layer => {
    LayerResult.parse(layer);
    if (layer.reason) { assert.ok(layer.missing); assert.ok(layer.exit); }
    const { missing, exit, gaps, ...fields } = layer;
    return fields;
  });
}
const IDS = [ITEM.c1, ITEM.c2, ITEM.c3, ITEM.c4];

async function reviewed(options: HarnessOptions, prepare?: (h: Harness) => void): Promise<{ h: Harness; run: RunSummary; result: ValidationResult; counts: Record<string, number> }> {
  const h = await openHarness(postgres, options);
  prepare?.(h);
  const map = await h.upload(h.alice, toyMap(standardDocument()));
  const started = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: map } } }, h.call());
  assert.equal(started.call_result, 'ok', JSON.stringify(started.errors));
  const run = started.run!;
  const answer = await h.service.submitResult(
    h.alice,
    {
      run: run.run,
      model: 'model-a',
      items: IDS.map((id) => ({ item: id, handling: 'handled', slots: { findings: [] } })),
      cross_item: [{ nature: 'judgment', statement: '一般', grounds: [], code: 'draft_level', rank: 'P4' }],
    },
    h.call(),
  );
  assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
  return { h, run, result: answer.result!, counts: answer.counts! };
}

const itemOf = (result: ValidationResult, id: string): { partition: string; item: ItemResult } => {
  for (const [partition, items] of Object.entries(result.partitions)) {
    const found = (items as ItemResult[]).find((i) => i.item === id);
    if (found) return { partition, item: found };
  }
  throw new Error(id);
};

test('a check function that throws is unknown (check error, V01 R[6]): unchecked, counted as unknown, never a crash', { skip }, async () => {
  const { h, result, counts } = await reviewed({ review: { fragile: 'boom' } });
  try {
    for (const id of IDS) {
      const { partition, item } = itemOf(result, id);
      const fragile = item.requirements.find((r) => r.requirement === 'fragile')!;
      assertLayers(fragile.layers, [{ layer: 'static', terminal: 'unchecked', reason: 'check_error', attribution: 'producer_error' }], id);
      assert.deepEqual(fragile.layers[0].exit?.audience,{user:h.review.owner});
      assert.equal(fragile.layers[0].exit?.request_kind,'repair');
      assert.equal(fragile.status, 'pending');
      // an unknown is delivered as it is (V05 R[3]: only incomplete layers make an item incomplete)
      assert.equal(partition, 'delivered');
      const fact = fragile.claims[0];
      assert.deepEqual([fact.statement.verdict, fact.statement.reason, fact.qualifier.nature, fact.statement.data?.sandbox], ['unknown', 'check_error', 'unknown', 'FUNCTION_THREW']);
      // a claim without grounds is unknown and not on the basis lattice (A02)
      assert.equal(fact.qualifier.basis_rank, undefined);
      assert.ok(!JSON.stringify(fact).includes(h.review.pack.directory) && !JSON.stringify(fact).includes(tmpdir()), 'no host path reaches a claim');
    }
    // the first content line reports every item as having an unknown (D05 R[1], V03 R[4])
    assert.deepEqual(counts, { delivered: 4, rejected: 0, quarantined: 0, incomplete: 0, unknown: 4 });
    assert.ok(h.logs.some((l) => l.what === 'check fragile'), 'the error went to the admin log');
  } finally {
    await h.close();
  }
});

test('a check function that never returns is ended at its time limit: unknown (timeout)', { skip }, async () => {
  const { h, result, counts } = await reviewed({ review: { fragile: 'spin' }, sandboxLimits: { timeoutMs: 1500 } });
  try {
    const fragile = itemOf(result, ITEM.c1).item.requirements.find((r) => r.requirement === 'fragile')!;
    assertLayers(fragile.layers, [{ layer: 'static', terminal: 'unchecked', reason: 'timeout', attribution: 'transient' }]);
    assert.equal(fragile.claims[0].statement.data?.sandbox, 'SANDBOX_TIMEOUT');
    assert.equal(counts.unknown, 4);
    assert.equal(counts.incomplete, 0);
  } finally {
    await h.close();
  }
});

test('a declared dynamic layer is not run (no check installed) and keeps the requirement pending', { skip }, async () => {
  const { h, result } = await reviewed({ review: { dynamic: true } });
  try {
    const catalog = itemOf(result, ITEM.c1).item.requirements.find((r) => r.requirement === 'catalog')!;
    assertLayers(catalog.layers, [
      { layer: 'static', terminal: 'pass' },
      { layer: 'dynamic', terminal: 'not_run', reason: 'no_check', attribution: 'unattributed' },
    ]);
    assert.equal(catalog.status, 'pending');
    // the other requirements declare no dynamic layer: no entry, not applicable
    assert.ok(itemOf(result, ITEM.c1).item.requirements.filter((r) => r.requirement !== 'catalog').every((r) => r.layers.length === 1));
  } finally {
    await h.close();
  }
});

test('a skipped or uncovered item is incomplete at every layer its requirements declare (W07 R[2], R[3])', { skip }, async () => {
  const h = await openHarness(postgres, { review: { dynamicFindings: true } });
  try {
    const map = await h.upload(h.alice, toyMap(standardDocument()));
    const run = (await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: map } } }, h.call())).run!;
    const answer = await h.service.submitResult(
      h.alice,
      {
        run: run.run,
        model: 'aster-7',
        items: [
          { item: ITEM.c1, handling: 'handled', slots: { findings: [] } },
          { item: ITEM.c2, handling: 'handled', slots: { findings: [] } },
          { item: ITEM.c3, handling: 'skipped', reason: '和 c1 重复' },
        ],
        cross_item: [{ nature: 'judgment', statement: '一般', grounds: [], code: 'draft_level', rank: 'P4' }],
      },
      h.call(),
    );
    assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
    const layersOf = (id: string) => itemOf(answer.result!, id).item.requirements.find((r) => r.requirement === 'findings')!.layers;
    assertLayers(layersOf(ITEM.c3), [
      { layer: 'static', terminal: 'incomplete', reason: 'declared_skip', attribution: 'unattributed' },
      { layer: 'dynamic', terminal: 'incomplete', reason: 'declared_skip', attribution: 'unattributed' },
    ]);
    assertLayers(layersOf(ITEM.c4), [
      { layer: 'static', terminal: 'incomplete', reason: 'not_covered', attribution: 'producer_error' },
      { layer: 'dynamic', terminal: 'incomplete', reason: 'not_covered', attribution: 'producer_error' },
    ]);
    // a handled item: the dynamic layer has no check installed and is not run
    assertLayers(layersOf(ITEM.c1)[1], { layer: 'dynamic', terminal: 'not_run', reason: 'no_check', attribution: 'unattributed' });
  } finally {
    await h.close();
  }
});

test('a check whose catalog the root lacks stays unknown (missing input): unchecked, counted as unknown, delivered', { skip }, async () => {
  const { h, result, counts } = await reviewed({}, (harness) => harness.knowledge.withoutCatalog.add(ROOTS.meadow329));
  try {
    const catalog = itemOf(result, ITEM.c1);
    assert.equal(catalog.partition, 'delivered');
    const r = catalog.item.requirements.find((q) => q.requirement === 'catalog')!;
    assertLayers(r.layers, [{ layer: 'static', terminal: 'unchecked', reason: 'missing_input', attribution: 'data_gap' }]);
    assert.equal(r.status, 'pending');
    assert.equal(counts.unknown, 4);
    // the unknown claim carries no basis rank (A02) and, over a judgment, nothing it would be conditional on
    for (const claim of r.claims) assert.deepEqual([claim.qualifier.nature, claim.qualifier.basis_rank], ['unknown', undefined]);
    const findings = catalog.item.requirements.find((q) => q.requirement === 'findings')!;
    const unknownOverClaims = findings.claims.filter((c) => c.qualifier.nature === 'unknown');
    assert.ok(unknownOverClaims.length > 0);
    for (const claim of unknownOverClaims) assert.deepEqual([claim.qualifier.basis_rank, claim.qualifier.marks.includes('conditional_on_judgment'), claim.validity.premises], [undefined, false, []]);
  } finally {
    await h.close();
  }
});
