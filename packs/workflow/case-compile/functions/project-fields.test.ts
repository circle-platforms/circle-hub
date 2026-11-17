// What an item carries for the plan author (the bed as the checks read it, the precondition leaves of the case) and the cases a
// whole-document run may leave out. Synthetic names only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectItems } from './project.ts';
import { analyzeStructure } from './compile-structure.ts';
import { MANIFEST_DOC } from './test-support.ts';
import { runtimeDocument, profileDocument } from '../testing/runtime.ts';

const SHA = 'a'.repeat(64), FIRST = '990000000000000031', SECOND = '990000000000000032';
const node = (text: string, data: Record<string, unknown>, children: number[], selector: string) => ({ text, data, children, selector });
/** Case one has a priority-3 leaf beside its step; case two has none. */
const model = () => ({ nodes: [
  node('合成文档', { id: 'doc' }, [1, 5], 'n/doc'),
  node('合成用例一', { id: 'c1', resource: ['功能'], autoid: FIRST, auto: '01', priority: '02' }, [2, 3], 'n/c1'),
  node('功能已启用', { id: 'p1', priority: 3 }, [], 'n/p1'),
  node('执行 widget health interval 60', { id: 's1' }, [4], 'n/s1'),
  node('期望成功', { id: 'e1' }, [], 'n/e1'),
  node('合成用例二', { id: 'c2', resource: ['功能'], autoid: SECOND, auto: '01', priority: '02' }, [6], 'n/c2'),
  node('执行 widget health interval 60', { id: 's2' }, [7], 'n/s2'),
  node('期望成功', { id: 'e2' }, [], 'n/e2'),
] });
const input = (parameters: Record<string, unknown> = {}) => ({ inputs: [{ slot: 'subject', sha256: SHA, parser: 'kityminder@1', model: model() }, { slot: 'contract', model: runtimeDocument() }, { slot: 'profile', model: profileDocument() }, { slot: 'inventory', model: MANIFEST_DOC }], parameters, context: { leases: { now: '2026-10-23T02:00:00.000Z', entries: [] } } });
const items = (parameters?: Record<string, unknown>) => (projectItems(input(parameters)) as { items: Array<{ summary: string; fields: Record<string, any> }> }).items;
const refused = (parameters: Record<string, unknown>) => (projectItems(input(parameters)) as { error?: { code: string } }).error?.code;

test('an item lists the precondition leaves of its case, each named by the reference a plan quotes back', () => {
  const [first, second] = items();
  assert.deepEqual(first.fields.preconditions, [{ reference: `src:${SHA}/kityminder@1/n/p1`, text: '功能已启用' }]);
  assert.deepEqual(second.fields.preconditions, []);
  assert.match(first.summary, /前置叶子 1 条，计划要逐条声明由哪些步骤建立/); assert.doesNotMatch(second.summary, /前置叶子/);
  // The structure projection reads the same leaf as an action atom: the two derivations stay on the same table value.
  const atoms = analyzeStructure(model(), SHA).cases[0].atoms;
  assert.ok(atoms.some((atom) => atom.kind === 'action' && atom.reference === first.fields.preconditions[0].reference));
});

test('an item carries the bed as the checks read it: listeners with the hosts that reach them, blind addresses, services', () => {
  const bed = items()[0].fields.bed;
  assert.deepEqual(bed.trigger_types, ['client', 'router']);
  assert.deepEqual(bed.listeners, [
    { address: '192.0.2.10', device: 'dut0', hosts: [] },
    { address: '192.0.2.74', device: 'dut0', hosts: [{ object: 'widget-host', method: 'shell', device: 'client0' }] },
    { address: '2001:db8:1::10', device: 'dut0', hosts: [] },
  ]);
  assert.deepEqual(bed.blind, ['192.0.2.130']);
  assert.deepEqual(bed.services, [{ address: '192.0.2.80', service: 'client0:9000/tcp' }, { address: '192.0.2.90', service: 'server0:80/tcp' }]);
});

test('parameters.exclude leaves cases out of a whole-document run, and only there', () => {
  assert.deepEqual(items({ exclude: [FIRST] }).map((item) => item.fields.autoid), [SECOND]);
  assert.equal(refused({ exclude: [FIRST], autoid: SECOND }), 'case-compile.invalid_parameter', 'exclude and autoid do not go together');
  for (const bad of [[], [FIRST, FIRST], ['not-an-autoid'], 'x']) assert.equal(refused({ exclude: bad }), 'case-compile.invalid_parameter', JSON.stringify(bad));
  assert.equal(refused({ exclude: ['990000000000000099'] }), 'case-compile.autoid_not_found', 'an autoid the rule does not take');
  assert.equal(refused({ exclude: [FIRST, SECOND] }), 'case-compile.autoid_not_found', 'nothing left to compile');
});
