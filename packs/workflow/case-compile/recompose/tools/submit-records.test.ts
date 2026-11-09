import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordFor, submissionFor } from './submit-records.ts';

const atom = (id: string, kind: string, text: string, after: string[] = []) => ({ id, kind, text, content: text, reference: `src:${'a'.repeat(64)}/kityminder@1/n/${id}`, selector: `n/${id}`, node_id: id, start: 0, end: text.length, labels: [], explicit_labels: [], number_label: null, after });
const item = (id = 'n/case') => ({ id, fields: { case_id: 'ORBIT-1', source_ref: 'src:' + 'a'.repeat(64), node: 'n/case', atoms: [atom('a1', 'action', '合成动作一'), atom('a2', 'action', '合成动作二'), atom('a3', 'expectation', '合成期望', ['a2'])] } });
const method = { kind: 'declared', text: '合成方法', sources: ['ref'], basis: '合成依据' };

test('the tool fills what the projection knows, so the model never retypes author text', () => {
  const record = recordFor(item(), { method }, 'scripted');
  assert.deepEqual(record.atoms.map((a: any) => a.text), ['合成动作一', '合成动作二', '合成期望']);
  assert.deepEqual(record.ledgers.original.map((a: any) => a.atom), ['a1', 'a2', 'a3']);
  assert.deepEqual(record.contract.intent, { text: '合成动作一', quote_ref: atom('a1', 'action', '').reference, verbatim: true });
  assert.equal(record.contract.expectation.text, '合成期望');
  assert.deepEqual(record.coverage, { author_atoms: ['a1', 'a2', 'a3'], mapped: { a2: ['e1'], a3: ['e1'] }, unmapped: ['a1'] });
  assert.deepEqual(record.expectation_slots.map((s: any) => [s.slot, s.atom, s.knowledge_location]), [['e1', 'a3', 'has_verification_knowledge']]);
  assert.deepEqual(record.sources.states.map((s: any) => s.state), ['settled', 'settled', 'settled']);
  assert.equal(record.status, 'complete');
});

test('what the model judged replaces only the atom it names', () => {
  const record = recordFor(item(), { method, states: [{ atom: 'a2', state: 'missing_prerequisite', reason: '功能默认关闭', prerequisites: ['先打开'] }], slots: [{ atom: 'a3', knowledge_location: 'genuinely_missing', proposal: '只有结果标签' }], unknowns: [{ missing: 'x', next_action: 'y', audience: 'z', due: 'w' }] }, 'scripted');
  assert.deepEqual(record.sources.states.map((s: any) => s.state), ['settled', 'missing_prerequisite', 'settled']);
  assert.equal(record.sources.states[1].exit.owner, '编写模型');
  assert.deepEqual(record.sources.states[1].prerequisites, ['先打开']);
  assert.equal(record.expectation_slots[0].knowledge_location, 'genuinely_missing');
  assert.equal(record.expectation_slots[0].slot, 'e1');
  assert.equal(record.unknowns.length, 1);
});

test('a candidate never signs, and an atom the case does not have is refused', () => {
  assert.equal(recordFor(item(), { method, candidates: [{ ref: 'x', signing_authority: true }] }, 'scripted').sources.candidates[0].signing_authority, false);
  assert.throws(() => recordFor(item(), { method, states: [{ atom: 'a9', state: 'conflict' }] }, 'scripted'), /没有这条用例原句/);
  assert.throws(() => recordFor(item(), { method, slots: [{ atom: 'a1' }] }, 'scripted'), /不是该条目里期望的用例原句/);
  assert.throws(() => recordFor(item(), {}, 'scripted'), /缺 method/);
});

test('a submission covers every frozen case, and only those', () => {
  const run = { run: 'run_x', items: [item('one'), item('two')] };
  assert.throws(() => submissionFor(run, [{ item: 'one', method }], 'scripted'), /还有 1 个用例没有文件：two/);
  assert.throws(() => submissionFor(run, [{ item: 'one', method }, { item: 'two', method }, { item: 'three', method }], 'scripted'), /不是这个运行的条目/);
  const sent = submissionFor(run, [{ item: 'one', method }, { item: 'two', method }], 'scripted');
  assert.equal(sent.items.length, 2);
  assert.equal(sent.items[0].slots.record[0].quotes.length, 3);
});
