// T4-1 synthetic five-case block plans. Addresses stay in 192.0.2.0/24 and 2001:db8::/32.
// Residue, missing inverse, capacity, blind segment, a second dispatch and post-run byte equality
// are already asserted by the tests named in docs/hub-r5-test-map.md. This file does not repeat them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, positiveBlocks } from '../../packs/workflow/case-compile/testing/blocks.ts';
import { readSlots } from '../../packs/workflow/case-compile/functions/slots.ts';
import { typedAuthorityGaps } from '../../packs/workflow/case-compile/functions/typed-authority.ts';
import { checkContractShape } from '../../packs/workflow/case-compile/functions/checks.ts';
import { generateWorkbook } from '../../packs/workflow/case-compile/functions/generate.ts';
import { readWorkbook } from '../../packs/workflow/case-compile/functions/workbook.ts';
import { coreModel } from '../../packs/workflow/case-compile/testing/workbook-model.ts';

const cases = [
  { id: 'ipv4-listener', address: '192.0.2.10', kind: 'CONFIG' },
  { id: 'ipv6', address: '2001:db8:1::10', kind: 'OBSERVE_ASSERT' },
  { id: 'port-interface', address: '192.0.2.74', kind: 'CAPTURE' },
  { id: 'bond', address: '192.0.2.11', kind: 'CAPTURE_COMPARE' },
  { id: 'slb-vip', address: '192.0.2.12', kind: 'RESTORE_FROM' },
] as const;

test('five synthetic block plans compile, round-trip a workbook, and the VIP case restores from the capture', () => {
  const bed = fixture();
  const plans = positiveBlocks();
  for (const [index, item] of cases.entries()) {
    const data = plans[item.kind];
    const parsed = readSlots(data);
    assert.equal(parsed.ok, true, item.id);
    if (!parsed.ok) return;
    assert.deepEqual(typedAuthorityGaps(bed.contract, bed.profile, parsed.slots, undefined, bed.catalog, [], bed.manifest_sha256), [], item.id);
    const shape = checkContractShape(bed.subject(data, { item: item.id }));
    assert.ok(shape.every((outcome) => outcome.verdict === 'support'), `${item.id} ${JSON.stringify(shape)}`);
    const fields = { ...bed.fields, autoid: `SYN-BLOCK-${index + 1}`, title: `合成 ${item.id} ${item.address}` };
    const recipe = { slots: parsed.slots, contract: bed.contract, profile: bed.profile, fields, plan_run: 'run_' + '0'.repeat(26), build: 'SYN_ORBIT_10_8_1' };
    const bytes = generateWorkbook(recipe);
    const read = readWorkbook(coreModel(bytes), recipe);
    assert.equal(read.ok, true, `${item.id} ${JSON.stringify(read)}`);
    assert.deepEqual(generateWorkbook(recipe), bytes);
    if (item.kind === 'RESTORE_FROM' && read.ok) assert.ok(read.executions.some((row) => row.method === 'restore_checked'));
  }
});
