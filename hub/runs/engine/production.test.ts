import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { SubmitResultOutput } from '../../../contracts/src/tools.ts';
import { ValidationResult, partitionCountsOf, type ItemResult } from '../../../contracts/src/validation.ts';
import type { ActionBody } from '../../records/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { INDEX } from './store.ts';
import { openHarness, sandboxSkip, type Harness } from './testing/harness.ts';
import { ITEM, standardDocument, toyMap } from './testing/mindmap.ts';

let postgres: TemporaryPostgres;
let h: Harness;
let map: string;
const skip = await sandboxSkip();

before(async () => {
  postgres = await startPostgres();
  if (skip) return;
  h = await openHarness(postgres);
  map = await h.upload(h.alice, toyMap(standardDocument()));
});
after(async () => {
  await h?.close();
  await postgres?.stop();
});

const itemOf = (result: ValidationResult, id: string): { partition: string; item: ItemResult } => {
  for (const [partition, items] of Object.entries(result.partitions)) {
    const found = (items as ItemResult[]).find((i) => i.item === id);
    if (found) return { partition, item: found };
  }
  throw new Error(id);
};

test('run detail preserves its production result after accepted commentary changes the latest partitions', { skip }, async () => {
  const started=await h.service.startRunDetailed(h.alice,{pack:'toy-locate',inputs:{map:{reference:map}}},h.call());
  const run=started.answer.run!;
  const commentary=await h.service.submitResult(h.alice,{run:run.run,model:'synthetic-commentary',items:run.items.map((item,i)=>i===0?{item:item.id,handling:'skipped',reason:'合成评论跳过'}:{item:item.id,handling:'handled'}),cross_item:[{nature:'judgment',statement:'这是模型评论',grounds:[]}]},h.call());
  assert.equal(commentary.acceptance,'accepted',JSON.stringify(commentary.errors));
  const detail=(await h.service.getRun(h.alice,run.run))!;
  assert.equal(partitionCountsOf(detail.latest!.result.partitions).incomplete,0);
  assert.deepEqual(detail.production,{record:started.production!.record,result:started.production!.result});
  assert.notEqual(detail.production!.record,detail.latest!.record);
  assert.equal(await h.service.getRun(h.bob,run.run),null);
});

test('a production run: start_run computes and stores the validation result of a fact-only pack', { skip }, async () => {
  const detail = await h.service.startRunDetailed(h.alice, { pack: 'toy-locate', inputs: { map: { reference: map } } }, h.call('sess-locate'));
  assert.equal(detail.answer.call_result, 'ok');
  const run = detail.answer.run!;
  assert.equal(run.slots, undefined, 'the pack declares no slots');
  assert.equal(run.product, undefined);
  const production = detail.production!;
  assert.ok(production);
  assert.equal(production.reference, `rec:${production.record}`);
  assert.deepEqual(production.counts, partitionCountsOf(production.result.partitions));
  const result = production.result;
  assert.ok(ValidationResult.safeParse(result).success);
  assert.equal(result.acceptance, 'accepted');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.coverage, { complete: true, examined: 4, total: 4 });
  // the run record digest stands where a submission digest would
  const record = await h.kit.store.find({ key: INDEX.runId, value: run.run, kind: 'run' });
  assert.equal(result.submission, record.items[0].digest);
  // the answer of a fact-only pack is the data of its support outcomes
  const c1 = itemOf(result, ITEM.c1).item.requirements.find((r) => r.requirement === 'located')!;
  assert.deepEqual(c1.layers, [{ layer: 'static', terminal: 'pass' }]);
  assert.deepEqual(c1.claims[0].statement.data, { document: 'docq7', group: '基本功能' });
  assert.equal(c1.claims[0].warrant.id, 'toy-locate.located@1.0.0');
  // the structure fact makes c4 a violation; located is optional, so nothing is incomplete
  assert.equal(itemOf(result, ITEM.c4).item.requirements.find((r) => r.requirement === 'tidy')!.layers[0].terminal, 'violation');
  assert.deepEqual(production.counts, { delivered: 4, rejected: 0, quarantined: 0, incomplete: 0, unknown: 0 });
  // a run-level fact without an item is listed apart
  assert.deepEqual(result.cross_item.map((c) => [c.requirement, c.statement.data?.cases]), [['overview', 4]]);
  // the result is the run's latest, readable by reference, and the validate action names it
  const detailView = (await h.service.getRun(h.alice, run.run))!;
  assert.deepEqual(detailView.latest, { record: production.record, result });
  assert.deepEqual(detailView.submissions, []);
  const actions = await h.kit.store.find<ActionBody>({ key: INDEX.actionRun, value: run.run, kind: 'action' });
  const validate = actions.items.find((a) => a.body.action === 'validate')!;
  assert.deepEqual([validate.body.acceptance, validate.body.detail.production, validate.body.detail.result], [null, true, production.record]);
  // the plain RunsService answer carries the same run
  assert.equal((await h.service.startRun(h.alice, { pack: 'toy-locate', inputs: { map: { reference: map } } }, h.call())).call_result, 'ok');
});

test('submit_result on a production run is optional and only adds model commentary as judgments', { skip }, async () => {
  const detail = await h.service.startRunDetailed(h.alice, { pack: 'toy-locate', inputs: { map: { reference: map } } }, h.call('sess-locate'));
  const run = detail.answer.run!;
  const commentary = { run: run.run, model: 'model-a', items: [], cross_item: [{ nature: 'judgment', statement: '分组划分清楚', grounds: [run.items[0].location] }] };
  const answer = await h.service.submitResult(h.alice, commentary, h.call('sess-locate'));
  assert.ok(SubmitResultOutput.safeParse({ ...answer, trace: '0af7651916cd43dd8448eb211c80319c' }).success);
  assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
  const result = answer.result!;
  assert.deepEqual(answer.counts, detail.production!.counts);
  const comment = result.cross_item.find((c) => c.warrant.producer === 'model')!;
  assert.deepEqual([comment.statement.text, comment.qualifier.nature, comment.requirement], ['分组划分清楚', 'judgment', undefined]);
  // the facts are recomputed, not taken from the earlier result
  assert.equal(result.cross_item.filter((c) => c.requirement === 'overview').length, 1);
  assert.equal((await h.service.getRun(h.alice, run.run))!.latest?.result.submission, result.submission);
  // item slots have nothing to fill in a fact-only pack
  const filled = await h.service.submitResult(h.alice, { run: run.run, model: 'model-a', items: [{ item: ITEM.c1, handling: 'handled', slots: { located: [] } }] }, h.call());
  assert.deepEqual(filled.errors.map((e) => [e.code, e.path]), [['SUBMISSION_SCHEMA_VIOLATION', '/items/0/slots/located']]);
  // a submitted cross-item fact is stored as a judgment marked unverified
  const fact = await h.service.submitResult(h.alice, { run: run.run, model: 'model-a', items: [], cross_item: [{ nature: 'fact', statement: '共四个用例', grounds: [run.items[0].location] }] }, h.call());
  const claim = fact.result!.cross_item.find((c) => c.warrant.producer === 'model')!;
  assert.deepEqual([claim.qualifier.nature, claim.qualifier.marks.includes('unverified_submission'), claim.statement.data], ['judgment', true, { declared_nature: 'fact' }]);
});
