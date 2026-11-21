import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fidelityBrief, unknownAuthorStepRefs } from './fidelity.ts';

// Recompose records number author steps by atom id (a1, a2, ...); a plan that writes ordinals ("2") binds nothing.
const RECORD = {
  schema: 'recompose-record@1',
  contract: { intent: { text: '验证接口启用与静态路由' } },
  atoms: [
    { id: 'a1', kind: 'intent', text: '验证接口启用与静态路由' },
    { id: 'a2', kind: 'action', text: '配置接口 eth0 地址 192.0.2.10/24' },
    { id: 'a3', kind: 'action', text: '配置静态路由 198.51.100.0/24 下一跳 192.0.2.1' },
    { id: 'a4', kind: 'expectation', text: '路由表出现 198.51.100.0/24' },
  ],
  ledgers: { original: [], adapted: [], rebindings: [] },
};
const block = (refs: string[]) => ({ id: 'b', kind: 'CONFIG', call: { object: 'dut1', method: 'cmd_config', args: ['ip address 192.0.2.10/24'], keywords: {} }, author_step_refs: refs });

test('author_step_refs that are not author step ids of the case are named with their place and the ids to use', () => {
  const plan = { blocks: [block(['2']), block(['a3']), block(['a4'])], steps: [], expects: [] };
  const brief = fidelityBrief('doc:1', RECORD, plan)!;
  assert.deepEqual(brief.author_steps.map((s) => s.n), ['a2', 'a3']);
  assert.deepEqual(unknownAuthorStepRefs(brief, plan), [
    { pointer: '/blocks/0/author_step_refs/0', value: '2' },
    { pointer: '/blocks/2/author_step_refs/0', value: 'a4' },
  ]);
});

test('refs that name the case author steps pass, in blocks and in flat steps', () => {
  const blocks = { blocks: [block(['a2']), block(['a2', 'a3'])], steps: [], expects: [] };
  assert.deepEqual(unknownAuthorStepRefs(fidelityBrief('doc:1', RECORD, blocks)!, blocks), []);
  const flat = { blocks: [], steps: [{ object: 'dut1', method: 'cmd_config', args: ['x'], keywords: {}, author_step_refs: ['3'] }], expects: [] };
  assert.deepEqual(unknownAuthorStepRefs(fidelityBrief('doc:1', RECORD, flat)!, flat), [{ pointer: '/steps/0/author_step_refs/0', value: '3' }]);
});
