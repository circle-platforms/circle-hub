// The production report of applicability conditions. Conditions come only from declared `famx-applicability@1` blocks
// (a fenced protocol marker, an exact scope with the source parser's own section path and `descendants: true`, and the
// conditions themselves, each value inside the closed deployment vocabularies); reading them out of prose was retired, so
// the counts are of structural declarations and of what those declarations hand down, and the statistics line says
// 结构声明 rather than the retired 直接抽取.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { produceManualEntries } from './manual.ts';
import { markdown } from '../testing/test-support.ts';
import { APPLICABILITY_FIELD, labelOf } from './generated/vocabulary.ts';

const GB = 1024 ** 3;
const decl = (section: string[], conditions: Record<string, unknown>): string =>
  '```famx-applicability@1\n' + JSON.stringify({ schema: 'famx-applicability@1', scope: { section, descendants: true }, conditions }) + '\n```';
const options = { components: ['Card-A', 'Card-B'], licenses: ['Permit-A', 'Permit-B'], deployment_forms: ['Form-A'] };

test('production report counts declared and inherited entries by field, preserving override and conflict locations', () => {
  const source = [
    '# Outer', '',
    decl(['Outer'], { components: { with: ['Card-A'] }, memory: { minimum: { bytes: 8 * GB, inclusive: true }, raw: '内存至少8GB' } }), '',
    '## Inner', '',
    decl(['Outer', 'Inner'], { components: { with: ['Card-B'] } }), '',
    '普通正文。', '',
    '## Conflict', '',
    decl(['Outer', 'Conflict'], { licenses: ['Permit-A'] }), '',
    decl(['Outer', 'Conflict'], { licenses: ['Permit-B'] }), '',
    '后续正文。', '',
  ].join('\n');
  const out = produceManualEntries(markdown(source), null, options);
  const report = out.applicability_report!;
  // Two entries exist. `components` is declared twice (Outer and Inner): the Inner entry reads its own section, so the
  // override is one direct and one inherited. `memory` is declared once at the top and handed to both entries. The
  // conflicted `licenses` field is counted nowhere: an unresolved conflict is omitted, not resolved by a guess.
  assert.deepEqual(report.counts.components, { direct: 1, inherited: 1 });
  assert.deepEqual(report.counts.memory, { direct: 0, inherited: 2 });
  assert.deepEqual(report.counts.licenses, { direct: 0, inherited: 0 });
  assert.deepEqual(report.overrides.map((row) => [row.field, row.section]), [['components', ['Outer', 'Inner']]]);
  assert.deepEqual(report.conflicts.map((row) => [row.field, row.section]), [['licenses', ['Outer', 'Conflict']]]);
  for (const field of APPLICABILITY_FIELD) {
    const count = report.counts[field];
    assert.ok(
      out.warnings.includes(`适用条件统计：${labelOf('applicability_field', field)}：结构声明 ${count.direct} 条，继承 ${count.inherited} 条`),
      `${field}: ${JSON.stringify(out.warnings)}`,
    );
  }
  // Both deviations keep their locations and both values, and the unresolved one names the missing fact and the exit.
  const override = out.warnings.find((row) => row.includes('适用条件内外层不同'));
  assert.ok(override !== undefined && override.includes('部件') && override.includes('Outer/Inner') && override.includes('Card-A') && override.includes('Card-B'), JSON.stringify(out.warnings));
  const conflict = out.warnings.find((row) => row.includes('适用条件同章冲突'));
  assert.ok(conflict !== undefined && conflict.includes('许可') && conflict.includes('Outer/Conflict') && conflict.includes('Permit-A') && conflict.includes('Permit-B'), JSON.stringify(out.warnings));
  assert.match(conflict ?? '', /缺少一致的来源声明/);
  assert.match(conflict ?? '', /下一步：来源维护者核对这些片段/);
});

test('one declared block per field reaches every entry below it, and an inner declaration is direct for its own section', () => {
  const all = { components: { with: ['Card-A'] }, memory: { minimum: { bytes: 4 * GB, inclusive: true }, raw: '内存至少4GB' }, licenses: ['Permit-A'], deployment_forms: ['Form-A'] };
  const source = [
    '# Top', '',
    decl(['Top'], all), '',
    '## Mid', '',
    decl(['Top', 'Mid'], { licenses: ['Permit-B'] }), '',
    '段落一。', '',
    '## Other', '',
    '段落二。', '',
    '段落三。', '',
  ].join('\n');
  const out = produceManualEntries(markdown(source), null, options);
  assert.deepEqual(out.entries.map((entry) => entry.statement), ['段落一。', '段落二。', '段落三。']);
  const counts = out.applicability_report!.counts;
  // Every entry carries all four fields, so each field counts three; the inner licence declaration makes one of them
  // direct for its own section and leaves two inherited from the top.
  for (const field of ['components', 'memory', 'licenses', 'deployment_forms'] as const) {
    assert.equal(counts[field].direct + counts[field].inherited, 3, field);
  }
  assert.deepEqual(counts.licenses, { direct: 1, inherited: 2 });
  assert.deepEqual(counts.components, { direct: 0, inherited: 3 });
  const [mid, other] = out.entries;
  assert.deepEqual(mid.applicability?.inherited, ['components', 'memory', 'deployment_forms'], 'its own section declares the licence');
  assert.deepEqual(other.applicability?.licenses, ['Permit-A']);
  assert.deepEqual(other.data.section_path, ['Top', 'Other']);
});

test('prose in the shared synthetic manual declares nothing, so the report counts no condition', () => {
  // The fixture is the pack's synthetic manual of prose, tables and signatures; it carries no declaration block, and a
  // sentence that names a vocabulary member is not a declaration. The fields are exercised by the two tests above.
  const out = produceManualEntries(markdown('# Outer 装有 Card-A 时\n\n内存至少8GB。\n\n## Inner\n\n需要 Permit-A 许可。\n\n普通正文。\n'), null, options);
  const counts = out.applicability_report!.counts;
  for (const field of APPLICABILITY_FIELD) assert.deepEqual(counts[field], { direct: 0, inherited: 0 }, field);
  assert.deepEqual(out.applicability_report?.overrides, []);
  assert.deepEqual(out.applicability_report?.conflicts, []);
  assert.ok(out.entries.every((entry) => entry.applicability === null));
});
