import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baseDocument, withoutCategory } from '../testing/mindmap.ts';
import { bind, isFailure, projectionInput } from '../testing/support.ts';
import { LOCK, assignedCases, bindIndex, indexView } from '../testing/index.ts';
import { projectDocuments } from './project.ts';
import { commandSubject } from './command-subject.ts';
import { commandOutcomes } from './command-check.ts';
const doc = '900001';
function fixture(source = baseDocument(), options: { missing?: boolean; skipped?: number; extra?: boolean; upload?: boolean; commandless?: boolean; absent?: boolean; truncated?: boolean; cut?: boolean } = {}) {
  const records = assignedCases(source, doc, () => options.commandless ? [] : ['/CLI/widget/probe']);
  const view = indexView(options.absent ? [] : records.slice(0, options.extra ? -1 : undefined), [doc]);
  view.skipped = options.skipped ?? 0;
  view.truncated = options.truncated === true || options.cut === true;
  if (options.cut) view.cut_keys = [doc];
  if (view.skipped) view.notes = ['未归位条目 3 个，标在根下', '合成根有来源未读入'];
  const bound = bind(source, options.upload ? {} : { external: `agile:mindmap:${doc}` });
  if (options.upload) view.only = [];
  const out = projectDocuments({ ...projectionInput([bound, ...(!options.missing ? [bindIndex(options.upload ? indexView([], []) : view)] : [])]), context: LOCK });
  assert.ok(!isFailure(out));
  const subject = commandSubject({ item: { ...out.items[0], location: `src:${bound.sha256}/kityminder@1/i` }, context: { ...LOCK, groups: out.groups } });
  return { out, subject };
}
test('known command with all nine template categories supports with tree evidence', () => {
  const { subject } = fixture(); const outcomes = commandOutcomes(subject);
  assert.equal(outcomes.length, 1); assert.equal(outcomes[0]!.verdict, 'support');
  assert.equal((outcomes[0]!.data?.categories as unknown[]).length, 9);
  assert.ok(outcomes[0]!.grounds.some(r => r.startsWith(`tree:${LOCK.root}/`)));
});
test('missing command category refutes with the declared shortfall code and missing list', () => {
  const [outcome] = commandOutcomes(fixture(withoutCategory(baseDocument(), 'audit_log')).subject);
  assert.equal(outcome!.code, 'template-gap.command_shortfall'); assert.deepEqual(outcome!.data?.missing, ['audit_log']);
});
test('display rows cannot drop a command or change the nine mandatory categories', () => {
  const f = fixture(withoutCategory(baseDocument(), 'audit_log'));
  f.out.items[0]!.fields.command_coverage!.commands = [];
  const subject = commandSubject({ item: f.out.items[0], context: { ...LOCK, groups: f.out.groups } });
  assert.equal(commandOutcomes(subject)[0]!.code, 'template-gap.command_shortfall');
});
for (const [name, options, code] of [
  ['not indexed', { absent: true }, 'template-gap.not_indexed'],
  ['upload', { upload: true }, 'template-gap.not_indexed'],
  ['no commands', { commandless: true }, 'template-gap.no_commands'],
] as const) test(`${name} has a definite document-level refutation and next action`, () => {
  const [outcome] = commandOutcomes(fixture(baseDocument(), options).subject);
  assert.equal(outcome!.verdict, 'refute'); assert.equal(outcome!.code, code); assert.ok(outcome!.data?.next_action);
});
test('missing index is a transitional unknown with the binding action', () => {
  const [outcome] = commandOutcomes(fixture(baseDocument(), { missing: true }).subject);
  assert.equal(outcome!.verdict, 'unknown'); assert.deepEqual(outcome!.data?.missing, ['case_index']); assert.match(outcome!.statement, /case_index.*重跑/);
});
for (const [name, options] of [['missing sources', { skipped: 2 }], ['unmatched case', { extra: true }]] as const)
  test(`${name} preserves known support and adds a document-level evidence gap`, () => {
    const outcomes = commandOutcomes(fixture(baseDocument(), options).subject);
    assert.equal(outcomes[0]!.verdict, 'support'); const gap = outcomes.at(-1)!;
    assert.equal(gap.verdict, 'unknown'); assert.equal(gap.data?.scope, 'document'); assert.ok(gap.data?.next_action);
    assert.ok(!gap.statement.includes('覆盖完整'));
    if ('skipped' in options) { assert.equal(gap.data?.skipped_sources, 2); assert.equal(gap.data?.unplaced_root, null); assert.ok((gap.data?.notes as string[]).includes('未归位条目 3 个，标在根下')); }
    else assert.equal(gap.data?.unmatched_cases_count, 1);
  });
test('incomplete evidence changes a potential shortfall into unknown instead of refuting', () => {
  const outcomes = commandOutcomes(fixture(withoutCategory(baseDocument(), 'audit_log'), { skipped: 1 }).subject);
  assert.equal(outcomes[0]!.verdict, 'unknown'); assert.deepEqual(outcomes[0]!.data?.missing_categories, ['audit_log']);
  assert.equal(outcomes.at(-1)!.data?.scope, 'document');
});

for (const options of [{ truncated: true }, { cut: true }]) test('truncation retains support and gives a bounded re-read or capability-gap action', () => {
  const outcomes = commandOutcomes(fixture(baseDocument(), options).subject);
  assert.equal(outcomes[0]!.verdict, 'support'); const gap = outcomes.at(-1)!;
  assert.equal(gap.verdict, 'unknown'); assert.match(String(gap.data?.next_action), /知识同步后.*重跑.*能力缺口/);
});

test('declared command samples are schema-valid and every unknown carries missing facts and an action', async () => {
  const { commandSampleSubjects } = await import('../testing/command-samples.ts');
  const { CheckOutcome } = await import('../../../../contracts/src/tables.ts');
  for (const sample of commandSampleSubjects()) {
    const outcomes = commandOutcomes(sample.subject);
    assert.deepEqual(outcomes.map(o => o.verdict), sample.verdicts, sample.id);
    for (const outcome of outcomes) {
      assert.equal(CheckOutcome.safeParse(outcome).success, true, sample.id);
      if (outcome.verdict === 'unknown') {
        assert.ok((outcome.data?.missing as unknown[]).length > 0); assert.ok(outcome.data?.next_action);
        const recovery = outcome.data!.recovery as { action: string; object: object; deadline: string; attempts: number };
        assert.ok(recovery.action); assert.ok(Object.keys(recovery.object).length > 0); assert.match(recovery.deadline, /本轮最终回报前/); assert.equal(recovery.attempts, 1);
      }
    }
  }
});

test('paired transitional examples resolve after facts are supplied and every unknown has a bounded recovery', async () => {
  const { commandTransitionalExamples } = await import('../testing/command-samples.ts');
  for (const pair of commandTransitionalExamples()) {
    for (const sample of [pair.pending, pair.restored]) {
      const outcomes = commandOutcomes(sample.subject);
      assert.deepEqual(outcomes.map(o => o.verdict), sample.expect.map(e => e.verdict), sample.id);
      for (const outcome of outcomes.filter(o => o.verdict === 'unknown')) {
        assert.ok((outcome.data!.missing as unknown[]).length > 0);
        const recovery = outcome.data!.recovery as { action: string; object: { document: string }; deadline: string; attempts: number };
        assert.ok(recovery.action.includes('重跑')); assert.equal(recovery.object.document, '900001'); assert.match(recovery.deadline, /本轮最终回报前/); assert.equal(recovery.attempts, 1);
      }
    }
    assert.ok(commandOutcomes(pair.restored.subject).every(o => o.verdict !== 'unknown'));
  }
});
