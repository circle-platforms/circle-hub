// The traced check: one outcome per defect item, computed from the frozen item fields. Support lists the cases (ids,
// titles, documents, sorted) and grounds on the tree references of the defect and case entries; an untraced defect is an
// UNKNOWN (missing input) whose reason says the index cannot prove absence; a status conflict and a case list that does
// not re-verify against the raw ids are the two advisory refutations (the publish check needs a negative sample).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { traceOutcomes } from './check.ts';
import { projectItems } from './project.ts';
import { buildSubject } from './subject.ts';
import { boundPair, caseEntry, defectEntry } from './test-support.ts';
import type { CheckOutcome, MatrixRow } from './types.ts';

const CONTEXT = { product: 'apv', names: ['APV', 'NSAE'], line: null, build: null, root: null, parameters: {}, groups: [] };

type Fields = MatrixRow;

/** Projects the corpus and builds the check's subject, as a run does (projection -> frozen items -> subject builder). */
function subjectOf(defects: ReturnType<typeof defectEntry>[], cases: ReturnType<typeof caseEntry>[], options: { defectsView?: Record<string, unknown>; casesView?: Record<string, unknown>; edit?: (fields: Fields) => void } = {}) {
  const pair = boundPair(defects, cases, options);
  const projected = projectItems({ inputs: pair.inputs, parameters: {}, context: CONTEXT });
  assert.ok(!('error' in projected));
  const items = projected.items.map((it) => {
    const fields = it.fields as Fields;
    options.edit?.(fields);
    return { id: it.id, label: it.label, location: `src:${it.location.source}/json@1/${it.location.selector}`, fields };
  });
  return buildSubject({ applies: 'run', items, context: { ...CONTEXT, groups: projected.groups ?? [] } });
}

const byItem = (outcomes: CheckOutcome[], id: string): CheckOutcome => {
  const found = outcomes.find((o) => o.item === id);
  assert.ok(found, `an outcome for ${id}`);
  return found;
};

