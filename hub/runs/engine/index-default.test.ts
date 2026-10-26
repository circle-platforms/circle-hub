import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {WorkflowInput} from '../../../contracts/src/pack.ts';
import {MAX_REFERENCE_LENGTH} from '../../../contracts/src/reference.ts';
import {appendQuery,chunkOnly,narrowIndexId} from './index-default.ts';

const cases: WorkflowInput = {
  slot: 'cases',
  role: 'expected',
  description: '用例索引',
  accepts: ['knowledge:index'],
  required: true,
  many: false,
  index_default: {only_from: {source: 'build_defects'}, fields: ['title', 'document', 'node', 'system', 'case', 'defects']},
};

const id = 'knowledge:index:famx:Rel_FAMX_10_6_1_57?kind=case&key=defects';

test('a build defect index supplies only and the trace fields, keeping a caller fields list', async () => {
  const narrowed = await narrowIndexId(cases, id, {}, async () => ({ok: true, keys: ['007', '12', '12']}));
  assert.equal(narrowed.ok, true);
  if (!narrowed.ok) return;
  assert.deepEqual(narrowed.ids, [`${id}&fields=case,defects,document,node,system,title&only=007,12,7`]);
  const explicit = await narrowIndexId(cases, `${id}&fields=document,node,title`, {}, async () => ({ok: true, keys: ['71004', '71001']}));
  assert.equal(explicit.ok, true);
  if (!explicit.ok) return;
  assert.equal(explicit.ids[0], `${id}&fields=document,node,title&only=71001,71004`);
});

test('an only the caller already wrote is left alone, and an empty fix list is not replaced by a question', async () => {
  const written = `${id}&only=1&fields=title`;
  const kept = await narrowIndexId(cases, written, {}, async () => { throw new Error('load'); });
  assert.deepEqual(kept, {ok: true, ids: [written], label: written});
  const empty = await narrowIndexId(cases, id, {}, async () => ({ok: true, keys: []}));
  assert.equal(empty.ok, false);
  if (empty.ok) return;
  assert.match(empty.fix, /不要向用户索取编号/);
});

test('story identifiers already on the input become only, and none leaves the cases id', async () => {
  const stories: WorkflowInput = {...cases, index_default: {only_from: {source: 'input_ids', slot: 'stories'}, fields: ['document', 'node', 'stories', 'title']}};
  const bound = await narrowIndexId(stories, `${id}&fields=document,node,title`, {stories: [{external: 'plm:stories:22+21'}]}, async () => { throw new Error('load'); });
  assert.equal(bound.ok, true);
  if (!bound.ok) return;
  assert.equal(bound.ids[0], `${id}&fields=document,node,title&only=21,22`);
  const open = await narrowIndexId(stories, `${id}&fields=document,node,title`, {}, async () => { throw new Error('load'); });
  assert.deepEqual(open, {ok: true, ids: [`${id}&fields=document,node,title`], label: `${id}&fields=document,node,title`});
});

test('only lists stay inside one external id', () => {
  const values = Array.from({length: 3000}, (_, n) => String(100000 + n));
  const chunks = chunkOnly(appendQuery(id, 'fields', 'document,node,title'), values);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(item => item.length <= MAX_REFERENCE_LENGTH));
  const covered = chunks.flatMap(item => item.split('only=')[1].split(','));
  assert.equal(covered.length, values.length);
});
