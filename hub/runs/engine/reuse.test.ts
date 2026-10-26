import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { RunSummary } from '../../../contracts/src/run.ts';
import type { ItemResult, ValidationResult } from '../../../contracts/src/validation.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { openHarness, sandboxSkip, type Harness } from './testing/harness.ts';
import { ITEM, standardDocument, toyMap, type ToyDocument } from './testing/mindmap.ts';
import { sha } from './testing/knowledge.ts';
import { reviewPack, writePack } from './testing/packs.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let postgres: TemporaryPostgres;
let h: Harness;
const skip = await sandboxSkip();

before(async () => {
  postgres = await startPostgres();
  if (skip) return;
  h = await openHarness(postgres);
});
after(async () => {
  await h?.close();
  await postgres?.stop();
});

const IDS = [ITEM.c1, ITEM.c2, ITEM.c3, ITEM.c4];
const TITLES: Record<string, string> = { [ITEM.c1]: '设置 3 区浇灌 15 分钟', [ITEM.c2]: '查看分区状态', [ITEM.c3]: '设置 9 区应报错', [ITEM.c4]: '没有期望结果的用例' };

/** The standard document with the expected result of c2 rewritten: only c2 changes as an item. */
function revised(): ToyDocument {
  const doc = standardDocument();
  doc.groups[0].cases[1].expected = ['列出全部分区及其开关状态'];
  return doc;
}

async function start(map: string, predecessor?: string, pack = 'toy-review'): Promise<RunSummary> {
  // A pack that requires no catalog is bound to no product line (toy-locate), so it is started without a product.
  const bound = pack.startsWith('toy-review') ? { product: 'Meadow', version: '3.2' } : {};
  const answer = await h.service.startRun(h.alice, { pack, ...bound, inputs: { map: { reference: map } }, ...(predecessor ? { predecessor } : {}) }, h.call('sess-draft'));
  assert.equal(answer.call_result, 'ok', JSON.stringify(answer.errors));
  return answer.run!;
}

/** The digest of the context the model judged an item in (W07 F[1]): what lets an unchanged item be reused. */
const contextOf = (id: string): string => sha(`context of ${id}`);

/** Findings: c1 quotes its own title; c3 quotes the expected result of c2 (another node), which the revision changes. */
function firstSubmission(run: RunSummary, contexts = true): Record<string, unknown> {
  const at = (id: string) => run.items.find((i) => i.id === id)!.location;
  const c2expected = at(ITEM.c2).replace('c2bbbbbbbbbb', 'c2bbbbbbbbbbe0');
  return {
    run: run.run,
    model: 'aster-7 temperature=0',
    items: IDS.map((id) => {
      const context = contexts ? { context: contextOf(id) } : {};
      if (id === ITEM.c1) return { item: id, handling: 'handled', ...context, slots: { findings: [{ text: '缺少 0 分钟的边界用例', code: 'edge_case_gap', rank: 'major', location: at(id), quotes: [{ reference: at(id), text: TITLES[id] }] }] } };
      if (id === ITEM.c3) return { item: id, handling: 'handled', ...context, slots: { findings: [{ text: '与 c2 的期望不一致', code: 'self_contradiction', rank: 'major', location: at(id), quotes: [{ reference: c2expected, text: '列出 8 个分区的状态' }] }] } };
      return { item: id, handling: 'handled', ...context, slots: { findings: [] } };
    }),
    cross_item: [{ nature: 'judgment', statement: '反向用例偏少', grounds: [], code: 'draft_level', rank: 'P4' }],
  };
}

const itemOf = (result: ValidationResult, id: string): ItemResult => Object.values(result.partitions).flat().find((i) => i.item === id)!;

