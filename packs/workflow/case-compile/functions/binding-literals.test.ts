// D03/D05: binding follows the original signature; G syntax is not a declaration of shell semantics for every value.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindArguments, hasBalancedCommandText } from './binding.ts';
import { encodeG, decodeG } from './g-syntax.ts';
import type { RuntimeEntry } from './runtime-contract.ts';
const method: RuntimeEntry = { object: 'synthetic-object', method: 'literal-value', dispatch: 'direct_method_call', parameters: [{ name: 'value', kind: 'positional_only', required: true, redacted: false }] };
for (const value of ["can't", 'C:\\synthetic\\']) test(`binding preserves a G-encodable literal ${JSON.stringify(value)} without shell classification`, () => {
  const arguments_ = { args: [value], keywords: {} };
  const decoded = decodeG(encodeG(arguments_));
  assert.deepEqual(decoded.args, arguments_.args);
  assert.deepEqual(Object.entries(decoded.keywords), []);
  const bound = bindArguments(method, { object: method.object, method: method.method, ...arguments_ }, '/steps/0');
  assert.deepEqual(bound.problems, []);
  assert.deepEqual(bound.values, [{ name: 'value', value, pointer: '/steps/0/args/0' }]);
});
test('the explicit POSIX command lexer still refuses an unmatched quote without normalizing glyphs', () => {
  assert.equal(hasBalancedCommandText("echo 'unterminated"), false);
  assert.equal(hasBalancedCommandText('echo ＂'), true);
});
