import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectItems } from './project.ts';
import { MANIFEST_DOC, AUTOID } from './test-support.ts';
import { runtimeDocument, profileDocument } from '../testing/runtime.ts';
import { createTestParserRegistry } from '../../../../hub/testing/parsers.ts';
import { recognize } from '../../../../hub/refs/api.ts';
import { RECOMPOSE_RUN, boundRecord, recordRow, resultBody } from '../testing/late-binding.ts';

const SHA = 'a'.repeat(64), SECOND = '990000000000000032';
const CONTEXT = { leases: { now: '2026-10-23T02:00:00.000Z', entries: [] }, product: 'orbit', root: 'r'.repeat(64), product_pack_digest: 'p'.repeat(64) };
const model = recognize(createTestParserRegistry(), Buffer.from(JSON.stringify({ root: { data: { id: 'synthetic-map', text: '合成用例' }, children: [
  { data: { id: 'case-a', text: '合成用例一', priority: 2, resource: ['合成'], auto: 'YES', autoid: AUTOID }, children: [{ data: { id: 'step-a', text: 'widget health interval pool-a 60' }, children: [{ data: { id: 'expected-a', text: '生效一' } }] }] },
  { data: { id: 'case-b', text: '合成用例二', priority: 2, resource: ['合成'], auto: 'YES', autoid: SECOND }, children: [{ data: { id: 'step-b', text: 'widget health interval pool-b 61' }, children: [{ data: { id: 'expected-b', text: '生效二' } }] }] },
] } })), 'application/json')!.document.model as { nodes: Array<{ data: { id?: string }; selector: string }> };
const selectorOf = (id: string) => model.nodes.find((node) => node.data.id === id)!.selector;
const runRecord = (cases: string[]) => boundRecord('recomposition_run', 'run', {
  run: RECOMPOSE_RUN, pack: 'recompose@1.2.7', pack_digest: 'd'.repeat(64), product: CONTEXT.product, root: CONTEXT.root, product_pack_digest: CONTEXT.product_pack_digest, predecessor: null,
  items: cases.map((id, index) => ({ id: `recompose-item-${index + 1}`, fields: { source_ref: 'src:' + SHA, node: selectorOf(id) } })),
}, 'f'.repeat(64));
const input = (extra: unknown[], parameters: Record<string, unknown> = {}, late = true) => ({
  inputs: [{ slot: 'subject', sha256: SHA, parser: 'kityminder@1', model }, { slot: 'contract', model: runtimeDocument() }, { slot: 'profile', model: profileDocument() }, { slot: 'inventory', model: MANIFEST_DOC }, ...extra],
  parameters,
  context: { ...CONTEXT, ...(late ? { late_inputs: [{ slot: 'recomposition_result', run: RECOMPOSE_RUN }] } : {}) },
});
type Projected = { error?: { code: string; message: string; pointer?: string }; items: Array<{ id: string; summary: string; fields: Record<string, any> }>; groups: Array<Record<string, unknown>> };

test('every item of a late-bound recomposition is marked to take its record at each evaluation, with nothing of the result in it', () => {
  const out = projectItems(input([runRecord(['case-a', 'case-b'])])) as Projected;
  assert.equal(out.error, undefined, JSON.stringify(out.error));
  assert.deepEqual(out.items.map((item) => item.fields.recomposition_late), [
    { slot: 'recomposition_result', run: RECOMPOSE_RUN, source: 'src:' + SHA, node: selectorOf('case-a') },
    { slot: 'recomposition_result', run: RECOMPOSE_RUN, source: 'src:' + SHA, node: selectorOf('case-b') },
  ]);
  for (const item of out.items) {
    assert.equal(item.fields.recomposition, undefined);
    assert.equal(item.fields.recomposition_problem, undefined);
    assert.equal(item.fields.pipeline, 'recomposed');
    assert.equal(item.fields.pipeline_note, '本条重组记录由 Hub 每次核对时取；下载后读运行目录 records/ 下与本条同序号的文件，late.json 是全部条目的合集');
    assert.ok(item.summary.endsWith('；重组待受理'), item.summary);
  }
  assert.equal(out.groups[0].recomposition_requested, true);
  const recomposed = projectItems(input([runRecord(['case-a', 'case-b'])], { pipeline: 'recomposed' })) as Projected;
  assert.equal(recomposed.error, undefined, JSON.stringify(recomposed.error));
});

test('the subset check against the frozen recompose run record still refuses at start', () => {
  const out = projectItems(input([runRecord(['case-a'])])) as Projected;
  assert.equal(out.error?.code, 'case-compile.invalid_parameter');
  assert.match(out.error?.message ?? '', new RegExp(`不在绑定重组运行 ${RECOMPOSE_RUN} 的冻结条目内`));
});

test('an explicit rec: binding of the result keeps the frozen path: the record or its refusal is in the item', () => {
  const result = boundRecord('recomposition_result', 'validation_result', resultBody([recordRow('recompose-item-1', null, 'pending')]), 'e'.repeat(64));
  const out = projectItems(input([runRecord(['case-a', 'case-b']), result], {}, false)) as Projected;
  assert.equal(out.error, undefined, JSON.stringify(out.error));
  for (const item of out.items) {
    assert.equal(item.fields.recomposition_late, undefined);
    assert.equal(typeof item.fields.recomposition_problem, 'string');
    assert.ok(!item.summary.endsWith('；重组待受理'));
  }
});
