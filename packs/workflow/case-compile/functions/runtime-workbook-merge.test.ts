import {addressInput} from '../testing/typed-fixtures.ts';
// Semantic merge regressions across runtime policy and workbook integer encoding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generationFixture } from '../testing/workbook.ts';
import { extraParameterForMerge } from '../testing/merge-fixture.ts';
import { checkContractShape, checkAddresses } from './checks.ts';
import { generateWorkbook, GenerationError } from './generate.ts';
import { coreModel, workbookCheckInput } from '../testing/workbook-model.ts';
import { readWorkbook } from './workbook.ts';
import { subjectOf } from './test-support.ts';
test('merged integer keyword durations stay ordinary values on a command method', () => {
  const value = extraParameterForMerge();
  assert.equal(checkContractShape(subjectOf(value.recipe.slots, value.raw))[0].verdict, 'support');
  const bytes = generateWorkbook(value.recipe); assert.equal(readWorkbook(coreModel(bytes), value.recipe).ok, true);
});
test('merged generator rejects assertion values which runtime cannot satisfy', () => {
  for (const text of ['=bad', '{}', 'first\nsecond']) { const recipe = generationFixture(); recipe.slots.expects[0].text = text; recipe.slots.expects[0].quote.text = text; assert.throws(() => generateWorkbook(recipe), GenerationError); }
});
test('decision 35 permits other device interfaces in workbook-bound plans', () => {
  assert.equal(checkAddresses(addressInput('192.0.2.1'))[0].verdict,'support');
});
