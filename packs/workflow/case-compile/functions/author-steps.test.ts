// The author steps of a recomposition record on synthetic records only: one function gives them to the fidelity brief and to every
// tool that has to say what a step of a plan realizes, so the two cannot name a step differently.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorStepsOf, fidelityBrief } from './fidelity.ts';

const RECORD = {
  schema: 'recompose-record@1',
  contract: { intent: { text: '合成意图：组件经 TCP 查询解析' } },
  atoms: [
    { id: 'a1', kind: 'intent', text: '合成意图：组件经 TCP 查询解析' },
    { id: 'a2', kind: 'action', text: '配置组件健康检查间隔 60' },
    { id: 'a3', kind: 'action', text: '客户端用 TCP 查询组件' },
    { id: 'a4', kind: 'expectation', text: '健康检查间隔设置成功' },
    { id: 'a5', kind: 'action', text: '原文被账本改写' },
  ],
  ledgers: {
    original: [{ atom: 'a2', text: '配置组件健康检查间隔 60' }, { atom: 'a5', text: '账本里的作者原文' }],
    adapted: [
      { atom: 'a2', action: 'parameter_change', text: '配置组件健康检查间隔 60（本环境组件）', commands: ['widget health interval 60'], equivalence_reason: '合成依据：换成本环境的组件' },
      { atom: 'a5', action: 'structural_completion', text: '', commands: [] },
    ],
    concretizations: [],
    rebindings: [],
  },
};
const PLAN = { bucket: 'bed-0', blocks: [], replacements: [], expects: [], steps: [{ object: 'widget-seat', method: 'cmd_config', args: ['widget health interval 60'], keywords: {} }] };

test('the author steps are the action atoms in record order: the adapted text where the atom was adapted, the author words beside it', () => {
  assert.deepEqual(authorStepsOf(RECORD), [
    { n: 'a2', text: '配置组件健康检查间隔 60（本环境组件）', author_text: '配置组件健康检查间隔 60', adapted_commands: ['widget health interval 60'], basis: '合成依据：换成本环境的组件' },
    { n: 'a3', text: '客户端用 TCP 查询组件' },
    { n: 'a5', text: '账本里的作者原文', author_text: '账本里的作者原文' },
  ], 'an intent and an expectation are not author steps; an adaptation without text leaves the author words');
});

test('the fidelity brief lists exactly these author steps, and a record without any gives none and no brief', () => {
  assert.deepEqual(fidelityBrief('doc-1:c-1', RECORD, PLAN)!.author_steps, authorStepsOf(RECORD));
  const noActions = { ...RECORD, atoms: RECORD.atoms.filter((atom) => atom.kind !== 'action') };
  assert.deepEqual(authorStepsOf(noActions), []);
  assert.equal(fidelityBrief('doc-1:c-1', noActions, PLAN), null);
  for (const record of [undefined, null, 'record', 7, [], {}, { atoms: 'a2' }]) assert.deepEqual(authorStepsOf(record), []);
  assert.deepEqual(authorStepsOf({ atoms: [null, 'a2', { kind: 'action' }, { id: 'a7', kind: 'action', text: '没有账本' }] }), [{ n: 'a7', text: '没有账本' }], 'what is no atom, or has no id, is passed over');
});

test('the text is cut where the brief cuts it, and the function does not change the record', () => {
  const long = '作'.repeat(2500);
  const record = { atoms: [{ id: 'a2', kind: 'action', text: long }], ledgers: { original: [], adapted: [] } };
  const before = JSON.stringify(record);
  const [step] = authorStepsOf(record);
  assert.equal(step!.text.length, 2000);
  assert.equal(JSON.stringify(record), before);
  assert.equal(fidelityBrief('doc-1:c-1', record, PLAN)!.author_steps[0]!.text.length, 2000);
});
