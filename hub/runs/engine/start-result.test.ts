// start_run answers with what a run's text needs (moved here from hub/server/text.test.ts, which renders them): a fact-only
// pack's answer carries its production result {reference, counts}, startRunDetailed the whole result, the run record digest
// and the evidence gaps; a repeated client key answers the same, also after a commentary submission; a Hub-side run answers
// its result; a judgment run answers none and names its unbound expected sources; a failing expected-sources function is a
// gap read back on a repeat; and the submission and start shapes the server's example calls offer are taken. Temporary
// PostgreSQL and the real sandbox (skipped where sandbox-exec is missing, which is not a pass).
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { StartRunOutput, SubmitResultOutput } from '../../../contracts/src/tools.ts';
import { partitionCountsOf } from '../../../contracts/src/validation.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { openHarness, sandboxSkip, type Harness } from './testing/harness.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const trace = (answer: object) => ({ ...answer, trace: TRACE });
const skip = await sandboxSkip();
let postgres: TemporaryPostgres;
let h: Harness;
let map: string;

before(async () => {
  if (skip !== false) return;
  postgres = await startPostgres();
  h = await openHarness(postgres);
  map = await h.upload(h.alice, toyMap(standardDocument()));
});
after(async () => {
  await h?.close();
  await postgres?.stop();
});

/** The submission the server's example offers: the first two items handled, an empty statement list for each slot key. */
function skeleton(run: { run: string; items: { id: string }[]; slots?: { schema: Record<string, unknown> } }): Record<string, unknown> {
  const keys = Object.keys((run.slots?.schema.properties ?? {}) as Record<string, unknown>);
  const defs = Object.keys((run.slots?.schema.$defs ?? {}) as Record<string, unknown>);
  return {
    run: run.run,
    model: '<模型名与配置>',
    items: run.items.slice(0, 2).map((item) => ({ item: item.id, handling: 'handled', slots: Object.fromEntries(keys.map((key) => [key, []])) })),
    ...(defs.length > 0 ? { cross_item: [] } : {}),
  };
}

