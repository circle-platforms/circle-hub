import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { validateInputs } from './gen-contracts.ts';

const model = () => JSON.parse(readFileSync(new URL('../contracts/model.json', import.meta.url), 'utf8'));
const codes = JSON.parse(readFileSync(new URL('../contracts/codes.json', import.meta.url), 'utf8'));

test('every protocol code explicitly declares a closed call-error category or null', () => {
  assert.deepEqual(validateInputs(model(), codes), []);
  for (const value of [undefined, 'unknown', '参数无效', 'INVALID_PARAMETERS', false]) {
    const input = model();
    if (value === undefined) delete input.formatProposals.protocolCodes[0].callErrorCategory;
    else input.formatProposals.protocolCodes[0].callErrorCategory = value;
    assert.ok(validateInputs(input, codes).some(problem => problem.includes('callErrorCategory')));
  }
  const input = model();
  input.formatProposals.protocolCodes[0].callErrorCategory = null;
  assert.deepEqual(validateInputs(input, codes), []);
});

test('the call-error axis is required and category references track its exact values', () => {
  const absent = model();
  absent.vocabulary = absent.vocabulary.filter((axis: { axis: string }) => axis.axis !== 'call_error_category');
  assert.ok(validateInputs(absent, codes).some(problem => problem.includes('call_error_category')));
  const renamed = model();
  const axis = renamed.vocabulary.find((value: { axis: string }) => value.axis === 'call_error_category');
  axis.values.find((value: { code: string }) => value.code === 'invalid_parameters').code = 'renamed_parameter';
  assert.ok(validateInputs(renamed, codes).some(problem => problem.includes('callErrorCategory')));
});
