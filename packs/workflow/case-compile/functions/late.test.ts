import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LATE_FILE, readLate, readLateFile, recompositionOf, recompositionRecordOf, withLate } from './late.ts';
import { buildCaseIdSet } from './rework-history.ts';
import { planEnvelope } from './authoring-brief.ts';
import { planCases } from '../tools/fidelity-brief.ts';

const RUN = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', RECOMPOSE = 'run_01bbbbbbbbbbbbbbbbbbbbbbbb';
const record = { schema: 'recompose-record@1', case: { id: 'synthetic-case-7' }, atoms: [{ id: 'A1', kind: 'action', text: 'Configure interval 60' }, { id: 'E1', kind: 'expectation', text: 'Interval is 60' }], expectation_slots: [{ slot: 'e1', atom: 'E1' }], ledgers: { original: [{ atom: 'A1', text: 'Configure interval 60' }], adapted: [], rebindings: [] }, contract: { intent: { text: 'Configure interval' } } };
const proof = { record, receipt: 'rec:' + 'd'.repeat(64), late: true, record_sha256: 'f'.repeat(64) };
const late = (items: unknown[], over: Record<string, unknown> = {}) => ({ schema: 'run-late@1', run: RUN, run_reference: 'rec:' + 'c'.repeat(64), resolved_at: '2026-11-17T00:00:00.000Z', late: { inputs: [{ slot: 'recomposition_result', run: RECOMPOSE, reference: 'rec:' + 'd'.repeat(64) }], refresh: 'e'.repeat(64) }, items, ...over });
const lateItem = { id: 'doc:a', label: '合成', fields: { autoid: '990000000000000101', recomposition_late: { slot: 'recomposition_result', run: RECOMPOSE, source: 'src:' + 'a'.repeat(64), node: 'n/a' } } };

test('a run-late@1 answer is read whole or refused with the reason', () => {
  const good = late([{ id: 'doc:a', late: { recomposition: proof } }]);
  assert.deepEqual(readLate(good, RUN), good);
  assert.match(readLate(good, 'run_01zzzzzzzzzzzzzzzzzzzzzzzz') as string, /不是运行 run_01zzzzzzzzzzzzzzzzzzzzzzzz 的/);
  assert.match(readLate({ ...good, schema: 'run-late@2' }) as string, /schema/);
  assert.match(readLate(late([{ id: 'doc:a', late: {} }, { id: 'doc:a', late: {} }])) as string, /出现了两次/);
  assert.match(readLate(late([], { late: { inputs: [{ slot: 'recomposition_result', run: RECOMPOSE, reference: 'rec:' + 'd'.repeat(64) + '#/body' }], refresh: null } })) as string, /不带片段的 rec:/);
  assert.match(readLate(late([], { late: { inputs: [], refresh: 'x' } })) as string, /late 不是/);
});

test('late.json beside run.json: absent is no late binding, present is read, broken is refused with the way to get it again', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-late-'));
  assert.equal(readLateFile(directory, RUN), null);
  await writeFile(join(directory, LATE_FILE), JSON.stringify(late([])));
  assert.equal(readLateFile(directory, RUN)?.run, RUN);
  const refused = (pattern: RegExp) => (error: any) => pattern.test(error.message) && /refresh-late\.ts/.test(error.next_action);
  assert.throws(() => readLateFile(directory, 'run_01zzzzzzzzzzzzzzzzzzzzzzzz'), refused(/不是运行 run_01zzzzzzzzzzzzzzzzzzzzzzzz 的 run-late@1 答复/));
  await writeFile(join(directory, LATE_FILE), '{');
  assert.throws(() => readLateFile(directory, RUN), refused(/不是完整的 JSON/));
});

test('the recomposition of an item is the late overlay\'s when there is one, else the frozen field', () => {
  const doc = readLate(late([{ id: 'doc:a', late: { recomposition: proof } }, { id: 'doc:b', late: { recomposition_waiting: { state: 'no_result' } } }]), RUN);
  assert.ok(typeof doc !== 'string');
  assert.deepEqual(recompositionOf(lateItem, doc), proof);
  assert.deepEqual(recompositionRecordOf(withLate(lateItem, doc)), record, 'withLate attaches the overlay as the Hub does (SubjectItem.late)');
  assert.equal(recompositionOf({ ...lateItem, id: 'doc:b' }, doc), undefined, 'a waiting case has no record yet');
  const frozen = { id: 'doc:c', fields: { recomposition: { record: { case: { id: 'frozen' } }, receipt: 'rec:' + '1'.repeat(64) } } };
  assert.deepEqual(recompositionRecordOf(frozen, doc), { case: { id: 'frozen' } });
  assert.equal(withLate(frozen, doc), frozen, 'an item without an overlay is left as it is');
  assert.equal(recompositionOf(lateItem, null), undefined);
});

test('the tools that read a case\'s record read the late one: case ids, the plan envelope and the fidelity brief', async () => {
  const doc = readLate(late([{ id: 'doc:a', late: { recomposition: proof } }]), RUN);
  assert.ok(typeof doc !== 'string');
  const item = withLate(lateItem, doc);
  assert.ok(buildCaseIdSet('', item).has('synthetic-case-7'));
  const envelope = planEnvelope(item, 'bed-a') as any;
  assert.deepEqual(envelope.slots.plan[0].data.recomposition, { receipt: proof.receipt, record_sha256: proof.record_sha256, case_id: 'synthetic-case-7', slots: [{ slot: 'e1', assertions: [] }], rebindings: [] });
  assert.equal((planEnvelope({ ...lateItem }, 'bed-a') as any).slots.plan[0].data.recomposition, undefined);
  const run = join(await mkdtemp(join(tmpdir(), 'cc-late-brief-')), 'run'), plans = join(run, '..', 'plans');
  await mkdir(run, { recursive: true }); await mkdir(plans, { recursive: true });
  await writeFile(join(run, 'run.json'), JSON.stringify({ run: RUN, items: [lateItem] }));
  const plan = { bucket: 'bed-0', blocks: [], steps: [{ object: 'Device_0', method: 'cli', args: ['interval 60'], keywords: {} }], expects: [{ text: '60', quote: { text: 'Interval is 60', reference: 'doc:a#1' }, after: 1 }], replacements: [] };
  await writeFile(join(plans, '01.json'), JSON.stringify({ item: 'doc:a', handling: 'handled', slots: { plan: [{ text: 'p', quotes: [], data: plan }] } }));
  const waiting = await planCases(run, plans);
  assert.deepEqual([waiting.cases.length, waiting.skipped.length], [0, 1], 'without late.json the case has no record to brief yet');
  await writeFile(join(run, LATE_FILE), JSON.stringify(doc));
  const briefed = await planCases(run, plans);
  assert.deepEqual(briefed.cases.map((row) => [row.item, row.brief.author_steps.map((step) => step.n)]), [['doc:a', ['A1']]]);
});
