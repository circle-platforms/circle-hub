import { commandIdentity } from '../testing/index.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baseDocument, goldOf } from '../testing/mindmap.ts';
import { bind, projectionInput, isFailure } from '../testing/support.ts';
import { LOCK, assignedCases, bindIndex, indexView } from '../testing/index.ts';
import { projectDocuments } from './project.ts';
const doc = '900001';
const document = bind(baseDocument(), { external: `agile:mindmap:${doc}` });
const cases = () => goldOf(baseDocument(), doc).byCategory.get('command_add')!;
const rawRun = (parameters: Record<string, unknown> = {}) => {
  const ids = cases(); const records = assignedCases(baseDocument(), doc);
  const view = indexView(ids.slice(0, 2).flatMap(id => { const record = records.find(c => c.node === id.slice(doc.length + 1))!; return [{ ...record, commands: ['/CLI/widget/add', '/CLI/widget/delete'] }, { ...record, commands: ['/CLI/widget/add'] }]; }));
  const out = projectDocuments({ ...projectionInput([document, bindIndex(view)], parameters), context: { ...LOCK, parameters } });
  return out;
};
const run = (parameters: Record<string, unknown> = {}) => { const out = rawRun(parameters); assert.ok(!isFailure(out)); return out.items[0]!.fields; };
test('a case with several index entries and commands counts once per command', () => {
  const coverage = run().command_coverage!; assert.equal(coverage.commands.length, 2);
  for (const row of coverage.commands) { assert.equal(row.caseCount, 2); assert.equal(row.categories.length, 9); assert.equal(row.categories.find(c => c.id === 'command_add')!.count, 2); assert.ok(row.references.every(r => r.startsWith(`tree:${LOCK.root}/`))); }
});
test('a command-specific skip cannot skip the same category on another command or on the document', () => {
  const fields = run({ skipped: [{ category: 'audit_log', reason: '合成用户声明', command: commandIdentity('/CLI/widget/add') }] });
  assert.ok(fields.missing.includes('audit_log') === false || fields.categories.find(c => c.id === 'audit_log')?.present);
  assert.equal(fields.skipped.length, 0);
  assert.ok(!fields.command_coverage!.commands.find(c => c.command.endsWith('/add'))!.missing.includes('audit_log'));
  assert.ok(fields.command_coverage!.commands.find(c => c.command.endsWith('/delete'))!.missing.includes('audit_log'));
});

test('document-wide command-category skips apply to every command', () => {
  const fields = run({ skipped: [{ category: 'audit_log', reason: '合成用户声明' }] });
  assert.equal(fields.skipped.length, 1);
  assert.ok(fields.command_coverage!.commands.every(row => !row.missing.includes('audit_log') && row.skipped.length === 1));
});
for (const skipped of [
  [{ category: 'audit_log', command: commandIdentity('/CLI/absent'), reason: '合成声明' }],
  [{ category: 'functional', command: commandIdentity('/CLI/widget/add'), reason: '合成声明' }],
  [{ category: 'audit_log', reason: '合成声明' }, { category: 'audit_log', command: commandIdentity('/CLI/widget/add'), reason: '重叠声明' }],
]) test('unapplicable or overlapping command skips refuse the whole projection', () => {
  const out = rawRun({ skipped }); assert.ok(isFailure(out)); assert.equal(out.error.code, 'template-gap.skip_invalid');
});

test('command counts retain every case while category evidence is sorted and capped at twenty', async () => {
  const { withCase, witnessCase } = await import('../testing/mindmap.ts');
  let source = baseDocument();
  for (let i = 0; i < 30; i++) source = withCase(source, '其他', witnessCase('command_add', 1000 + i));
  const ids = goldOf(source, doc).byCategory.get('command_add')!.sort(); assert.ok(ids.length > 20);
  const view = indexView(assignedCases(source, doc, () => ['/CLI/widget/add']).filter(c => ids.includes(`${doc}:${c.node}`)));
  const out = projectDocuments({ ...projectionInput([bind(source, { external: `agile:mindmap:${doc}` }), bindIndex(view)]), context: LOCK });
  assert.ok(!isFailure(out));
  const row = out.items[0]!.fields.command_coverage!.commands[0]!;
  const fact = row.categories.find(c => c.id === 'command_add')!;
  assert.equal(row.caseCount, ids.length); assert.equal(fact.count, ids.length); assert.deepEqual(fact.evidence, ids.slice(0, 20)); assert.equal(fact.references.length, 20);
});
