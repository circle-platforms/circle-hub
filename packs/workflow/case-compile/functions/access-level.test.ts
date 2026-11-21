import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCommandsKnown, checkContractShape } from './checks.ts';
import { parseRuntimeContract, refusedAccess } from './runtime-contract.ts';
import { planSubject } from './subject.ts';
import { goodData, AUTOID, COMMAND_CATALOG, CONTRACT_DOC, MANIFEST_DOC, PROFILE_DOC, QUOTE } from './test-support.ts';
import { signTypedRuntime } from '../testing/typed-fixtures.ts';

const SHA = 'b'.repeat(64);
const REFUSED = { source: 'synthetic-framework/lib/seat.py', sha256: SHA, rows: [{ object: 'widget-seat', method: 'configure', access: ['DEMO_LEVEL_CONFIG'] }] };
const contractWith = (refused?: unknown) => signTypedRuntime({ ...structuredClone(CONTRACT_DOC), ...(refused === undefined ? {} : { refused_access: refused }) } as Record<string, unknown>);
function catalogWith(level?: string) {
  const entries = structuredClone(COMMAND_CATALOG.entries) as Array<{ signatures: Array<Record<string, unknown>> }>;
  for (const entry of entries) for (const signature of entry.signatures) if (level) signature.access = { name: level, declaration: String(signature.reference).replace(/\/arguments$/, ''), grammar: 'famx-command-tree@2' };
  return entries;
}
function outcomes(contract: unknown, level?: string) {
  const data = goodData(); delete data.command_identities;
  const fields = { autoid: AUTOID, title: '合成用例', path: ['合成文档', '合成用例'], priority: '2', steps: [{ text: '合成步骤' }], expected: [QUOTE.text] };
  const raw = { item: { id: 'doc-1:c-1', location: QUOTE.reference, fields }, slots: { plan: [{ data }] }, catalog: catalogWith(level), catalog_complete: true, context: { command_policy: COMMAND_CATALOG.policy, root: COMMAND_CATALOG.root, groups: [{ kind: 'case-compile', contract, profile: PROFILE_DOC, manifest: MANIFEST_DOC }] } };
  const subject = planSubject(raw);
  return [...checkCommandsKnown({ subject }), ...checkContractShape({ subject })];
}
const refusals = (rows: Array<{ verdict: string; statement: string }>) => rows.filter((row) => row.verdict === 'refute' && row.statement.includes('refused_access'));

test('the contract declares, row by row, the access levels a method’s prompt refuses; the original identity is untouched', () => {
  const plain = parseRuntimeContract(contractWith()), declared = parseRuntimeContract(contractWith(REFUSED));
  assert.ok(plain.ok && declared.ok, JSON.stringify(declared));
  if (!plain.ok || !declared.ok) return;
  assert.deepEqual(refusedAccess(declared.contract, 'widget-seat', 'configure'), ['DEMO_LEVEL_CONFIG']);
  assert.deepEqual(refusedAccess(declared.contract, 'widget-host', 'shell'), []);
  assert.deepEqual(refusedAccess(plain.contract, 'widget-seat', 'configure'), []);
  assert.equal(declared.contract.pinned.identity, plain.contract.pinned.identity, 'an addition on top of the original contract');
  assert.notEqual(declared.contract.digest, plain.contract.digest);
  for (const bad of [
    { ...REFUSED, rows: [] }, { ...REFUSED, sha256: 'short' }, { source: REFUSED.source, sha256: SHA },
    { ...REFUSED, rows: [{ object: 'widget-seat', method: 'configure', access: [] }] },
    { ...REFUSED, rows: [{ object: 'widget-seat', method: 'configure', access: ['two words'] }] },
    { ...REFUSED, rows: [REFUSED.rows[0], REFUSED.rows[0]] },
    { ...REFUSED, rows: [{ ...REFUSED.rows[0], note: '多出来的字段' }] },
    { ...REFUSED, rows: [{ object: 'widget-seat', method: 'no-such-method', access: ['DEMO_LEVEL_CONFIG'] }] },
  ]) {
    const parsed = parseRuntimeContract(contractWith(bad));
    assert.equal(parsed.ok, false, JSON.stringify(bad));
    if (!parsed.ok) assert.ok(parsed.problems.some((problem) => problem.pointer.startsWith('/refused_access')), JSON.stringify(parsed.problems));
  }
});

test('a command of a refused level under that method is refused before dispatch, with the level, the method and what can send it', () => {
  const found = refusals(outcomes(contractWith(REFUSED), 'DEMO_LEVEL_CONFIG'));
  assert.equal(found.length >= 1, true, 'the plan’s device command is sent with the method whose prompt refuses its level');
  assert.match(found[0].statement, /命令“widget health interval”在锁定命令树里的级别是 DEMO_LEVEL_CONFIG，方法 configure 下发时所在的提示符不接受这一级别的命令（运行器合约 refused_access），设备会以语法错误拒绝/);
  assert.match(found[0].statement, /这台设备上没有声明可以下发它的方法，缺的是运行器合约的方法声明，由合约维护者补/, 'the fixture has one device method only');
});

test('nothing is refused without all three facts: the level on the signature, the method’s declaration, and that level in it', () => {
  assert.deepEqual(refusals(outcomes(contractWith(REFUSED))), [], 'the tree declares no level for the command');
  assert.deepEqual(refusals(outcomes(contractWith(), 'DEMO_LEVEL_CONFIG')), [], 'the contract declares no refusal');
  assert.deepEqual(refusals(outcomes(contractWith(REFUSED), 'DEMO_LEVEL_USER')), [], 'another level: accepted at that prompt as far as anyone has declared');
  assert.deepEqual(refusals(outcomes(contractWith({ ...REFUSED, rows: [{ object: 'widget-seat', method: 'credential', access: ['DEMO_LEVEL_CONFIG'] }] }), 'DEMO_LEVEL_CONFIG')), [], 'declared for another method of the object');
  assert.equal(checkCommandsKnownVerdict(outcomes(contractWith(REFUSED), 'DEMO_LEVEL_USER')), 'support');
});
function checkCommandsKnownVerdict(rows: Array<{ verdict: string }>): string { return rows[0].verdict; }
