// The refresh function of case-compile (workflow.json refresh, ItemRefreshInput -> ItemRefreshOutput): at each evaluation the Hub
// hands it the latest accepted result of the recompose run bound after the start, and it lays each case's own record over the
// frozen item, or says what the case waits for. Synthetic inputs shaped as the Hub hands them (testing/late-binding.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import refresh from './refresh.ts';
import { RECOMPOSE_RUN, boundRecord, digestOf, lateItems, recordRow, refreshInput, resultBody, runBody, twoCases } from '../testing/late-binding.ts';

const setup = () => {
  const { records, source, context } = twoCases();
  const runInput = boundRecord('recomposition_run', 'run', runBody(records, context), 'f'.repeat(64));
  return { records, source, context, runInput, items: lateItems(records, source) };
};
const out = (value: unknown) => value as { items: Array<{ id: string; late: Record<string, any> }> };

test('with no accepted submission yet every late case waits, with the Hub\'s words and the recompose item it waits for', () => {
  const { context, runInput, items } = setup();
  const answer = out(refresh(refreshInput(items, runInput, null, context, '运行 ' + RECOMPOSE_RUN + ' 还没有已受理提交')));
  assert.deepEqual(answer.items.map((row) => row.id), items.map((item) => item.id));
  for (const [index, row] of answer.items.entries()) {
    assert.equal(row.late.recomposition, undefined);
    assert.deepEqual(row.late.recomposition_waiting, { run: RECOMPOSE_RUN, result: null, state: 'no_result', item: `recompose-item-${index + 1}`, autoid: items[index].fields.autoid, missing: '运行 ' + RECOMPOSE_RUN + ' 还没有已受理提交' });
    assert.match(row.late.recomposition_problem, new RegExp(`重组运行 ${RECOMPOSE_RUN} 还没有已受理提交`));
  }
});

test('one case accepted alone: its record is laid over its item, named by its digest; the other case waits on its own row', () => {
  const { records, context, runInput, items } = setup();
  const result = boundRecord('recomposition_result', 'validation_result', resultBody([recordRow('recompose-item-1', records[0]), recordRow('recompose-item-2', null, 'pending')]), 'e'.repeat(64));
  const answer = out(refresh(refreshInput(items, runInput, result, context)));
  const [first, second] = answer.items;
  assert.equal(first.late.recomposition.late, true);
  assert.equal(first.late.recomposition.receipt, 'rec:' + 'e'.repeat(64));
  assert.equal(first.late.recomposition.run, RECOMPOSE_RUN);
  assert.deepEqual(first.late.recomposition.record, records[0]);
  assert.equal(first.late.recomposition.record_sha256, digestOf(records[0]), 'sha256 of the canonical JSON of the record itself');
  assert.equal(first.late.recomposition_waiting, undefined);
  assert.deepEqual(second.late.recomposition_waiting, { run: RECOMPOSE_RUN, result: 'rec:' + 'e'.repeat(64), state: 'pending', item: 'recompose-item-2', autoid: items[1].fields.autoid });
  // Another case accepted later changes the receipt of the whole result, never the record digest of the first case.
  const later = boundRecord('recomposition_result', 'validation_result', resultBody([recordRow('recompose-item-1', records[0]), recordRow('recompose-item-2', records[1])]), '9'.repeat(64));
  const again = out(refresh(refreshInput(items, runInput, later, context)));
  assert.equal(again.items[0].late.recomposition.record_sha256, first.late.recomposition.record_sha256);
  assert.notEqual(again.items[0].late.recomposition.receipt, first.late.recomposition.receipt);
  assert.equal(again.items[1].late.recomposition.record_sha256, digestOf(records[1]));
});

test('a row absent from the result, an unsatisfied row and a partial record wait; a run that is not the bound one is a problem, not a wait', () => {
  const { records, context, runInput, items } = setup();
  const partial = { ...records[1], status: 'partial' };
  const result = boundRecord('recomposition_result', 'validation_result', resultBody([recordRow('recompose-item-1', null, 'unsatisfied'), recordRow('recompose-item-2', partial)]), 'e'.repeat(64));
  const answer = out(refresh(refreshInput(items, runInput, result, context)));
  assert.deepEqual(answer.items.map((row) => row.late.recomposition_waiting?.state), ['unsatisfied', 'partial']);
  const uncovered = out(refresh(refreshInput(items, runInput, boundRecord('recomposition_result', 'validation_result', resultBody([]), 'e'.repeat(64)), context)));
  assert.deepEqual(uncovered.items.map((row) => row.late.recomposition_waiting?.state), ['uncovered', 'uncovered']);
  // The frozen run record names another recompose run: waiting never makes it right, so the case carries the problem only.
  const otherRun = boundRecord('recomposition_run', 'run', { ...(runInput.model as any).body, run: 'run_01otherrecomposeaaaaaaaaaa' }, 'f'.repeat(64));
  const mismatch = out(refresh(refreshInput(items, otherRun, null, context)));
  for (const row of mismatch.items) {
    assert.equal(row.late.recomposition_waiting, undefined);
    assert.match(row.late.recomposition_problem, /两个槽写同一个重组运行/);
  }
});

test('items without the late marker get no overlay, and the output is the same for the same input (the Hub digests it)', () => {
  const { records, context, runInput, items } = setup();
  const frozen = { id: 'synthetic-map:frozen', label: '冻结', location: items[0].location, fields: { autoid: 'x', recomposition: { record: records[0] } } };
  const result = boundRecord('recomposition_result', 'validation_result', resultBody([recordRow('recompose-item-1', records[0])]), 'e'.repeat(64));
  const input = refreshInput([...items, frozen], runInput, result, context);
  const first = out(refresh(input)), second = out(refresh(structuredClone(input)));
  assert.deepEqual(first.items.map((row) => row.id), items.map((item) => item.id));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(Object.keys(first), ['items'], 'ItemRefreshOutput: {items:[{id, late}]}');
  for (const row of first.items) assert.deepEqual(Object.keys(row).sort(), ['id', 'late']);
});
