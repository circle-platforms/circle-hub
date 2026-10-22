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

  describe('top five cases statement in support outcome', () => {
    it('1 个用例：列出该用例，不写另有', () => {
      const defect = defectEntry({ bug: '7021' });
      const kase = caseEntry({ defects: ['7021'], document: '24001', case: 'C-1', title: '单用例测试' });
      const outcome = byItem(traceOutcomes(subjectOf([defect], [kase])), '7021');
      assert.equal(outcome.verdict, 'support');
      assert.equal(outcome.statement, '缺陷 7021（发布说明：已修复；缺陷系统：未知（缺陷系统不明，不按编号查 PLM））：1 个已索引用例追溯：24001:C-1 单用例测试');
    });

    it('恰好 5 个用例：列出全部 5 个，不写另有', () => {
      const defect = defectEntry({ bug: '7022' });
      const cases = [1, 2, 3, 4, 5].map((i) =>
        caseEntry({ defects: ['7022'], document: '24001', case: `C-${i}`, title: `用例 ${i}` }),
      );
      const outcome = byItem(traceOutcomes(subjectOf([defect], cases)), '7022');
      assert.equal(outcome.verdict, 'support');
      assert.equal(
        outcome.statement,
        '缺陷 7022（发布说明：已修复；缺陷系统：未知（缺陷系统不明，不按编号查 PLM））：5 个已索引用例追溯：24001:C-1 用例 1；24001:C-2 用例 2；24001:C-3 用例 3；24001:C-4 用例 4；24001:C-5 用例 5',
      );
    });

    it('6 个用例：列出前 5 个，末尾写另有 1 个', () => {
      const defect = defectEntry({ bug: '7023' });
      const cases = [1, 2, 3, 4, 5, 6].map((i) =>
        caseEntry({ defects: ['7023'], document: '24001', case: `C-${i}`, title: `用例 ${i}` }),
      );
      const outcome = byItem(traceOutcomes(subjectOf([defect], cases)), '7023');
      assert.equal(outcome.verdict, 'support');
      assert.equal(
        outcome.statement,
        '缺陷 7023（发布说明：已修复；缺陷系统：未知（缺陷系统不明，不按编号查 PLM））：6 个已索引用例追溯：24001:C-1 用例 1；24001:C-2 用例 2；24001:C-3 用例 3；24001:C-4 用例 4；24001:C-5 用例 5；另有 1 个',
      );
    });

    it('标题很长被截短：超过 30 个字符的标题截短到 30 个字符（含省略号）', () => {
      const defect = defectEntry({ bug: '7024' });
      const longTitle = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十超出部分';
      const kase = caseEntry({ defects: ['7024'], document: '24001', case: 'C-long', title: longTitle });
      const outcome = byItem(traceOutcomes(subjectOf([defect], [kase])), '7024');
      assert.equal(outcome.verdict, 'support');
      assert.equal(
        outcome.statement,
        '缺陷 7024（发布说明：已修复；缺陷系统：未知（缺陷系统不明，不按编号查 PLM））：1 个已索引用例追溯：24001:C-long 一二三四五六七八九十一二三四五六七八九十一二三四五六七八九…',
      );
    });

    it('顺序：文档号按数值从小到大，同一文档里按用例号字符串升序', () => {
      const defect = defectEntry({ bug: '7025' });
      const cases = [
        caseEntry({ defects: ['7025'], document: '24002', case: 'B', title: '文档24002的B' }),
        caseEntry({ defects: ['7025'], document: '24001', case: 'b', title: '文档24001的b' }),
        caseEntry({ defects: ['7025'], document: '24001', case: 'a', title: '文档24001的a' }),
        caseEntry({ defects: ['7025'], document: '9001', case: 'Z', title: '文档9001的Z' }),
      ];
      const outcome = byItem(traceOutcomes(subjectOf([defect], cases)), '7025');
      assert.equal(outcome.verdict, 'support');
      assert.equal(
        outcome.statement,
        '缺陷 7025（发布说明：已修复；缺陷系统：未知（缺陷系统不明，不按编号查 PLM））：4 个已索引用例追溯：9001:Z 文档9001的Z；24001:a 文档24001的a；24001:b 文档24001的b；24002:B 文档24002的B',
      );
    });
  });

  describe('defect system status from PLM expected sources', () => {
    it('carries closed status when PLM returns closed', () => {
      const defect = defectEntry({ bug: '7041', system: 'plm' });
      const kase = caseEntry({ defects: ['7041'], document: '24001', case: 'C-1', title: '闭环测试' });
      const sources = {
        'plm:bugs:7041': JSON.stringify({
          bugs: [{ id: '7041', status: 'closed', title: '严重问题' }],
          unread: [],
        }),
      };
      const outcome = byItem(traceOutcomes(subjectOf([defect], [kase]), sources), '7041');
      assert.equal(outcome.verdict, 'support');
      assert.equal(outcome.statement, '缺陷 7041（发布说明：已修复；缺陷系统：closed）：1 个已索引用例追溯：24001:C-1 闭环测试');
      const data = outcome.data as { defect_system_status: string; defect_system_unknown_reason: string | null; closed: boolean };
      assert.equal(data.defect_system_status, 'closed');
      assert.equal(data.defect_system_unknown_reason, null);
      assert.equal(data.closed, true);
    });

    it('carries active status and closed is false when status not in closed table', () => {
      const defect = defectEntry({ bug: '7042', system: 'plm' });
      const kase = caseEntry({ defects: ['7042'], document: '24001', case: 'C-2', title: '活动测试' });
      const sources = {
        'plm:bugs:7042': JSON.stringify({
          bugs: [{ id: '7042', status: 'active', title: '未关闭' }],
          unread: [],
        }),
      };
      const outcome = byItem(traceOutcomes(subjectOf([defect], [kase]), sources), '7042');
      assert.equal(outcome.verdict, 'support');
      assert.equal(outcome.statement, '缺陷 7042（发布说明：已修复；缺陷系统：active）：1 个已索引用例追溯：24001:C-2 活动测试');
      const data = outcome.data as { defect_system_status: string; closed: boolean };
      assert.equal(data.defect_system_status, 'active');
      assert.equal(data.closed, false);
    });

    it('marks unknown with reason when unread in PLM', () => {
      const defect = defectEntry({ bug: '7043', system: 'plm' });
      const sources = {
        'plm:bugs:7043': JSON.stringify({
          bugs: [],
          unread: ['7043'],
        }),
      };
      const outcome = byItem(traceOutcomes(subjectOf([defect], []), sources), '7043');
      assert.equal(outcome.verdict, 'unknown');
      assert.match(outcome.statement, /缺陷 7043（发布说明：已修复；缺陷系统：未知（缺陷系统没有返回这个编号））：没有已索引的用例标出缺陷 7043/);
      const data = outcome.data as { defect_system_status: string | null; defect_system_unknown_reason: string; closed: boolean };
      assert.equal(data.defect_system_status, null);
      assert.equal(data.defect_system_unknown_reason, '缺陷系统没有返回这个编号');
      assert.equal(data.closed, false);
    });

    it('marks unknown with bugzilla reason when system is bugzilla', () => {
      const defect = defectEntry({ bug: '7044', system: 'bugzilla' });
      const outcome = byItem(traceOutcomes(subjectOf([defect], [])), '7044');
      assert.equal(outcome.verdict, 'unknown');
      assert.match(outcome.statement, /缺陷 7044（发布说明：已修复；缺陷系统：未知（系统为 bugzilla，不从 PLM 查询））：没有已索引的用例标出缺陷 7044/);
      const data = outcome.data as { defect_system_status: string | null; defect_system_unknown_reason: string; closed: boolean };
      assert.equal(data.defect_system_status, null);
      assert.equal(data.defect_system_unknown_reason, '系统为 bugzilla，不从 PLM 查询');
      assert.equal(data.closed, false);
    });

    it('marks unknown when system is unspecified', () => {
      const defect = defectEntry({ bug: '7045' });
      const sources = {
        'plm:bugs:7045': JSON.stringify({
          bugs: [{ id: '7045', status: 'closed' }],
          unread: [],
        }),
      };
      const outcome = byItem(traceOutcomes(subjectOf([defect], []), sources), '7045');
      assert.equal(outcome.verdict, 'unknown');
      assert.match(outcome.statement, /缺陷 7045（发布说明：已修复；缺陷系统：未知（缺陷系统不明，不按编号查 PLM））：没有已索引的用例标出缺陷 7045/);
      const data = outcome.data as { defect_system_status: string | null; defect_system_unknown_reason: string; closed: boolean };
      assert.equal(data.defect_system_status, null);
      assert.equal(data.defect_system_unknown_reason, '缺陷系统不明，不按编号查 PLM');
      assert.equal(data.closed, false);
    });

    it('marks unknown when PLM record has no status', () => {
      const defect = defectEntry({ bug: '7046', system: 'plm' });
      const sources = {
        'plm:bugs:7046': JSON.stringify({
          bugs: [{ id: '7046' }],
          unread: [],
        }),
      };
      const outcome = byItem(traceOutcomes(subjectOf([defect], []), sources), '7046');
      assert.equal(outcome.verdict, 'unknown');
      assert.match(outcome.statement, /缺陷 7046（发布说明：已修复；缺陷系统：未知（缺陷系统的记录里没有状态））：没有已索引的用例标出缺陷 7046/);
      const data = outcome.data as { defect_system_status: string | null; defect_system_unknown_reason: string; closed: boolean };
      assert.equal(data.defect_system_status, null);
      assert.equal(data.defect_system_unknown_reason, '缺陷系统的记录里没有状态');
      assert.equal(data.closed, false);
    });

    it('marks unknown when PLM source is unavailable', () => {
      const defect = defectEntry({ bug: '7047', system: 'plm' });
      const outcome = byItem(traceOutcomes(subjectOf([defect], []), {}), '7047');
      assert.equal(outcome.verdict, 'unknown');
      assert.match(outcome.statement, /缺陷 7047（发布说明：已修复；缺陷系统：未知（缺陷系统没有读到（来源不可用）））：没有已索引的用例标出缺陷 7047/);
      const data = outcome.data as { defect_system_status: string | null; defect_system_unknown_reason: string; closed: boolean };
      assert.equal(data.defect_system_status, null);
      assert.equal(data.defect_system_unknown_reason, '缺陷系统没有读到（来源不可用）');
      assert.equal(data.closed, false);
    });
  });
});
