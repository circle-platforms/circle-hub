import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCases } from './cases.ts';
import { projectItems } from './project.ts';
import { MANIFEST_DOC } from './test-support.ts';
import { runtimeDocument, profileDocument } from '../testing/runtime.ts';
const AUTOID = '990000000000000031';
const model = (body = false): { nodes: Array<{ text: string; data: Record<string, unknown>; children: number[] }> } => ({ nodes: [
  { text: '合成文档', data: { id: 'doc' }, children: [1] },
  { text: body ? '合成标题\n执行 widget health interval 60' : '合成标题', data: { id: 'case', resource: ['功能'], autoid: AUTOID, auto: '01', priority: '02' }, children: [2] },
  body ? { text: '期望成功', data: {}, children: [] } : { text: '执行 widget health interval 60', data: {}, children: [3] },
  { text: '期望成功', data: {}, children: [] },
] });
export function runtimeInput(value: unknown = model(), autoid = AUTOID) { return { inputs: [
  { slot: 'subject', sha256: 'a'.repeat(64), parser: 'kityminder@1', model: value },
  { slot: 'contract', model: runtimeDocument() }, { slot: 'profile', model: profileDocument() }, { slot: 'inventory', model: MANIFEST_DOC },
], parameters: { autoid }, context: { leases: { now: '2026-10-23T02:00:00.000Z', entries: [] } } }; }
for (const body of [false, true]) test(`extract authored operations without rewriting, layout body=${body}`, () => {
  const found = extractCases(model(body), 'marked').cases[0];
  assert.equal(found.autoid, AUTOID); assert.equal(found.auto, '01'); assert.equal(found.priority, '02');
  assert.equal(found.steps.length, 1); assert.deepEqual(found.steps[0].expected, ['期望成功']);
  assert.equal(found.steps[0].text, body ? '合成标题\n执行 widget health interval 60' : '执行 widget health interval 60');
});
test('projection selects exactly one textual autoid and preserves values above 2^53', () => {
  const out = projectItems(runtimeInput()) as { items: Array<{ fields: Record<string, unknown> }> }; assert.equal(out.items.length, 1);
  assert.deepEqual([out.items[0].fields.autoid, out.items[0].fields.auto, out.items[0].fields.priority], [AUTOID, '01', '02']);
});
test('missing, malformed and duplicate autoid refuse startup with a next action', () => {
  const duplicate = model(); duplicate.nodes[0].children.push(4); duplicate.nodes.push({ ...duplicate.nodes[1], data: { ...duplicate.nodes[1].data, id: 'duplicate' } });
  const code = (input: unknown) => { const out = projectItems(input) as { error: { code: string; fix: string } }; assert.ok(out.error.fix); return out.error.code; };
  assert.equal(code(runtimeInput(model(), '990000000000000032')), 'case-compile.autoid_not_found');
  assert.equal(code(runtimeInput(model(), 'imprecise-id')), 'case-compile.autoid_invalid');
  assert.equal(code(runtimeInput(duplicate)), 'case-compile.autoid_ambiguous');
});
test('profile refusal returns every problem pointer instead of clipping the list', () => {
  const input = runtimeInput(); const profile = profileDocument();
  profile.allowed = Array.from({ length: 110 }, (_, i) => ({ object: 'widget-seat', method: `missing-${i}`, parameters: { line: 'device_cli' } })) as typeof profile.allowed;
  input.inputs.find((v) => v.slot === 'profile')!.model = profile;
  const out = projectItems(input) as { error: { code: string }; warnings: unknown[] };
  assert.equal(out.error.code, 'case-compile.profile_invalid'); assert.ok(out.warnings.length >= 110);
});
