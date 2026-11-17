import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostProgramLine } from './binding.ts';
import { checkAddresses, checkContractShape } from './checks.ts';
import { hostInput, hostProgramInput } from '../testing/typed-fixtures.ts';

const programs = [{ program: 'dig', address_prefix: '@' }];
const compiled = [{ program: 'dig', addressPrefix: '@' }];
const verdicts = (outcomes: Array<{ verdict: string; code?: string }>) => outcomes.map((row) => row.verdict);
const refused = (outcomes: Array<{ verdict: string; code?: string }>) => outcomes.filter((row) => row.verdict === 'refute');
const name = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;

test('a declared program runs with its own static arguments, a long name and options included', () => {
  for (const line of ['dig @192.0.2.90 example.test', `dig @192.0.2.90 ${name} A +short`, `dig @192.0.2.90 ${name} +tcp`]) {
    assert.deepEqual(refused(checkContractShape(hostProgramInput(line, programs))), [], line);
  }
});

test('a program the contract does not declare stays refused, as the literal list alone refused it', () => {
  for (const line of ['rm -rf /', 'curl http://192.0.2.90/', 'digger @192.0.2.90 example.test', '/usr/bin/dig @192.0.2.90 example.test']) {
    assert.ok(refused(checkContractShape(hostProgramInput(line, programs))).length, line);
  }
});

test('without declared programs only the full literal passes', () => {
  assert.ok(refused(checkContractShape(hostProgramInput('dig @192.0.2.90 example.test', []))).length);
  assert.deepEqual(refused(checkContractShape(hostInput('dig @192.0.2.90 example.test'))), []);
});

test('shell expansion, separators and redirection are refused even after a declared program', () => {
  for (const line of ['dig @192.0.2.90 example.test; reboot', 'dig @192.0.2.90 $(hostname)', 'dig @192.0.2.90 `id`', 'dig @192.0.2.90 example.test > /tmp/x', 'dig @192.0.2.90 example.test | tee x', 'dig @192.0.2.90 example.test && reboot']) {
    assert.equal(hostProgramLine(compiled, line), null, line);
    assert.ok(refused(checkContractShape(hostProgramInput(line, programs))).length, line);
  }
});

test('the word after a declared address prefix must be an address', () => {
  assert.equal(hostProgramLine(compiled, 'dig @not-an-address example.test'), null);
  assert.ok(refused(checkContractShape(hostProgramInput('dig @not-an-address example.test', programs))).length);
  assert.deepEqual(hostProgramLine(compiled, 'dig @192.0.2.90 @3ffd::70 example.test')?.addresses, ['192.0.2.90', '3ffd::70']);
});

test('an address in a declared position is checked against the environment like any other', () => {
  assert.deepEqual(refused(checkAddresses(hostProgramInput('dig @192.0.2.90 example.test', programs))), []);
  const off = checkAddresses(hostProgramInput('dig @198.51.100.9 example.test', programs));
  assert.ok(refused(off).some((row) => row.code === 'case-compile.address_off_bed'), JSON.stringify(verdicts(off)));
});

test('a word that only looks like an address is not one unless it sits in the declared position', () => {
  assert.deepEqual(hostProgramLine(compiled, 'dig @192.0.2.90 198.51.100.9.example.test')?.addresses, ['192.0.2.90']);
  assert.deepEqual(hostProgramLine([{ program: 'dig' }], 'dig @198.51.100.9 example.test')?.addresses, []);
});
