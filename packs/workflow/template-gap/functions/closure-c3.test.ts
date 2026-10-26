import { commandIdentity } from '../testing/index.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baseDocument } from '../testing/mindmap.ts';
import { assignedCases, bindIndex, indexView, LOCK } from '../testing/index.ts';
import { bind, projectionInput, isFailure } from '../testing/support.ts';
import { projectDocuments } from './project.ts';
import { commandSubject } from './command-subject.ts';
import { commandOutcomes } from './command-check.ts';
const document = '900001', legacy = '/CLI/widget/legacy';
function skipped(mode: 'orphan' | 'changed') {
  const source = baseDocument(), records = assignedCases(source, document);
  if (mode === 'orphan') records.push({ ...records[0]!, node: 'deleted', commands: [legacy] });
  else { records[0]!.title += 'old'; records[0]!.commands = [legacy]; }
  const parameters = { skipped: [{ category: 'audit_log', reason: '合成用户声明', command: commandIdentity(legacy) }] };
  return projectDocuments({ ...projectionInput([bind(source, { external: `agile:mindmap:${document}` }), bindIndex(indexView(records))], parameters), context: { ...LOCK, parameters } });
}
test('a command skip carried only by deleted index rows is refused', () => {
  const out = skipped('orphan'); assert.ok(isFailure(out)); assert.equal(out.error.code, 'template-gap.skip_invalid');
});
test('a command skip waiting for a current case revision stays visible in fields and the document gap', () => {
  const out = skipped('changed'); assert.ok(!isFailure(out));
  const pending = out.items[0]!.fields.command_coverage!.pending_skips;
  assert.deepEqual(pending, [{ category: 'audit_log', reason: '合成用户声明', command: commandIdentity(legacy) }]);
  const outcomes = commandOutcomes(commandSubject({ item: out.items[0], context: { ...LOCK, groups: out.groups } }));
  const gap = outcomes.find(o => o.data?.scope === 'document')!;
  assert.equal(gap.verdict, 'unknown'); assert.deepEqual(gap.data?.pending_skips, pending);
  assert.match(String(gap.data?.next_action), /知识同步.*重跑/);
});
