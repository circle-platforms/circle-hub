// One real start_run for a single removed category. The combined production run keeps the multi-document
// bookkeeping; these runs exist so each category can execute on its own worker.
import assert from 'node:assert/strict';
import { RunSummary } from '../../../../contracts/src/run.ts';
import { ValidationResult, type ItemResult } from '../../../../contracts/src/validation.ts';
import { BUILD, LOCK } from './index.ts';
import type { Bed } from './bed.ts';
import { baseDocument, bytesOf, renamed, withoutCategory } from './mindmap.ts';

const FOLDERS = ['合成产品线', '030：合成测试项目', '101：10.6.8', '201: 10.6.8-R1-2026/1', '探测'];
const WARRANT = ['fact', 'projected', 'function', 'template-gap.coverage@1.2.14'] as const;

function requirementOf(result: ValidationResult, item: string): { partition: string; result: ItemResult['requirements'][number] } {
  for (const [partition, items] of Object.entries(result.partitions)) {
    const found = (items as ItemResult[]).find((it) => it.item === item);
    if (found) return { partition, result: found.requirements[0] };
  }
  throw new Error(`item ${item} is in no partition`);
}

/** Starts one document with `category` removed and checks that gap, including the functional exception. */
export async function proveCategoryGap(bed: Bed, category: string, index: number): Promise<void> {
  const id = `91${String(index).padStart(4, '0')}`;
  const doc = renamed(withoutCategory(baseDocument(), category), `r0e2eone${String(index).padStart(4, '0')}`);
  bed.agile.put(id, { bytes: bytesOf(doc), title: doc.title, folders: FOLDERS });
  const detail = await bed.service.startRunDetailed(bed.runner, {
    pack: 'template-gap',
    product: LOCK.names[0],
    build: BUILD,
    inputs: { documents: [{ external: `agile:mindmap:${id}` }] },
  } as Parameters<Bed['service']['startRunDetailed']>[1], bed.call());
  assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
  assert.equal(detail.production, null);
  const run = RunSummary.parse(detail.answer.run);
  const submitted = await bed.service.submitResult(bed.runner, {
    run: run.run,
    model: 'aster-7',
    items: run.items.map((it) => ({ item: it.id, handling: 'handled' as const, slots: { coverage: [] } })),
  }, bed.call());
  assert.equal(submitted.acceptance, 'accepted', JSON.stringify(submitted.errors));
  const result = ValidationResult.parse(submitted.result);
  const { partition, result: req } = requirementOf(result, id);
  assert.equal(partition, 'delivered', 'a gap is delivered content');
  const [claim] = req.claims;
  assert.deepEqual([claim.qualifier.nature, claim.qualifier.provenance, claim.warrant.producer, claim.warrant.id], WARRANT);
  const item = run.items.find((it) => it.id === id)!;
  assert.ok(claim.grounds.includes(item.location), 'the claim rests on the document');
  if (category === 'functional') {
    assert.deepEqual([req.status, req.layers], ['satisfied', [{ layer: 'static', terminal: 'judgment' }]], category);
    assert.deepEqual(item.fields.missing, []);
    assert.match(item.summary ?? '', /24 个模板类别都已覆盖/);
    return;
  }
  assert.deepEqual(req.layers, [{ layer: 'static', terminal: 'violation', code: 'template-gap.category_shortfall', tier: 'advisory', attribution: 'author_input' }], category);
  assert.deepEqual([req.status, req.unsatisfied_reason], ['unsatisfied', 'outcome_mismatch']);
  assert.deepEqual(claim.statement.data?.missing, [category], `exactly ${category} is missing`);
  assert.deepEqual(item.fields.missing, [category]);
  assert.match(item.summary ?? '', new RegExp(`缺 1 个模板类别：[^；]*（${category}）`), 'the line the model reads names it');
}
