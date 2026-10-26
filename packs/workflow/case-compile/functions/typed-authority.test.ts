import {parseProfile} from './profile.ts';
// R5: signature metadata and local roles do not establish original parameter types or authorized effects.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { checkContractShape, checkAddresses, checkExpectedSources } from './checks.ts';
import { generateWorkbook } from './generate.ts';
import checkWorkbook from './workbook.ts';
import checkDispatch from './dispatch-policy.ts';
import { generationFixture } from '../testing/workbook.ts';
import { workbookCheckInput } from '../testing/workbook-model.ts';
import { goodData, subjectOf, LEGACY_CONTRACT_DOC, LEGACY_PROFILE_DOC, contractOf, bedsOf } from './test-support.ts';
import type { Outcome } from './text.ts';

const frozen = JSON.parse(readFileSync(new URL('../testing/legacy-untyped-workbook.json', import.meta.url), 'utf8')) as { base64: string; sha256: string };
const legacyBytes = Buffer.from(frozen.base64, 'base64');
const missingAuthority = (outcomes: Outcome[]) => {
  assert.ok(outcomes.some(outcome => outcome.verdict === 'unknown' && outcome.reason === 'missing_input' && typeof outcome.missing === 'string' && outcome.missing.length > 0), JSON.stringify(outcomes));
  assert.ok(outcomes.every(outcome => outcome.verdict !== 'support'), 'absence of typed facts cannot support a release');
};
for (const [name, check] of [['contract_methods', checkContractShape], ['bed_addresses', checkAddresses], ['expected_grounded', checkExpectedSources]] as const) {
  test(`signature-only legacy authority leaves ${name} unchecked with a missing-input recovery`, () => missingAuthority(check(subjectOf(goodData(),{contractDoc:LEGACY_CONTRACT_DOC,profileDoc:LEGACY_PROFILE_DOC}))));
}
test('the client generator refuses signature-only authority despite reviewed local roles', () => {
  const recipe=generationFixture(),contract=contractOf(LEGACY_CONTRACT_DOC),profile=parseProfile(LEGACY_PROFILE_DOC,contract,bedsOf());assert.ok(profile.ok);if(profile.ok)assert.throws(()=>generateWorkbook({...recipe,contract,profile:profile.profile}));
});
test('a frozen legacy workbook cannot acquire verification or dispatch support', () => {
  assert.equal(createHash('sha256').update(legacyBytes).digest('hex'), frozen.sha256, 'the historical fixture is not rewritten');
  const input = workbookCheckInput(legacyBytes);input.subject.contract=LEGACY_CONTRACT_DOC as never;input.subject.profile=LEGACY_PROFILE_DOC;
  missingAuthority(checkWorkbook(input));
  missingAuthority(checkDispatch(input));
});