test('an unchanged item is offered for carry-over; a changed item or one whose cited content changed is re-judged', { skip }, async () => {
  const v1 = await h.upload(h.alice, toyMap(standardDocument()));
  const r1 = await start(v1);
  const first = await h.service.submitResult(h.alice, firstSubmission(r1), h.call('sess-draft'));
  assert.equal(first.acceptance, 'accepted', JSON.stringify(first.errors));
  // a slot record written with its context digest is not marked no_reuse, and its claims are bound to that digest
  const judged = itemOf(first.result!, ITEM.c1).requirements.find((r) => r.requirement === 'findings')!.claims.find((c) => c.warrant.producer === 'model')!;
  assert.ok(!judged.qualifier.marks.includes('no_reuse'));
  assert.ok(judged.validity.bound.includes(contextOf(ITEM.c1)));
  const v2 = await h.upload(h.alice, toyMap(revised()));
  const r2 = await start(v2, r1.run);
  const offered = Object.fromEntries(r2.items.map((i) => [i.id, i.reuse]));
  const result1 = (await h.service.getResult(h.alice, r1.run))!;
  assert.equal(offered[ITEM.c1], `rec:${result1.record}#/partitions/delivered/0`);
  assert.equal(offered[ITEM.c2], undefined, 'the changed item');
  assert.equal(offered[ITEM.c3], undefined, 'its quotation cites a fragment the revision changed');
  assert.equal(offered[ITEM.c4], `rec:${result1.record}#/partitions/delivered/3`);
  assert.equal(r2.items.find((i) => i.id === ITEM.c1)!.digest, r1.items.find((i) => i.id === ITEM.c1)!.digest);
  assert.notEqual(r2.items.find((i) => i.id === ITEM.c2)!.digest, r1.items.find((i) => i.id === ITEM.c2)!.digest);

  // a reuse that was not offered is a structure violation of the whole submission
  const wrong = {
    run: r2.run,
    model: 'aster-7 temperature=0',
    items: [{ item: ITEM.c2, handling: 'handled', reuse: offered[ITEM.c1] }],
    cross_item: [{ nature: 'judgment', statement: '一般', grounds: [], code: 'draft_level', rank: 'P4' }],
  };
  const refused = await h.service.submitResult(h.alice, wrong, h.call('sess-draft'));
  assert.deepEqual(refused.errors.map((e) => [e.code, e.path]), [['SUBMISSION_SCHEMA_VIOLATION', '/items/0/reuse'],...Array.from({length:3},()=>['not_covered','/items'])]);

  // carrying the unchanged items over: their judgments come from the predecessor record, the checks re-run here
  const second = {
    run: r2.run,
    model: 'cedar-3',
    items: [
      { item: ITEM.c1, handling: 'handled', reuse: offered[ITEM.c1] },
      { item: ITEM.c2, handling: 'handled', slots: { findings: [] } },
      { item: ITEM.c3, handling: 'handled', slots: { findings: [] } },
      { item: ITEM.c4, handling: 'handled', reuse: offered[ITEM.c4] },
    ],
    cross_item: [{ nature: 'judgment', statement: '反向用例偏少', grounds: [], code: 'draft_level', rank: 'P4' }],
  };
  const answer = await h.service.submitResult(h.alice, second, h.call('sess-draft'));
  assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
  const c1 = itemOf(answer.result!, ITEM.c1);
  assert.equal(c1.carried_over, offered[ITEM.c1]);
  assert.equal(itemOf(answer.result!, ITEM.c2).carried_over, undefined);
  const before = itemOf(first.result!, ITEM.c1).requirements.find((r) => r.requirement === 'findings')!.claims.filter((c) => c.warrant.producer === 'model');
  const after = c1.requirements.find((r) => r.requirement === 'findings')!.claims;
  assert.deepEqual(after.filter((c) => c.warrant.producer === 'model'), before, 'judge and model configuration come from the original record');
  assert.ok(after.some((c) => c.warrant.producer === 'function' && c.warrant.id === 'quote@1' && c.statement.verdict === 'support'), 'the checks re-ran on the carried slot record');
  assert.ok(c1.requirements.find((r) => r.requirement === 'structure')!.claims.length > 0);
  // the carried judgment is the predecessor's own: not independent of it
  assert.equal(c1.requirements.find((r) => r.requirement === 'findings')!.unsatisfied_reason, 'independence_unknown');

  // the earlier revision is superseded
  const late = await h.service.submitResult(h.alice, { ...firstSubmission(r1), notes: '迟到的提交' }, h.call('sess-draft'));
  assert.deepEqual(late.errors.map((e) => e.code), ['RUN_SUPERSEDED']);

  // a chain of carry-overs reaches the original slot record
  const r3 = await start(v2, r2.run);
  const c1offer = r3.items.find((i) => i.id === ITEM.c1)!.reuse;
  assert.ok(c1offer);
  const third = await h.service.submitResult(
    h.alice,
    { ...second, run: r3.run, items: [{ item: ITEM.c1, handling: 'handled', reuse: c1offer }, ...second.items.slice(1).map((e) => (e.item === ITEM.c4 ? { item: ITEM.c4, handling: 'handled', slots: { findings: [] } } : e))] },
    h.call('sess-draft'),
  );
  assert.equal(third.acceptance, 'accepted', JSON.stringify(third.errors));
  const carried = itemOf(third.result!, ITEM.c1).requirements.find((r) => r.requirement === 'findings')!.claims.filter((c) => c.warrant.producer === 'model');
  assert.deepEqual(carried, before);
});