describe('start_run answers carry the production result and the evidence gaps', () => {
  test('startRun of a fact-only pack answers result {reference, counts}; startRunDetailed gives the same with the whole result and the run record', { skip }, async () => {
    const answer = await h.service.startRun(h.alice, { pack: 'toy-locate', inputs: { map: { reference: map } } }, h.call('sess-result'));
    assert.ok(StartRunOutput.safeParse(trace(answer)).success, 'the answer matches the tool output schema');
    assert.ok(answer.result);
    const latest = (await h.service.getRun(h.alice, answer.run!.run))!.latest!;
    assert.deepEqual(answer.result, { reference: `rec:${latest.record}`, counts: partitionCountsOf(latest.result.partitions) });
    const detail = await h.service.startRunDetailed(h.alice, { pack: 'toy-locate', inputs: { map: { reference: map } } }, h.call('sess-result'));
    assert.deepEqual(detail.answer.result, { reference: detail.production!.reference, counts: detail.production!.counts });
    assert.deepEqual(partitionCountsOf(detail.production!.result.partitions), detail.production!.counts);
    const record = await h.kit.store.get(detail.runRecord!);
    assert.deepEqual([record?.kind, (record?.body as { run?: string }).run], ['run', detail.answer.run!.run], 'the run record digest');
    assert.equal(detail.production!.result.submission, detail.runRecord, 'a production result names the run record as its submission');
    const tidy = Object.values(detail.production!.result.partitions)
      .flat()
      .flatMap((item) => item.requirements.filter((r) => r.requirement === 'tidy' && r.layers.some((l) => l.layer === 'static' && l.terminal === 'violation')));
    assert.ok(tidy.length > 0, 'the structure violation of the toy map is in the whole result');
    assert.deepEqual([detail.unavailable, detail.gaps], [[], []], 'a pack without expected sources has no gaps');
  });

  test('a repeated client key answers the same production result, also after a commentary submission', { skip }, async () => {
    const request = { pack: 'toy-locate', inputs: { map: { reference: map } }, client_key: 'result-key-1' };
    const first = await h.service.startRun(h.alice, request, h.call('sess-result'));
    const commentary = await h.service.submitResult(h.alice, { run: first.run!.run, model: 'model-a', items: [], cross_item: [{ nature: 'judgment', statement: '分组清楚', grounds: [first.run!.items[0].location] }] }, h.call('sess-result'));
    assert.equal(commentary.acceptance, 'accepted');
    assert.notEqual((await h.service.getRun(h.alice, first.run!.run))!.latest!.record, first.result!.reference.slice(4), 'the latest result is the commentary');
    const again = await h.service.startRun(h.alice, request, h.call('another-session'));
    assert.deepEqual(again, first, 'the same answer, the result computed at start_run included');
    const detail = await h.service.startRunDetailed(h.alice, request, h.call('another-session'));
    assert.equal(detail.production!.reference, first.result!.reference);
  });

  test('a Hub-side run answers its result; a judgment run answers none, names its evidence gaps and takes the example skeleton', { skip }, async () => {
    const adminMap = await h.upload(h.admin, toyMap(standardDocument()));
    const hub = await h.service.startHubRun(h.admin, { pack: 'toy-locate', inputs: { map: { reference: adminMap } } }, h.call(null));
    assert.ok(hub.answer.result && hub.production);
    assert.equal(hub.answer.result.reference, hub.production.reference);
    const refused = await h.service.startHubRun(h.alice, { pack: 'toy-locate', inputs: { map: { reference: map } } }, h.call(null));
    assert.deepEqual([refused.answer.call_result, refused.production, refused.runRecord, refused.gaps], ['error', null, null, []]);
    const review = await h.service.startRunDetailed(h.alice, { pack: 'toy-review', product: 'Meadow', inputs: { map: { reference: map } } }, h.call('sess-result'));
    assert.equal(review.answer.call_result, 'ok', JSON.stringify(review.answer.errors));
    assert.equal(review.answer.result, undefined);
    assert.equal(review.production, null);
    assert.deepEqual(review.unavailable, [{ external: 'toy:broken:offline', role: 'expected' }]);
    const example = skeleton(review.answer.run!);
    const submitted = await h.service.submitResult(h.alice, example, h.call('sess-result'));
    assert.ok(SubmitResultOutput.safeParse(trace(submitted)).success, 'the example skeleton is a submission the engine takes and answers');
    assert.ok(submitted.result, 'the answer carries its result');
    const stored = await h.service.getResult(h.alice, review.answer.run!.run, submitted.result.submission);
    assert.deepEqual(stored?.result, submitted.result, 'the result is found by its submission digest, accepted or not');
    const repeated = await h.service.submitResult(h.alice, example, h.call('sess-result'));
    assert.deepEqual(repeated.result, submitted.result, 'a repeated submission gives the same result');
    const again = await h.service.startRunDetailed(h.alice, { pack: 'toy-review', product: 'Meadow', inputs: { map: { reference: map } }, client_key: 'result-key-2' }, h.call('sess-result'));
    const repeat = await h.service.startRunDetailed(h.alice, { pack: 'toy-review', product: 'Meadow', inputs: { map: { reference: map } }, client_key: 'result-key-2' }, h.call('sess-result'));
    assert.deepEqual([repeat.runRecord, repeat.unavailable, repeat.gaps], [again.runRecord, again.unavailable, again.gaps], 'a repeated key gives the same record and gaps');
  });

  test('an expected-sources function that fails is an evidence gap in the detail, also on a repeated client key', { skip }, async () => {
    const file = join(h.review.pack.directory, 'functions', 'expected.ts');
    await rm(file, { force: true });
    await writeFile(file, "export default function () { throw new Error('synthetic failure'); }\n");
    const request = { pack: 'toy-review', product: 'Meadow', inputs: { map: { reference: map } }, client_key: 'result-key-gap' };
    const detail = await h.service.startRunDetailed(h.alice, request, h.call('sess-result'));
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    assert.deepEqual(detail.unavailable, []);
    assert.deepEqual(detail.gaps, [{ code: 'runs.expected_sources_failed', message: '期望来源函数没有给出结果，本次运行没有绑定期望来源' }]);
    const repeat = await h.service.startRunDetailed(h.alice, request, h.call('sess-result'));
    assert.deepEqual(repeat.gaps, detail.gaps, 'the repeat reads the gaps back from the parse action');
  });

  test('a start naming the first product name of a pack bound to several lines, as the server\'s example does, is taken', { skip }, async () => {
    const summary = (await h.workflows.summaries(h.alice)).find((p) => p.id === 'toy-review')!;
    const required = summary.inputs.filter((input) => input.required);
    assert.deepEqual(required.map((input) => input.slot), ['map']);
    const started = await h.service.startRun(h.alice, { pack: summary.pack, product: 'Meadow', inputs: { map: { reference: map } } }, h.call('sess-result'));
    assert.equal(started.call_result, 'ok', JSON.stringify(started.errors));
  });
});
