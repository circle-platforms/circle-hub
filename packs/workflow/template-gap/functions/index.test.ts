import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baseDocument, renamed } from '../testing/mindmap.ts';
import { bind, projectionInput, isFailure } from '../testing/support.ts';
import { BUILD, LOCK, bindIndex, indexView } from '../testing/index.ts';
import { projectDocuments } from './project.ts';
const documents = [bind(baseDocument(), { external: 'agile:mindmap:900001' })];
const good = () => indexView([], ['900001']);
const call = (view: unknown, inputs = documents) => projectDocuments({ ...projectionInput([...inputs, bindIndex(view)]), context: LOCK });

test('case index is frozen with the projection for the exact locked root and agile document set', () => {
  const out = call(good(), [...documents, bind(renamed(baseDocument(), 'upload-root'))]);
  assert.ok(!isFailure(out)); assert.ok(out.groups?.some(g => g.kind === 'case_index'));
});
for (const [name, edit] of [
  ['another root', (v: any) => { v.build.root = 'b'.repeat(64); }],
  ['too many documents', (v: any) => { v.only.push('900002'); }],
  ['too few documents', (v: any) => { v.only = []; }],
  ['wrong schema', (v: any) => { v.schema = 'facet-view@1'; }],
  ['contradictory complete counts', (v: any) => { v.total_entries = 1; }],
  ['wrong index key', (v: any) => { v.key = 'commands'; }],
  ['missing revision fields', (v: any) => { v.fields = ['document', 'node', 'commands']; }],
  ['missing completeness fact', (v: any) => { delete v.skipped; }],
] as const) test(`refuses case index: ${name}`, () => {
  const v = good(); edit(v); const out = call(v);
  assert.ok(isFailure(out)); assert.equal(out.error.code, 'template-gap.index_invalid');
  assert.ok(out.error.fix?.includes(BUILD)); assert.match(out.error.fix ?? '', /only=900001/);
});
test('only excludes uploads even when uploaded and agile documents are mixed', () => {
  const upload = bind(renamed(baseDocument(), 'upload-root')); const view = good(); view.only!.push(`upload-${upload.sha256.slice(0, 12)}`);
  assert.ok(isFailure(call(view, [...documents, upload])));
});
