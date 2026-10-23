import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSlots } from './slots.ts';
const slots = () => ({ bucket: 'bed-a', blocks: [], steps: [{ object: 'widget-seat', method: 'configure', args: ['widget health interval 60'], keywords: {} }], expects: [{ text: '成功', quote: { reference: `src:${'a'.repeat(64)}`, text: '成功' }, after: 1 }], replacements: [] });
test('restricted slots preserve args, keywords, expectation step and replacement table', () => {
  const raw = slots(); assert.deepEqual(readSlots(raw), { ok: true, slots: raw });
});
for (const [name, change] of Object.entries({
  blocks: (v: any) => { v.blocks = ['setup']; }, params: (v: any) => { v.steps[0].params = {}; }, args: (v: any) => { v.steps[0].args = [42]; }, keywords: (v: any) => { v.steps[0].keywords = { line: true }; }, after: (v: any) => { v.expects[0].after = 0; }, replacements: (v: any) => { v.replacements = [{ from: '192.0.2.20', to: '192.0.2.10' }]; }, unknown: (v: any) => { v.plan_json = '{}'; },
})) test(`slot shape refusal follows published schema: ${name}`, () => {
  const raw = slots(); change(raw); const read = readSlots(raw); assert.equal(read.ok, false); if (!read.ok) assert.ok(read.problems.every((p) => p.pointer.startsWith('/')));
});
