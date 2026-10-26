import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkContractShape } from './checks.ts';
import { goodData, subjectOf } from './test-support.ts';
test('enabled and permitted original calls pass without copying defaults', () => assert.equal(checkContractShape(subjectOf(goodData()))[0].verdict, 'support'));
for (const [name, mutate, code] of [
  ['disabled', (v: any) => { v.steps[0].object = 'widget-disabled'; v.steps[0].method = 'cycle'; }, 'method_forbidden'],
  ['internal', (v: any) => { v.steps[0].method = 'hidden'; }, 'method_forbidden'],
  ['candidate', (v: any) => { v.steps[0].method = 'candidate'; }, 'method_forbidden'],
  ['empty call', (v: any) => { v.steps[0].method = 'credential'; v.steps[0].args = []; }, 'method_not_allowed'],
  ['extra keyword', (v: any) => { v.steps[0].keywords.extra = 'x'; }, 'param_arity'],
  ['missing required', (v: any) => { v.steps[0].args = []; }, 'param_arity'],
  ['positional only', (v: any) => { v.steps[0].keywords.line = v.steps[0].args[0]; v.steps[0].args = []; }, 'param_keyword'],
  ['multiline', (v: any) => { v.steps[0].args = ['widget health\ninterval 60']; }, 'param_value'],
  ['placeholder', (v: any) => { v.steps[0].args = ['widget {}']; }, 'param_value'],
  ['indexed placeholder', (v: any) => { v.steps[0].args = ['widget {0}']; }, 'param_value'],
  ['formula', (v: any) => { v.steps[0].args = ['=1']; }, 'param_value'],
  ['whitespace', (v: any) => { v.steps[0].args = [' widget health interval 60']; }, 'param_value'],
  ['device denial', (v: any) => { v.steps[0].args = ['system cycle']; }, 'device_command_denied'],
  ['host denial', (v: any) => { v.steps[1].args = ['sudo reboot']; }, 'host_command_denied'],
] as const) test(`plan rule: ${name}`, () => { const data = goodData(); mutate(data); const outcomes=checkContractShape(subjectOf(data));if(name==='device denial'){assert.ok(outcomes.some(v=>v.verdict==='refute'&&v.code==='case-compile.method_forbidden'));}else{assert.ok(outcomes.some(v=>v.code==='case-compile.method_forbidden'&&Array.isArray(v.data?.problems)),JSON.stringify(outcomes));} });
test('credential-marked optional parameters cannot be supplied to an otherwise allowed call', () => {
  const data = goodData(); data.steps[0].keywords.auth_token = 'synthetic-placeholder';
  assert.ok(checkContractShape(subjectOf(data)).some((v) => v.code === 'case-compile.method_forbidden' && v.statement.includes('脱敏')));
});
test('assertion calls cannot bypass the single grounded expects source', () => {
  const data = goodData(); data.steps.push({ object: 'widget-check', method: 'literal', args: ['未经溯源的断言'], keywords: {} });
  const outcome = checkContractShape(subjectOf(data)).find((v) => v.code === 'case-compile.assertion_in_steps');
  assert.ok(outcome); assert.match(outcome.statement, /断言写进 expects，带引文和 after/);
});
