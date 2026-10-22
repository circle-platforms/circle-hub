// The counts check: run-level facts of the matrix (defects, traced, untraced) with the view facts that bound what the
// counts can say. When a view declares itself complete (not truncated) its stated totals must equal what it lists; a
// mismatch is an advisory refutation of the counts, because the view contradicts itself.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { countsOutcome } from './counts.ts';
import { projectItems } from './project.ts';
import { buildSubject } from './subject.ts';
import { boundPair, caseEntry, defectEntry } from './test-support.ts';

const CONTEXT = { product: 'apv', names: ['APV', 'NSAE'], line: null, build: null, root: null, parameters: {}, groups: [] };

function subjectOf(defects: ReturnType<typeof defectEntry>[], cases: ReturnType<typeof caseEntry>[], options: { defectsView?: Record<string, unknown>; casesView?: Record<string, unknown>; statuses?: unknown } = {}) {
  const pair = boundPair(defects, cases, options);
  const parameters = options.statuses === undefined ? {} : { statuses: options.statuses };
  const projected = projectItems({ inputs: pair.inputs, parameters, context: { ...CONTEXT, parameters } });
  assert.ok(!('error' in projected));
  const items = projected.items.map((it) => ({ id: it.id, label: it.label, location: `src:${it.location.source}/json@1/${it.location.selector}`, fields: it.fields }));
  return { subject: buildSubject({ applies: 'run', items, context: { ...CONTEXT, parameters, groups: projected.groups ?? [] } }), projected };
}

describe('countsOutcome', () => {
  it('counts the defects, the traced and the untraced, and grounds on the two views', () => {
    const defects = [defectEntry({ bug: '7001' }), defectEntry({ bug: '7002' }), defectEntry({ bug: '7003', status: 'known' })];
    const cases = [caseEntry({ defects: ['7001'], case: 'C-1' }), caseEntry({ defects: ['7003'], case: 'C-2' })];
    const { subject, projected } = subjectOf(defects, cases);
    const outcome = countsOutcome(subject);
    assert.equal(outcome.verdict, 'support');
    assert.equal(outcome.tier, 'advisory');
    assert.equal(outcome.item, undefined);
    const data = outcome.data as { defects: number; traced: number; untraced: number; conflicts: number; statuses: string[]; build: string };
    assert.deepEqual([data.defects, data.traced, data.untraced, data.conflicts], [3, 2, 1, 0]);
    assert.deepEqual(data.statuses, ['fixed', 'known']);
    assert.equal(data.build, 'Rel_APV_10_6_1_57');
    assert.match(outcome.statement, /缺陷 3 个/);
    assert.match(outcome.statement, /已追溯 2 个/);
    assert.match(outcome.statement, /未追溯 1 个/);
    const groups = projected.groups as Array<{ views: { defects: { source: string }; cases: { source: string } } }>;
    assert.deepEqual(outcome.grounds, [groups[0].views.defects.source, groups[0].views.cases.source]);
  });

  it('counts a conflicted defect by its cases and reports the conflicts apart', () => {
    const defects = [defectEntry({ bug: '7004', status: 'fixed' }), defectEntry({ bug: '7004', status: 'known' }), defectEntry({ bug: '7005' })];
    const { subject } = subjectOf(defects, [caseEntry({ defects: ['7004'], case: 'C-1' })]);
    const outcome = countsOutcome(subject);
    assert.equal(outcome.verdict, 'support');
    const data = outcome.data as { defects: number; traced: number; untraced: number; conflicts: number };
    assert.deepEqual([data.defects, data.traced, data.untraced, data.conflicts], [2, 1, 1, 1]);
  });

  it('refuses to state the counts of a view that declares itself complete but lists fewer keys than its totals', () => {
    const { subject } = subjectOf([defectEntry({ bug: '7006' })], [], { defectsView: { total_keys: 5 } });
    const outcome = countsOutcome(subject);
    assert.deepEqual([outcome.verdict, outcome.code, outcome.tier], ['refute', 'traceability.count_mismatch', 'advisory']);
    assert.match(outcome.statement, /缺陷索引/);
  });

  it('refuses the counts when the cases view lists fewer entries than its stated totals while not truncated', () => {
    const { subject } = subjectOf([defectEntry({ bug: '7007' })], [caseEntry({ defects: ['7007'], case: 'C-1' })], { casesView: { total_entries: 9 } });
    const outcome = countsOutcome(subject);
    assert.deepEqual([outcome.verdict, outcome.code], ['refute', 'traceability.count_mismatch']);
    assert.match(outcome.statement, /用例索引/);
  });

  it('a truncated view is not a mismatch: the counts cover the listed part and the statement says so', () => {
    const { subject } = subjectOf([defectEntry({ bug: '7008' })], [], { defectsView: { total_keys: 5, truncated: true } });
    const outcome = countsOutcome(subject);
    assert.equal(outcome.verdict, 'support');
    assert.match(outcome.statement, /截断/);
  });

  it('the statement names the listed sources that were not read', () => {
    const { subject } = subjectOf([defectEntry({ bug: '7009' })], [], { casesView: { skipped: 4 } });
    const outcome = countsOutcome(subject);
    assert.match(outcome.statement, /4 份列出的来源没有读取/);
  });

  it('an empty subject is an unknown, not a silent pass', () => {
    const outcome = countsOutcome(buildSubject({ applies: 'run', items: [], context: CONTEXT }));
    assert.deepEqual([outcome.verdict, outcome.reason], ['unknown', 'check_error']);
  });
});
