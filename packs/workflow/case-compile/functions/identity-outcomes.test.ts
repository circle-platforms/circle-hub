import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkContractShape, checkAddresses, checkExpectedSources } from './checks.ts';
import { CONTRACT_DOC, PROFILE_DOC, goodData, subjectOf } from './test-support.ts';
for (const synthetic of [true, false]) test(`every pack conclusion discloses its actual basis and execution limit: ${synthetic}`, () => {
  const input = subjectOf(goodData(), { profileDoc: { ...PROFILE_DOC, synthetic } });
  for (const check of [checkContractShape, checkAddresses, checkExpectedSources]) for (const result of check(input)) {
    assert.equal(result.verdict, 'support');
    assert.ok(result.statement.includes(synthetic ? '按合成合约核对' : '按发布的运行器合约核对'));
    assert.ok(result.statement.includes(CONTRACT_DOC.original.contract_sha256.slice(0, 12)));
    assert.ok(result.statement.includes('不证明在真实设备上跑得通'));
  }
  const result = checkContractShape(input)[0];
  assert.deepEqual(result.data, { runtime_version: CONTRACT_DOC.runtime.minimum_version, contract_sha256: CONTRACT_DOC.original.contract_sha256 });
});
test('a signature rejection carries the same qualification and cannot provide an identity support receipt', () => {
  const data = goodData(); data.steps[0].args = [];
  const results = checkContractShape(subjectOf(data)); assert.ok(results.every((v) => v.verdict === 'refute' && Array.isArray(v.data?.problems)));
});
