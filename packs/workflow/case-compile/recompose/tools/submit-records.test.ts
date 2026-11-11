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

test("a user's ruling stays in the fields the file already has: the atom's state reason, the adapted step and who decided the value", () => {
  const ruling = '用户裁定：以手册为准，改成手册允许的写法';
  const record = recordFor(item(), {
    method,
    states: [{ atom: 'a2', state: 'settled', reason: ruling }],
    adapted: [{ atom: 'a2', action: 'parameter_change', text: '合成动作二（改名）', commands: ['widget name peer_b'], equivalence_reason: ruling, equivalence_refs: [`tree:${'b'.repeat(64)}/manual/guide/names@${'1'.repeat(64)}`] }],
    concretizations: [{ atom: 'a2', slot: 'peer_name', value: 'peer_b', value_ref: `tree:${'b'.repeat(64)}/manual/guide/names@${'1'.repeat(64)}`, decided_by: '用户', source_kind: 'catalog' }, { atom: 'a2', slot: 'mode', value: 'full', value_ref: 'ref', source_kind: 'catalog' }],
  }, 'scripted');
  assert.deepEqual(record.sources.states.map((s: any) => [s.state, s.reason]), [['settled', '模型没有提出缺口'], ['settled', ruling], ['settled', '模型没有提出缺口']]);
  assert.equal(record.sources.states[1].adjudicated_by, null, 'a user’s ruling names no independent adjudication');
  assert.equal(record.ledgers.adapted[0].equivalence_reason, ruling);
  assert.deepEqual(record.ledgers.concretizations.map((c: any) => c.decided_by), ['用户', 'scripted'], 'the model’s name is the default, the user is kept when the file names the user');
  // A case left for the author: an underdetermined atom and a gap with a named audience; the record stays complete.
  const waiting = recordFor(item(), { method, states: [{ atom: 'a2', state: 'underdetermined', reason: '用户裁定：保留作者原样，这条先不编，待作者裁定' }], unknowns: [{ missing: '作者步骤与手册冲突', next_action: '作者或用户裁定', audience: '作者或用户', due: '交付之前' }] }, 'scripted');
  assert.deepEqual([waiting.sources.states[1].state, waiting.status, waiting.unknowns.length], ['underdetermined', 'complete', 1]);
});
