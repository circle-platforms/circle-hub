import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caseCommandsGold, sha256 } from '../gold/case-commands.ts';
import { compareCommandIndex, renderIndexReport } from './command-index.ts';
const gold = caseCommandsGold('<commands><menu name="widget"><item name="add"/></menu></commands>', [{ document: 'synthetic-doc', map: { root: { data: { text: 'root' }, children: [{ data: { id: 'synthetic-case', text: 'widget add', resource: ['Functional'] } }, { data: { id: 'unplaced', text: 'plain', resource: ['Functional'] }, children: [{ data: { text: 'widget add' }, children: [{ data: { text: 'done' } }] }] }] } } }]);
function view() {
  const root = 'a'.repeat(64);
  const entries = Object.fromEntries(gold.cases.map((c) => { const digest = sha256(c.key); return [digest, { entry: digest, kind: 'case', reference: `tree:${root}${c.paths[0]?.path ?? '/'}@${digest}`, data: { document: c.document, node: c.node, commands: c.paths.map((p) => p.path) } }]; }));
  return { schema: 'index-view@1', product: 'synthetic', build: { build: 'synthetic', root }, kind: 'case', key: 'document', keys: { 'synthetic-doc': Object.keys(entries) } as Record<string, string[]>, entries, truncated: false, cut_keys: [] as string[], skipped: 0 };
}
test('equal tables, unplaced and separate step measurement; screen contains no identifiers', () => {
  const report = compareCommandIndex(gold, [view()]);
  assert.equal(report.verdict, '相等'); assert.equal(report.counts.unplaced_both, 1); assert.equal(report.counts.steps_placed_in_hub_unplaced, 1);
  assert.equal(report.hashes.gold, report.hashes.hub);
  const output = renderIndexReport(report); assert.ok(!output.includes('synthetic-doc')); assert.ok(!output.includes('synthetic-case')); assert.ok(!output.includes('/commands/')); assert.ok(output.endsWith('判定：相等'));
});
test('documents, cases and paths missing on either side are counted', () => {
  const raw = view(); const first = Object.values(raw.entries)[0]; first.data.document = 'other-doc';
  raw.keys = { 'other-doc': raw.keys['synthetic-doc'] } as typeof raw.keys;
  // Keep every index key consistent with its own entry.
  for (const entry of Object.values(raw.entries)) entry.data.document = 'other-doc';
  const report = compareCommandIndex(gold, [raw]); assert.equal(report.verdict, '不相等');
  for (const count of ['documents_gold_only', 'documents_hub_only', 'cases_gold_only', 'cases_hub_only', 'paths_gold_only', 'paths_hub_only']) assert.ok(report.counts[count] > 0, count);
});
for (const goldUnplaced of [true, false]) test(`unplaced mismatch ${goldUnplaced}`, () => {
  const raw = view(); const entry = Object.values(raw.entries).find((e) => (e.data.commands.length === 0) === goldUnplaced)!;
  const path = goldUnplaced ? '/commands/widget/add' : '/'; entry.reference = `tree:${raw.build.root}${path}@${entry.entry}`; entry.data.commands = goldUnplaced ? ['/commands/widget/add'] : [];
  const report = compareCommandIndex(gold, [raw]); assert.equal(report.verdict, '不相等'); assert.equal(report.counts.commands_different, 1);
});
test('entry paths and data commands must agree', () => {
  const raw = view(); Object.values(raw.entries)[0].data.commands = ['/commands/other'];
  assert.equal(compareCommandIndex(gold, [raw]).counts.entry_data_mismatches, 1);
});
for (const kind of ['truncated', 'cut', 'root', 'missing', 'skipped']) test(`incomplete ${kind}`, () => {
  const raw = view(); const extra = view();
  if (kind === 'truncated') raw.truncated = true;
  if (kind === 'cut') raw.cut_keys = ['synthetic-doc'];
  if (kind === 'root') extra.build.root = 'b'.repeat(64);
  if (kind === 'missing') raw.keys['synthetic-doc'].push('c'.repeat(64));
  if (kind === 'skipped') raw.skipped = 1;
  assert.equal(compareCommandIndex(gold, [raw, extra]).verdict, '输入不全');
});
test('complete only partitions and one view have identical comparisons', () => {
  const full = view();
  const part = { ...full, only: ['synthetic-doc'] };
  assert.deepEqual(compareCommandIndex(gold, [part, part]), compareCommandIndex(gold, [full]));
  assert.equal(compareCommandIndex(gold, [{ ...part, only: ['other'] }]).verdict, '输入不全');
});

test('unplaced totals include excluded ids but set comparisons exclude them', () => {
  const input = structuredClone(gold);
  input.cases.push({ key: 'synthetic-doc:', document: 'synthetic-doc', node: '', comparable: false, paths: [], steps: [] });
  const raw = view(); const digest = sha256('excluded');
  raw.entries[digest] = { entry: digest, kind: 'case', reference: `tree:${raw.build.root}/@${digest}`, data: { document: 'synthetic-doc', node: '@3', commands: [] } };
  raw.keys['synthetic-doc'].push(digest);
  const report = compareCommandIndex(input, [raw]);
  assert.equal(report.verdict, '相等'); assert.equal(report.counts.unplaced_gold, 2); assert.equal(report.counts.unplaced_hub, 2); assert.equal(report.counts.unplaced_both, 1);
});

test('a missing key with skipped sources is incomplete, never evidence of absence', () => {
  const raw = view(); raw.entries = {}; raw.keys = {}; raw.skipped = 1;
  assert.equal(compareCommandIndex(gold, [raw]).verdict, '输入不全');
  for (const skipped of [undefined, -1]) assert.equal(compareCommandIndex(gold, [{ ...view(), skipped }]).verdict, '输入不全');
});