test('a slot record written in one go (no context digest) is marked no_reuse and never offered (W07 F[1], decision row 18)', { skip }, async () => {
  const v1 = await h.upload(h.alice, toyMap(standardDocument()), 'application/json', 'sess-whole');
  const r1 = await start(v1);
  const first = await h.service.submitResult(h.alice, firstSubmission(r1, false), h.call('sess-draft'));
  assert.equal(first.acceptance, 'accepted', JSON.stringify(first.errors));
  const judgments = Object.values(first.result!.partitions).flat().flatMap((i) => i.requirements.flatMap((r) => r.claims.filter((c) => c.warrant.producer === 'model')));
  assert.ok(judgments.length > 0 && judgments.every((c) => c.qualifier.marks.includes('no_reuse')));
  const r2 = await start(v1, r1.run);
  assert.ok(r2.items.every((i) => i.reuse === undefined), 'nothing written in one go is offered, not even an unchanged item with nothing to report');
  // a carry-over that was not offered is refused like any other
  const refused = await h.service.submitResult(h.alice, { ...firstSubmission(r2), items: [{ item: ITEM.c1, handling: 'handled', reuse: `rec:${(await h.service.getResult(h.alice, r1.run))!.record}#/partitions/delivered/0` }] }, h.call('sess-draft'));
  assert.deepEqual(refused.errors.map((e) => [e.code, e.path]), [['SUBMISSION_SCHEMA_VIOLATION', '/items/0/reuse'],...Array.from({length:3},()=>['not_covered','/items'])]);
});

test('a fact-only pack gets no carry-over offers: its results hold no judgment to carry', { skip }, async () => {
  const v1 = await h.upload(h.alice, toyMap(standardDocument()), 'application/json', 'sess-locate');
  const r1 = await start(v1, undefined, 'toy-locate');
  const r2 = await start(v1, r1.run, 'toy-locate');
  assert.ok(r2.items.every((i) => i.reuse === undefined));
  // the commentary of a production run is no source of offers either
  assert.equal((await h.service.submitResult(h.alice, { run: r2.run, model: 'aster-7', items: [], cross_item: [{ nature: 'judgment', statement: '分组清楚', grounds: [] }] }, h.call())).acceptance, 'accepted');
  const r3 = await start(v1, r2.run, 'toy-locate');
  assert.ok(r3.items.every((i) => i.reuse === undefined));
});

// Last in this file: it adds toy-review@1.1.0, which then is the latest version of the pack.
test('no carry-over across pack versions', { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'circle-hub-reuse-'));
  try {
    await h.workflows.add(await writePack(dir, reviewPack({ version: '1.1.0' })));
    const v1 = await h.upload(h.alice, toyMap(standardDocument()), 'application/json', 'sess-other');
    const r1 = await start(v1, undefined, 'toy-review@1.0.0');
    assert.equal((await h.service.submitResult(h.alice, firstSubmission(r1), h.call('sess-draft'))).acceptance, 'accepted');
    const next = await start(v1, r1.run, 'toy-review@1.1.0');
    assert.ok(next.items.every((i) => i.reuse === undefined));
    const same = await start(v1, next.run, 'toy-review@1.1.0');
    assert.ok(same.items.every((i) => i.reuse === undefined), 'the predecessor has no accepted result yet');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
