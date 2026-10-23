import assert from 'node:assert/strict';
import { test } from 'node:test';
import TABLE from '../tables/template-v3.json' with { type: 'json' };
import { readTemplate } from './template.ts';
import { commandCoverage } from './commands.ts';
import { commandOutcomes } from './command-check.ts';
import { indexView, LOCK } from '../testing/index.ts';
const template = readTemplate(TABLE);
assert.notEqual(typeof template, 'string');
const document = '900001';
const records = ['kept', 'deleted'].map(node => ({ document, node, title: node, path_labels: ['root'], commands: [`CLI/widget/${node}`] }));
const cases = [{ id: `${document}:kept`, visit: 1, categories: [] }];
const nodes = { texts: ['root', 'kept'], parents: [-1, 0] };
const subject = (index: unknown) => ({ document, item: document, uploaded: false, case_rule: 'marked', cases, case_count: 1, nodes, index, scope: [document], lock: LOCK });
test('deletion-only stale indices give the same conclusions as fresh indices with shared or exclusive commands', () => {
  for (const shared of [false, true]) {
    const rows = records.map(row => ({ ...row, commands: shared ? ['CLI/widget/kept'] : row.commands }));
    const stale = commandOutcomes(subject(indexView(rows)));
    const fresh = commandOutcomes(subject(indexView(rows.slice(0, 1))));
    const conclusions = (outcomes: ReturnType<typeof commandOutcomes>) => outcomes.map(o => ({ verdict: o.verdict, code: o.code, command: o.data?.command, missing: o.data?.missing }));
    assert.deepEqual(conclusions(stale), conclusions(fresh));
    assert.ok(stale.every(o => o.verdict === 'refute'));
    assert.deepEqual(stale[0]!.data?.orphaned_keys, ['deleted']);
    assert.deepEqual(commandCoverage(template as Exclude<typeof template, string>, document, cases, indexView(rows), [], false, LOCK, 'tagged', nodes).orphaned, []);
  }
});
test('missing index recovery names the locked build, exact scope and all revision fields', () => {
  const gap = commandOutcomes(subject(null))[0]!;
  assert.equal(gap.verdict, 'unknown');
  const action = String(gap.data?.next_action);
  assert.ok(action.includes(String(LOCK.build)));
  assert.ok(action.includes(`only=${document}`));
  assert.ok(action.includes('fields=document,node,commands,title,path_labels'));
});
test('unplaced note wording never determines index completeness', () => {
  for (const note of ['未归位条目 3 个，标在根下，计入合计', '索引说明已改写']) {
    const view = indexView(records.slice(0, 1)); view.notes = [note];
    const outcomes = commandOutcomes(subject(view));
    assert.deepEqual(outcomes.map(row => row.verdict), ['refute']);
    assert.equal(outcomes[0]!.code, 'template-gap.command_shortfall');
  }
});
