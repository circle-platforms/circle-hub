import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baseDocument } from '../testing/mindmap.ts';
import { assignedCases, bindIndex, indexView, LOCK } from '../testing/index.ts';
import { bind, projectionInput, isFailure } from '../testing/support.ts';
import { projectDocuments } from './project.ts';
import { commandSubject } from './command-subject.ts';
import { commandOutcomes } from './command-check.ts';
const document = '900001';
function run(mutate: (row: ReturnType<typeof assignedCases>[number]) => void, case_rule = 'marked') {
  const source = baseDocument(); const records = assignedCases(source, document);
  mutate(records[0]!); const view = indexView(records); view.fields = ['document', 'node', 'commands', 'title', 'path_labels'];
  const out = projectDocuments({ ...projectionInput([bind(source, { external: `agile:mindmap:${document}` }), bindIndex(view)], { case_rule }), context: { ...LOCK, parameters: { case_rule } } });
  assert.ok(!isFailure(out));
  return { item: out.items[0]!, outcomes: commandOutcomes(commandSubject({ item: out.items[0], context: { ...LOCK, groups: out.groups } })) };
}
for (const field of ['title', 'path_labels'] as const) test(`stable node key with changed ${field} is treated as an unmatched case revision`, () => {
  const result = run(row => { if (field === 'title') row.title += '（旧版本）'; else row.path_labels = [...row.path_labels, '旧上级节点']; });
  assert.equal(result.item.fields.command_coverage!.unmatched.length, 1);
  const gap = result.outcomes.find(o => o.data?.scope === 'document')!;
  assert.equal(gap.verdict, 'unknown'); assert.equal(gap.data?.unmatched_cases_count, 1); assert.match(String(gap.data?.next_action), /知识同步.*重跑/);
});
test('command coverage requires marked even when tagged cases happen to keep matching keys', () => {
  const result = run(() => {}, 'tagged');
  assert.equal(result.outcomes[0]!.code, 'template-gap.case_rule_mismatch');
  assert.match(String(result.outcomes[0]!.data?.next_action), /默认.*marked.*重跑/);
  assert.equal(result.item.fields.command_coverage!.commands.length, 0);
});

test('NFKC and whitespace-only header differences require synchronization', () => {
  const result = run(row => { row.title = `  ${row.title.replaceAll('widget', 'ｗｉｄｇｅｔ')}　`; row.path_labels = row.path_labels.map(label => ` ${label}　`); });
  assert.equal(result.item.fields.command_coverage!.unmatched.length, 1);
  assert.ok(result.outcomes.some(o => o.verdict === 'unknown'));
});

test('a complete index missing this document gives the same definite summary and verdict', () => {
  const source = baseDocument(); const view = indexView([], [document]);
  const out = projectDocuments({ ...projectionInput([bind(source, { external: `agile:mindmap:${document}` }), bindIndex(view)]), context: { ...LOCK, parameters: {} } });
  assert.ok(!isFailure(out));
  assert.match(out.items[0]!.summary, /文档不在完整索引里.*构建.*重跑/);
  const outcomes = commandOutcomes(commandSubject({ item: out.items[0], context: { ...LOCK, groups: out.groups } }));
  assert.equal(outcomes[0]!.code, 'template-gap.not_indexed');
});
