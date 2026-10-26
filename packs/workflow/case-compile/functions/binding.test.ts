import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindArguments } from './binding.ts';
import type { RuntimeEntry } from './runtime-contract.ts';
const method: RuntimeEntry = { object: 'fixture-object', method: 'fixture-method', dispatch: 'direct_method_call', parameters: [
  { name: 'first', kind: 'positional_only', required: true, redacted: false },
  { name: 'second', kind: 'positional_or_keyword', required: false, redacted: false },
  { name: 'more', kind: 'var_positional', required: false, redacted: false },
  { name: 'named', kind: 'keyword_only', required: true, redacted: false },
  { name: 'other', kind: 'var_keyword', required: false, redacted: false },
] };
test('original Python signature kinds bind without inferring types or adding defaults', () => {
  const result = bindArguments(method, { object: method.object, method: method.method, args: ['one'], keywords: { named: 'two' } }, '/step');
  assert.deepEqual(result.problems, []); assert.deepEqual(result.values.map((v) => v.name), ['first', 'named']);
  assert.deepEqual(bindArguments(method, { object: method.object, method: method.method, args: ['one', 'two', 'three'], keywords: { named: 'four' } }, '/step').problems, []);
});
test('variadic keywords do not authorize undeclared keyword names in this round', () => {
  const result = bindArguments(method, { object: method.object, method: method.method, args: ['one'], keywords: { named: 'two', unlisted: 'three' } }, '/step');
  assert.ok(result.problems.some((v) => v.code === 'param_arity'));
});
test('the same positional-or-keyword value cannot be passed twice', () => {
  const result = bindArguments(method, { object: method.object, method: method.method, args: ['one', 'two'], keywords: { second: 'three', named: 'four' } }, '/step');
  assert.ok(result.problems.some((v) => v.code === 'param_arity'));
});
