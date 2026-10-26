// The counts check: run-level facts of the matrix (defects, traced, untraced) with the view facts that bound what the
// counts can say. When a view declares itself complete (not truncated) its stated totals must equal what it lists; a
// mismatch is an advisory refutation of the counts, because the view contradicts itself.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { countsOutcome } from './counts.ts';
import { projectItems } from './project.ts';
import { buildSubject } from './subject.ts';
import { boundPair, caseEntry, defectEntry } from './test-support.ts';

const CONTEXT = { product: 'famx', names: ['FAMX', 'FAMY'], line: null, build: null, root: null, parameters: {}, groups: [] };

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
    const data = outcome.data as { defects: number; traced: number; untraced: number; conflicts: number; statuses: string[]; build: string; status_unknown: number };
    assert.deepEqual([data.defects, data.traced, data.untraced, data.conflicts], [3, 2, 1, 0]);
    assert.equal(data.status_unknown, 3);
    assert.deepEqual(data.statuses, ['fixed', 'known']);
    assert.equal(data.build, 'Rel_FAMX_10_6_1_57');
    assert.match(outcome.statement, /缺陷 3 个/);
    assert.match(outcome.statement, /已追溯 2 个/);
    assert.match(outcome.statement, /未追溯 1 个/);
    assert.match(outcome.statement, /其中已关闭缺陷 0 个/);
    assert.match(outcome.statement, /缺陷系统状态未知 3 个（不算已关闭也不算未关闭）/);
    const groups = projected.groups as Array<{ views: { defects: { source: string }; cases: { source: string } } }>;
    assert.deepEqual(outcome.grounds, [groups[0].views.defects.source, groups[0].views.cases.source]);
  });

  it('counts closed defects and partitions traced vs untraced when PLM sources are provided', () => {
    const defects = [
      defectEntry({ bug: '7011', system: 'plm' }),
      defectEntry({ bug: '7012', system: 'plm' }),
      defectEntry({ bug: '7013', system: 'plm' }),
      defectEntry({ bug: '7014', system: 'bugzilla' }),
    ];
    const cases = [
      caseEntry({ defects: ['7011'], case: 'C-1' }),
    ];
    const { subject } = subjectOf(defects, cases);
    const sources = {
      'plm:bugs:7011+7012+7013': JSON.stringify({
        bugs: [
          { id: '7011', status: 'closed' },
          { id: '7012', status: 'closed' },
          { id: '7013', status: 'active' },
        ],
        unread: [],
      }),
    };
    const outcome = countsOutcome(subject, sources);
    assert.equal(outcome.verdict, 'support');
    const data = outcome.data as {
      defects: number;
      traced: number;
      untraced: number;
      closed_defects: number;
      closed_traced: number;
      closed_untraced: number;
      status_unknown: number;
      status_unread: number;
    };
    assert.equal(data.defects, 4);
    assert.equal(data.traced, 1);
    assert.equal(data.untraced, 3);
    assert.equal(data.closed_defects, 2);
    assert.equal(data.closed_traced, 1);
    assert.equal(data.closed_untraced, 1);
    assert.equal(data.status_unknown, 0);
    assert.equal(data.status_unread, 1);
    assert.match(outcome.statement, /已关闭缺陷 2 个：已追溯 1 个，未追溯 1 个；缺陷系统状态未知 0 个（不算已关闭也不算未关闭）/);
  });

  it('custom closed table changes the set of statuses counted as closed', () => {
    const defects = [
      defectEntry({ bug: '7015', system: 'plm' }),
      defectEntry({ bug: '7016', system: 'plm' }),
    ];
    const { subject } = subjectOf(defects, []);
    const sources = {
      'plm:bugs:7015+7016': JSON.stringify({
        bugs: [
          { id: '7015', status: 'closed' },
          { id: '7016', status: 'resolved' },
        ],
      }),
    };
    // Default table: only closed is counted
    const outcomeDefault = countsOutcome(subject, sources);
    const dataDefault = outcomeDefault.data as { closed_defects: number; status_unknown: number };
    assert.equal(dataDefault.closed_defects, 1);
    assert.equal(dataDefault.status_unknown, 0);
    assert.match(outcomeDefault.statement, /已关闭缺陷 1 个：已追溯 0 个，未追溯 1 个；缺陷系统状态未知 0 个（不算已关闭也不算未关闭）/);

    // Custom table including resolved
    const outcomeCustom = countsOutcome(subject, sources, { statuses: ['closed', 'resolved'] });
    const dataCustom = outcomeCustom.data as { closed_defects: number; closed_untraced: number; status_unknown: number };
    assert.equal(dataCustom.closed_defects, 2);
    assert.equal(dataCustom.closed_untraced, 2);
    assert.equal(dataCustom.status_unknown, 0);
    assert.match(outcomeCustom.statement, /已关闭缺陷 2 个：已追溯 0 个，未追溯 2 个；缺陷系统状态未知 0 个（不算已关闭也不算未关闭）/);
  });

  it('verifies that status_unknown defects do not count towards closed_defects even if traced', () => {
    const defects = [
      defectEntry({ bug: '7021', system: 'plm' }), // traced, but status null in PLM -> unknown
      defectEntry({ bug: '7022', system: 'plm' }), // traced, but unread -> unknown
      defectEntry({ bug: '7023', system: 'plm' }), // traced, closed
      defectEntry({ bug: '7024' }),                 // traced, unspecified system -> unknown
    ];
    const cases = [
      caseEntry({ defects: ['7021'], case: 'C-21' }),
      caseEntry({ defects: ['7022'], case: 'C-22' }),
      caseEntry({ defects: ['7023'], case: 'C-23' }),
      caseEntry({ defects: ['7024'], case: 'C-24' }),
    ];
    const { subject } = subjectOf(defects, cases);
    const sources = {
      'plm:bugs:7021+7022+7023': JSON.stringify({
        bugs: [
          { id: '7021' }, // no status
          { id: '7023', status: 'closed' },
        ],
        unread: ['7022'],
      }),
    };
    const outcome = countsOutcome(subject, sources);
    assert.equal(outcome.verdict, 'support');
    const data = outcome.data as {
      defects: number;
      traced: number;
      untraced: number;
      closed_defects: number;
      closed_traced: number;
      closed_untraced: number;
      status_unknown: number;
      status_unread: number;
    };
    assert.equal(data.defects, 4);
    assert.equal(data.traced, 4);
    assert.equal(data.untraced, 0);
    assert.equal(data.closed_defects, 1); // only 7023
    assert.equal(data.closed_traced, 1);
    assert.equal(data.closed_untraced, 0);
    assert.equal(data.status_unknown, 3); // 7021, 7022, 7024
    assert.match(outcome.statement, /已关闭缺陷 1 个：已追溯 1 个，未追溯 0 个；缺陷系统状态未知 3 个（不算已关闭也不算未关闭）/);
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

  it('counts unknown defects when unread_sources reports an unavailable source', () => {
    const defects = [
      defectEntry({ bug: '7021', system: 'plm' }),
      defectEntry({ bug: '7022', system: 'plm' }),
    ];
    const { subject } = subjectOf(defects, []);
    const unreadSources = [{ reference: 'src:2222222222222222222222222222222222222222222222222222222222222222', reason: '来源不可用' }];
    const outcome = countsOutcome(subject, {}, undefined, unreadSources);
    assert.equal(outcome.verdict, 'support');
    const data = outcome.data as { defects: number; closed_defects: number; status_unknown: number };
    assert.equal(data.defects, 2);
    assert.equal(data.closed_defects, 0);
    assert.equal(data.status_unknown, 2);
    assert.match(outcome.statement, /缺陷系统状态未知 2 个（不算已关闭也不算未关闭）/);
  });

  it('an empty subject is an unknown, not a silent pass', () => {
    const outcome = countsOutcome(buildSubject({ applies: 'run', items: [], context: CONTEXT }));
    assert.deepEqual([outcome.verdict, outcome.reason], ['unknown', 'check_error']);
  });
});
