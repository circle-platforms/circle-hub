import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { SubmitResultOutput } from '../../../contracts/src/tools.ts';
import type { ActionBody } from '../../records/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { INDEX } from './store.ts';
import { openHarness, sandboxSkip, type Harness } from './testing/harness.ts';
import { standardDocument, toyMap, type ToyDocument } from './testing/mindmap.ts';

let postgres: TemporaryPostgres;
let h: Harness;
const skip = await sandboxSkip();

/** Small enough that a four-case review result (about 25 KB) and a twenty-case run record (about 25 KB) do not fit. */
const MAX_RECORD_BYTES = 20_000;

before(async () => {
  postgres = await startPostgres();
  if (skip) return;
  h = await openHarness(postgres, { limits: { maxRecordBytes: MAX_RECORD_BYTES } });
});
after(async () => {
  await h?.close();
  await postgres?.stop();
});

/** The standard document with `cases` cases in all. */
function documentOf(cases: number): ToyDocument {
  const doc = standardDocument();
  doc.groups[1].cases = Array.from({ length: cases - 3 }, (_, i) => ({ id: `cx${String(i).padStart(10, '0')}`, title: `用例 ${i}`, tags: ['function'], expected: [`结果 ${i}`] }));
  return doc;
}

const runsOf = async (): Promise<number> => (await h.service.listRuns(h.alice, { limit: 500 })).items.length;

test('a result too large for one record is answered not accepted with the fix to split the target, every time', { skip }, async () => {
  const map = await h.upload(h.alice, toyMap(documentOf(4)));
  const started = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: map } } }, h.call());
  assert.equal(started.call_result, 'ok', JSON.stringify(started.errors));
  const run = started.run!;
  const args = { run: run.run, model: 'aster-7', items: run.items.map((it) => ({ item: it.id, handling: 'handled', slots: { findings: [] } })), cross_item: [{ nature: 'judgment', statement: '一般', grounds: [], code: 'draft_level', rank: 'P4' }] };
  const answer = await h.service.submitResult(h.alice, args, h.call());
  assert.ok(SubmitResultOutput.safeParse({ ...answer, trace: '0af7651916cd43dd8448eb211c80319c' }).success);
  assert.deepEqual([answer.call_result, answer.acceptance], ['error', 'not_accepted']);
  assert.deepEqual(answer.errors.map((e) => [e.code, e.path]), [['SUBMISSION_SCHEMA_VIOLATION', '']]);
  assert.match(answer.errors[0].message, new RegExp(`超过 Hub 一条记录的上限 ${MAX_RECORD_BYTES} 字节`));
  assert.match(answer.errors[0].fix ?? '', /分成至少 2 块/);
  // the receipt is stored, the validate action names it, a repeat returns it without re-running anything
  const actions = await h.kit.store.find<ActionBody>({ key: INDEX.actionRun, value: run.run, kind: 'action' });
  const validate = actions.items.find((a) => a.body.action === 'validate')!;
  assert.deepEqual([validate.body.acceptance, validate.body.codes, typeof validate.body.detail.result], ['not_accepted', ['SUBMISSION_SCHEMA_VIOLATION'], 'string']);
  assert.deepEqual(await h.service.submitResult(h.alice, JSON.parse(JSON.stringify(args)), h.call()), answer);
  assert.equal((await h.kit.store.find({ key: INDEX.actionRun, value: run.run, kind: 'action' })).items.length, actions.items.length);
  assert.deepEqual((await h.service.getRun(h.alice, run.run))!.submissions.map((s) => s.acceptance), ['not_accepted']);
});

test('a run record too large for one record is refused before anything is stored', { skip }, async () => {
  const map = await h.upload(h.alice, toyMap(documentOf(20)));
  const before = await runsOf();
  const answer = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: map } } }, h.call());
  assert.deepEqual(answer.errors.map((e) => [e.code, e.path]), [['SUBMISSION_SCHEMA_VIOLATION', '/inputs/map']]);
  assert.match(answer.errors[0].message, /投影出 20 个条目/);
  assert.match(answer.errors[0].fix ?? '', /分块/);
  assert.equal(await runsOf(), before);
});

test('a production result too large for one record is refused before the run is stored', { skip }, async () => {
  const map = await h.upload(h.alice, toyMap(documentOf(20)));
  const before = await runsOf();
  const detail = await h.service.startRunDetailed(h.alice, { pack: 'toy-locate', inputs: { map: { reference: map } } }, h.call());
  assert.deepEqual(detail.answer.errors.map((e) => [e.code, e.path]), [['SUBMISSION_SCHEMA_VIOLATION', '/inputs/map']]);
  assert.match(detail.answer.errors[0].message, /校验结果/);
  assert.equal(detail.production, null);
  assert.equal(await runsOf(), before, 'no run without its result');
  // the same pack on a small target fits and is stored with its result
  const small = await h.upload(h.alice, toyMap(standardDocument()));
  const fits = await h.service.startRunDetailed(h.alice, { pack: 'toy-locate', inputs: { map: { reference: small } } }, h.call());
  assert.equal(fits.answer.call_result, 'ok', JSON.stringify(fits.answer.errors));
  assert.equal((await h.service.getRun(h.alice, fits.answer.run!.run))!.latest?.record, fits.production!.record);
});