describe('traceOutcomes', () => {
  it('a defect with cases: support, the sorted cases in data, the defect and case tree references as grounds', () => {
    const defect = defectEntry({ bug: '7001' });
    const b = caseEntry({ defects: ['7001'], case: 'C-b', title: '乙用例' });
    const a = caseEntry({ defects: ['7001'], case: 'C-a', title: '甲用例' });
    const outcomes = traceOutcomes(subjectOf([defect], [b, a]));
    const outcome = byItem(outcomes, '7001');
    assert.equal(outcome.verdict, 'support');
    assert.equal(outcome.tier, 'advisory');
    assert.equal(outcome.pointer, '/items/0/fields');
    assert.match(outcome.statement, /2 个已索引用例/);
    const data = outcome.data as { cases: Array<{ case: string; title: string; document: string; reference: string }>; status: string; case_count: number };
    assert.equal(data.case_count, 2);
    assert.deepEqual(
      data.cases.map((c) => [c.case, c.title, c.document, c.reference]),
      [
        ['C-a', '甲用例', '24001', a.reference],
        ['C-b', '乙用例', '24001', b.reference],
      ],
    );
    assert.deepEqual(outcome.grounds, [defect.reference, a.reference, b.reference]);
  });

  it('a defect no indexed case names: unknown (missing input), saying the index cannot prove absence', () => {
    const defect = defectEntry({ bug: '7002' });
    const outcomes = traceOutcomes(subjectOf([defect], []));
    const outcome = byItem(outcomes, '7002');
    assert.deepEqual([outcome.verdict, outcome.reason], ['unknown', 'missing_input']);
    assert.match(outcome.statement, /没有已索引的用例标出缺陷 7002/);
    assert.match(outcome.statement, /索引按构造不完整/);
    assert.match(outcome.statement, /不等于没有/);
    assert.deepEqual(outcome.grounds, [defect.reference]);
    assert.equal((outcome.data as { cases: unknown[] }).cases.length, 0);
  });

  it('a bug of two systems: the statement carries the systems and the collision note, data.systems lists them', () => {
    const plm = defectEntry({ bug: '7030', system: 'plm' });
    const bz = defectEntry({ bug: '7030', system: 'bugzilla' });
    const kase = caseEntry({ defects: ['7030'], case: 'C-s' });
    const outcomes = traceOutcomes(subjectOf([plm, bz], [kase]));
    const outcome = byItem(outcomes, '7030');
    assert.equal(outcome.verdict, 'support');
    assert.match(outcome.statement, /系统 bugzilla、plm（两个系统的缺陷号可能撞号）/);
    assert.deepEqual((outcome.data as { systems: string[] }).systems, ['bugzilla', 'plm']);
  });

  it('the unknown reason says how many listed sources were not read, and whether the index view was cut', () => {
    const defect = defectEntry({ bug: '7003' });
    const outcomes = traceOutcomes(subjectOf([defect], [], { casesView: { skipped: 3, truncated: true } }));
    const outcome = byItem(outcomes, '7003');
    assert.match(outcome.statement, /3 份列出的来源没有读取/);
    assert.match(outcome.statement, /索引视图被截断/);
  });

  it('a known defect is an item too, marked by its status', () => {
    const defect = defectEntry({ bug: '7004', status: 'known' });
    const kase = caseEntry({ defects: ['7004'], case: 'C-k' });
    const outcome = byItem(traceOutcomes(subjectOf([defect], [kase])), '7004');
    assert.equal(outcome.verdict, 'support');
    assert.equal((outcome.data as { status: string }).status, 'known');
    assert.match(outcome.statement, /已知（未修复）/);
  });

  it('a bug listed as fixed in one entry and known in another is refuted as a status conflict (advisory)', () => {
    const outcomes = traceOutcomes(subjectOf([defectEntry({ bug: '7005', status: 'fixed' }), defectEntry({ bug: '7005', status: 'known' })], [caseEntry({ defects: ['7005'], case: 'C-c' })]));
    const outcome = byItem(outcomes, '7005');
    assert.deepEqual([outcome.verdict, outcome.code, outcome.tier], ['refute', 'traceability.status_conflict', 'advisory']);
    assert.match(outcome.statement, /状态矛盾/);
    assert.deepEqual((outcome.data as { statuses: string[] }).statuses, ['fixed', 'known']);
  });

  it('a listed case whose raw defect ids do not contain the bug refutes the join (the subject contradicts itself)', () => {
    const defect = defectEntry({ bug: '7006' });
    const kase = caseEntry({ defects: ['7006'], case: 'C-j' });
    const outcomes = traceOutcomes(
      subjectOf([defect], [kase], {
        edit: (fields) => {
          fields.cases[0].defects = ['7999'];
        },
      }),
    );
    const outcome = byItem(outcomes, '7006');
    assert.deepEqual([outcome.verdict, outcome.code], ['refute', 'traceability.join_mismatch']);
    assert.match(outcome.statement, /C-j/);
  });

  it('an item with malformed fields is unknown (check error), never silently passed', () => {
    const defect = defectEntry({ bug: '7007' });
    const outcomes = traceOutcomes(
      subjectOf([defect], [], {
        edit: (fields) => {
          (fields as { cases: unknown }).cases = 'not a list';
        },
      }),
    );
    const outcome = byItem(outcomes, '7007');
    assert.deepEqual([outcome.verdict, outcome.reason], ['unknown', 'check_error']);
  });

  it('an empty subject gives one unknown outcome instead of a silent pass', () => {
    const outcomes = traceOutcomes(buildSubject({ applies: 'run', items: [], context: CONTEXT }));
    assert.equal(outcomes.length, 1);
    assert.deepEqual([outcomes[0].verdict, outcomes[0].reason], ['unknown', 'check_error']);
  });

  it('answers the items in their order, one outcome each', () => {
    const defects = [defectEntry({ bug: '7008' }), defectEntry({ bug: '7009' }), defectEntry({ bug: '7010' })];
    const kase = caseEntry({ defects: ['7009'], case: 'C-1' });
    const outcomes = traceOutcomes(subjectOf(defects, [kase]));
    assert.deepEqual(
      outcomes.map((o) => [o.item, o.verdict]),
      [
        ['7008', 'unknown'],
        ['7009', 'support'],
        ['7010', 'unknown'],
      ],
    );
  });
});
