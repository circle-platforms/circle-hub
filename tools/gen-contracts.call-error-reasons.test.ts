import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { validateInputs } from './gen-contracts.ts';

const model = () => JSON.parse(readFileSync(new URL('../contracts/model.json', import.meta.url), 'utf8'));
const codes = JSON.parse(readFileSync(new URL('../contracts/codes.json', import.meta.url), 'utf8'));

test('the generator validates reason-axis coverage and every exact classification before emission', () => {
  assert.deepEqual(validateInputs(model(), codes), []);
  for (const mutate of [
    (input: any) => { input.formatProposals.callErrorReasons.pop(); },
    (input: any) => { input.formatProposals.callErrorReasons[0].classification.unknown = true; },
    (input: any) => { input.formatProposals.callErrorReasons[0].classification.category = 'sixth'; },
    (input: any) => { delete input.formatProposals.callErrorReasons[0].next_by_role.admin; },
    (input: any) => { input.formatProposals.callErrorReasons[0].codes.push(input.formatProposals.callErrorReasons[0].codes[0]); },
  ]) {
    const input = model(); mutate(input);
    assert.ok(validateInputs(input, codes).some(problem => problem.includes('callErrorReasons')));
  }
});

test('the generator reads actual model roles instead of its previously generated snapshot', () => {
  const input = model();
  input.vocabulary.find((axis: { axis: string }) => axis.axis === 'permission_role').values.push({ code: 'synthetic_role', label: '合成测试角色' });
  for (const row of input.formatProposals.callErrorReasons) row.next_by_role.synthetic_role = '合成下一步';
  assert.deepEqual(validateInputs(input, codes), []);
});
