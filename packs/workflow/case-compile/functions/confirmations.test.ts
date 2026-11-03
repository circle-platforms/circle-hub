// Declared confirmations, net-effect cleanup and declared text shapes (the case-compile-ssl-teardown task, decision 104).
// Synthetic commands and values only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCommandsKnown } from './checks.ts';
import { valueProblem } from './typed-contract.ts';
import { fixture, cleanup } from '../testing/confirmations.ts';

const supported = (value: unknown) => { const result = checkCommandsKnown(value); assert.ok(result.every(row => row.verdict === 'support'), JSON.stringify(result)); };
const refused = (value: unknown, text: string) => { const result = checkCommandsKnown(value); assert.ok(result.some(row => row.verdict === 'refute' && row.statement.includes(text)), JSON.stringify(result)); };

test('a declared confirmation passes with the declared prompt and the answer as the next step, and the answer is not a command', () => {
  supported(fixture(['demo host virtual h1 vs1', cleanup('clear demo host h1', 'abort:'), cleanup('YES')]));
});

test('a declared confirmation without its prompt, without its answer or with another answer is refused', () => {
  refused(fixture(['demo host virtual h1 vs1', cleanup('clear demo host h1'), cleanup('YES')]), '该命令需要设备确认');
  refused(fixture(['demo host virtual h1 vs1', cleanup('clear demo host h1', 'abort:')]), '该命令需要设备确认');
  refused(fixture(['demo host virtual h1 vs1', cleanup('clear demo host h1', 'abort:'), cleanup('NO')]), '该命令需要设备确认');
  refused(fixture(['demo host virtual h1 vs1', cleanup('clear demo host h1', 'other:'), cleanup('YES')]), '该命令需要设备确认');
});

test('a runner prompt on an undeclared command and an answer without its command are refused', () => {
  refused(fixture([{ line: 'demo pool add p1 5', prompt: 'abort:' }, cleanup('no demo pool add p1')]), '运行器提示符参数只用于产品声明需要设备确认的命令');
  const result = checkCommandsKnown(fixture(['YES']));
  assert.ok(result.some(row => row.verdict !== 'support'), JSON.stringify(result));
});

test('without declared confirmations a runner prompt on a device command is refused', () => {
  const { confirmations: _none, ...plain } = { ...(fixture([]).subject.command_catalog as any).policy };
  refused(fixture([{ line: 'demo pool add p1 5', prompt: 'abort:' }, cleanup('no demo pool add p1')], plain), '运行器提示符参数只用于产品声明需要设备确认的命令');
});

test('net effect: an execution step that is the declared inverse of a live earlier one undoes it, so only the last state is cleaned', () => {
  supported(fixture(['demo pool add p1 5', 'no demo pool add p1', 'demo pool add p1 6', cleanup('no demo pool add p1')]));
  supported(fixture(['demo pool add p1 5', 'no demo pool add p1']));
  refused(fixture(['demo pool add p1 5', 'no demo pool add p1', cleanup('no demo pool add p1')]), '清理段含没有对应执行命令的额外配置操作');
});

test('net effect keeps every live configuration: a delete of something the plan never created still needs its own cleanup', () => {
  const result = checkCommandsKnown(fixture(['no demo pool add p1']));
  assert.ok(result.some(row => row.verdict !== 'support'), JSON.stringify(result));
  refused(fixture(['demo pool add p1 5', 'demo pool add p2 6', 'no demo pool add p1']), '缺同设备、逆序的清理操作');
});

test('a host load and start tear down in reverse order: stop, then the confirmed clear', () => {
  supported(fixture(['demo host virtual h1 vs1', 'demo start h1', cleanup('demo stop h1'), cleanup('clear demo host h1', 'abort:'), cleanup('YES')]));
  refused(fixture(['demo host virtual h1 vs1', 'demo start h1', cleanup('clear demo host h1', 'abort:'), cleanup('YES'), cleanup('demo stop h1')]), '缺同设备、逆序的清理操作');
});

test('a declared text shape refuses values outside the anchored expression', () => {
  const type = { declaration: { name: 'host_name', catalog_type: 'string', declaration: 'src:' + 'd'.repeat(64), grammar: 'runtime-contract@2' }, pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$' } as any;
  assert.equal(valueProblem(type, 'sslhost_1'), null);
  assert.equal(valueProblem(type, 'a b'), '不符合声明的文字形状');
  assert.equal(valueProblem(type, '"quoted"'), '不符合声明的文字形状');
});
