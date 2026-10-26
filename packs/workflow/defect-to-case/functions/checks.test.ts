import {QUOTE_BYTES,QUOTE_SOURCE} from '../testing/structure.ts';
import {nativeStep} from '../testing/structure.ts';
import {checkCommandsRefutation} from '../testing/checks.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PackCheckInput } from '../../../../hub/rules/api.ts';
import {
  INCOMPLETE_INDEX_VIEW,
  SYNTHETIC_CATALOG,
  SYNTHETIC_INDEX_VIEW,
  SYNTHETIC_INDEX_VIEW_COMPLETE,
  makeDuplicateDraft,
  makeGoodDraft,
  makeNegativeExpectedRefutationDraft,
  makeNegativeUnexpectedAcceptDraft,
} from '../testing/fixtures.ts';
import {
  checkDraftShape,
  checkDuplicate,
  checkGroundedReading,
  countDuplicateClaims,
  DUPLICATE_CLAIM_RULE,
  duplicateClaimCountKey,
} from './checks.ts';
import { CODES } from './types.ts';

function makeCheckInput(subject: unknown, catalog = SYNTHETIC_CATALOG, sources: Record<string, string> = {}): PackCheckInput {
  return {
    check: 'test_check',
    table: null,
    subject,
    context: {
      run: 'run_123',
      pack: 'defect-to-case',
      sets: {},
    },
    sources: { ['src:'+QUOTE_SOURCE]:QUOTE_BYTES,...sources },
    catalog,
  };
}

describe('pack checks', () => {
  describe('checkDraftShape', () => {
    it('supports a good draft', () => {
      const good = makeGoodDraft();
      const input = makeCheckInput({
        item: '74001',
        slots: { cases: [{ text: good.title, data: good }] },
      });
      const outcomes = checkDraftShape(input);
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].verdict, 'support');
    });

    it('refutes a draft with empty title or title > 200 characters', () => {
      const emptyTitle = { ...makeGoodDraft(), title: '   ' };
      const longTitle = { ...makeGoodDraft(), title: 'x'.repeat(201) };
      const input1 = makeCheckInput({
        item: '74001',
        slots: { cases: [{ text: emptyTitle.title, data: emptyTitle }] },
      });
      const outcomes1 = checkDraftShape(input1);
      assert.equal(outcomes1[0].verdict, 'refute');
      assert.equal(outcomes1[0].code, CODES.SHAPE_INVALID);

      const input2 = makeCheckInput({
        item: '74001',
        slots: { cases: [{ text: longTitle.title, data: longTitle }] },
      });
      const outcomes2 = checkDraftShape(input2);
      assert.equal(outcomes2[0].verdict, 'refute');
      assert.equal(outcomes2[0].code, CODES.SHAPE_INVALID);
    });

    it('refutes a draft with no steps or step with empty command line', () => {
      const noSteps = { ...makeGoodDraft(), steps: [] };
      const emptyCmd = { ...makeGoodDraft(), steps: [{ command: '   ' }] };
      const outcomes1 = checkDraftShape(makeCheckInput({ item: '74001', slots: { cases: [{ text: 'a', data: noSteps }] } }));
      assert.equal(outcomes1[0].verdict, 'refute');
      assert.equal(outcomes1[0].code, CODES.SHAPE_INVALID);

      const outcomes2 = checkDraftShape(makeCheckInput({ item: '74001', slots: { cases: [{ text: 'b', data: emptyCmd }] } }));
      assert.equal(outcomes2[0].verdict, 'refute');
      assert.equal(outcomes2[0].code, CODES.SHAPE_INVALID);
    });

    it('refutes a draft with no expected result', () => {
      const noExpected = { ...makeGoodDraft(), expected: [] };
      const outcomes = checkDraftShape(makeCheckInput({ item: '74001', slots: { cases: [{ text: 'c', data: noExpected }] } }));
      assert.equal(outcomes[0].verdict, 'refute');
      assert.equal(outcomes[0].code, CODES.SHAPE_INVALID);
    });

    it('refutes priority out of range (not in 1..3)', () => {
      const badPriority = { ...makeGoodDraft(), priority: 5 };
      const outcomes = checkDraftShape(makeCheckInput({ item: '74001', slots: { cases: [{ text: 'd', data: badPriority }] } }));
      assert.equal(outcomes[0].verdict, 'refute');
      assert.equal(outcomes[0].code, CODES.SHAPE_INVALID);
    });

    it('refutes tags outside team template categories', () => {
      const badTag = { ...makeGoodDraft(), resource: ['UnknownTagCategory'] };
      const outcomes = checkDraftShape(makeCheckInput({ item: '74001', slots: { cases: [{ text: 'e', data: badTag }] } }));
      assert.equal(outcomes[0].verdict, 'refute');
      assert.equal(outcomes[0].code, CODES.SHAPE_INVALID);
    });

    it('refutes negative draft with negative false', () => {
      const negWithFalse = { ...makeGoodDraft(), resource: ['negative'], negative: false };
      const outcomes = checkDraftShape(makeCheckInput({ item: '74001', slots: { cases: [{ text: 'f', data: negWithFalse }] } }));
      assert.equal(outcomes[0].verdict, 'refute');
      assert.equal(outcomes[0].code, CODES.SHAPE_INVALID);
    });

    it('refutes duplicate drafts in the same submission', () => {
      const d1 = makeGoodDraft();
      const d2 = makeGoodDraft();
      const outcomes = checkDraftShape(
        makeCheckInput({
          item: '74001',
          slots: {
            cases: [
              { text: d1.title, data: d1 },
              { text: d2.title, data: d2 },
            ],
          },
        }),
      );
      assert.equal(outcomes[0].verdict, 'refute');
      assert.equal(outcomes[0].code, CODES.DUPLICATE_DRAFT);
    });
  });

  describe('checkCommandsRefutation', () => {
    it('accepts a negative draft that is refuted by catalog when expects_refutation is true', () => {
      const neg = makeNegativeExpectedRefutationDraft();
      const input = makeCheckInput({
        item: '74001',
        slots: { cases: [{ text: neg.title, data: neg }] },
      });
      const outcomes = checkCommandsRefutation(input);
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].verdict, 'support');
    });

    it('refutes a negative draft with expects_refutation true when catalog accepts the command', () => {
      const bad = makeNegativeUnexpectedAcceptDraft();
      const input = makeCheckInput({
        item: '74001',
        slots: { cases: [{ text: bad.title, data: bad }] },
      });
      const outcomes = checkCommandsRefutation(input);
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].verdict, 'refute');
      assert.equal(outcomes[0].code, 'core.catalog.membership_contradicted');
    });

    it('refutes a draft with expects_refutation false when catalog refutes the command', () => {
      const refutedDraft = {
        ...makeGoodDraft(),
        expects_refutation: false,
        steps: [{ command: 'widget health interval 99999' }],
      };
      const input = makeCheckInput({
        item: '74001',
        slots: { cases: [{ text: refutedDraft.title, data: refutedDraft }] },
      });
      const outcomes = checkCommandsRefutation(input);
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].verdict, 'refute');
      assert.equal(outcomes[0].code, 'core.catalog.membership_contradicted');
    });
  });

  describe('checkGroundedReading', () => {
    it('supports an expected result whose text is a faithful reading of quotation', () => {
      const good = makeGoodDraft();
      const input = makeCheckInput({
        item: '74001',
        slots: { cases: [{ text: good.title, data: good }] },
      });
      const outcomes = checkGroundedReading(input);
      assert.equal(outcomes[0].verdict, 'support');
    });

    it('refutes an expected result with no quotation, quote at case level, or quote missing reference', () => {
      // 缺 quote
      const noQuote = {
        ...makeGoodDraft(),
        expected: [{ text: '健康检查正常', quote: null as never }],
      };
      const input1 = makeCheckInput({
        item: '74001',
        slots: { cases: [{ text: noQuote.title, data: noQuote }] },
      });
      const outcomes1 = checkGroundedReading(input1);
      assert.equal(outcomes1[0].verdict, 'refute');
      assert.equal(outcomes1[0].code, CODES.QUOTE_MISSING);
      assert.ok(outcomes1[0].statement.includes('/slots/cases/0/data/expected/0/quote'));
      assert.ok(outcomes1[0].statement.includes('{"text":'));
      assert.ok(outcomes1[0].statement.includes('"reference":'));
      assert.equal(outcomes1[0].pointer, '/slots/cases/0/data/expected/0/quote');

      // quote 放在用例一级
      const caseLevel = {
        ...makeGoodDraft(),
        expected: [{ text: '用例一级带引文' }],
      };
      const input2 = makeCheckInput({
        item: '74001',
        slots: {
          cases: [
            {
              text: caseLevel.title,
              quote: { reference: 'src:sha1', text: '健康检查间隔设置成功' },
              quotes: [{ reference: 'src:sha1', text: '健康检查间隔设置成功' }],
              data: caseLevel,
            },
          ],
        },
      });
      const outcomes2 = checkGroundedReading(input2);
      assert.equal(outcomes2[0].verdict, 'refute');
      assert.equal(outcomes2[0].code, CODES.QUOTE_MISSING);
      assert.ok(outcomes2[0].statement.includes('/slots/cases/0/data/expected/0/quote'));
      assert.ok(outcomes2[0].statement.includes('{"text":'));
      assert.ok(outcomes2[0].statement.includes('"reference":'));
      assert.equal(outcomes2[0].pointer, '/slots/cases/0/data/expected/0/quote');

      // quote 缺 reference
      const missingRef = {
        ...makeGoodDraft(),
        expected: [
          {
            text: '健康检查间隔设置成功',
            quote: { reference: '', text: '健康检查间隔设置成功' },
          },
        ],
      };
      const input3 = makeCheckInput({
        item: '74001',
        slots: { cases: [{ text: missingRef.title, data: missingRef }] },
      });
      const outcomes3 = checkGroundedReading(input3);
      assert.equal(outcomes3[0].verdict, 'refute');
      assert.equal(outcomes3[0].code, CODES.QUOTE_MISSING);
      assert.ok(outcomes3[0].statement.includes('/slots/cases/0/data/expected/0/quote'));
      assert.ok(outcomes3[0].statement.includes('{"text":'));
      assert.ok(outcomes3[0].statement.includes('"reference":'));
      assert.equal(outcomes3[0].pointer, '/slots/cases/0/data/expected/0/quote');
    });

    it('refutes an expected result introducing an unsupported number or on/off state', () => {
      const extraEntity = {
        ...makeGoodDraft(),
        expected: [
          {
            text: '健康检查间隔设置为 120 秒成功，开启状态正常',
            quote: {
              reference: 'src:sha1',
              text: '健康检查间隔设置成功',
            },
          },
        ],
      };
      const input = makeCheckInput({
        item: '74001',
        slots: { cases: [{ text: extraEntity.title, data: extraEntity }] },
      });
      const outcomes = checkGroundedReading(input);
      assert.equal(outcomes[0].verdict, 'refute');
      assert.equal(outcomes[0].code, CODES.EXPECT_NOT_IN_QUOTE);
    });
  });

  describe('checkDuplicate', () => {
    it('supports a draft that is not a duplicate of an indexed case (complete view)', () => {
      const good = makeGoodDraft();
      const input = makeCheckInput({
        item: '74001',
        drafts: [good],
        indexed_cases: SYNTHETIC_INDEX_VIEW_COMPLETE,
      });
      const outcomes = checkDuplicate(input);
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].verdict, 'support');
    });

    it('refutes a draft that duplicates an indexed case with an advisory violation', () => {
      const dup = makeDuplicateDraft();
      const input = makeCheckInput({
        item: '74001',
        drafts: [dup],
        indexed_cases: SYNTHETIC_INDEX_VIEW,
      });
      const outcomes = checkDuplicate(input);
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].verdict, 'refute');
      assert.equal(outcomes[0].code, CODES.DUPLICATE_CASE);
      assert.equal(outcomes[0].tier, 'advisory');
      assert.ok(outcomes[0].statement.includes('doc_101'));
      assert.ok(outcomes[0].statement.includes('node_5'));
      const expectedRef = Object.values(SYNTHETIC_INDEX_VIEW.entries)[0].reference;
      assert.deepEqual(outcomes[0].grounds, [expectedRef]);
    });

    it('parses a command line to its head first: a line with parameters lands in the head’s bucket and duplicates', () => {
      // 草稿的命令行 widget health interval 60 带参数，命令头是 widget health interval；索引条目的命令集合按命令头比。
      const entry = {
        entry: '4'.repeat(64),
        kind: 'case' as const,
        statement: 'doc_102:node_7 | SLB健康检查间隔配置正向测试',
        reference: `tree:${'1'.repeat(64)}/commands/widget/health/interval@${'4'.repeat(64)}`,
        data: { case_structure: {schema:'case-structure@2',commands:makeGoodDraft().steps.map(s=>s.identity),expected:makeGoodDraft().expected.map(e=>({after:e.after,quote:e.identity}))}, document: 'doc_102', node: 'node_7', title: 'SLB健康检查间隔配置正向测试', negative: false, commands: ['widget health interval'] },
      };
      const index = {
        schema: 'index-view@1' as const,
        product: 'famx',
        build: { build: 'Rel_FAMX_10_6_1_57', root: '1'.repeat(64) },
        kind: 'case' as const,
        key: 'commands' as const,
        keys: { 'widget health interval': ['4'.repeat(64)] },
        entries: { ['4'.repeat(64)]: entry },
        total_keys: 1,
        total_entries: 1,
        truncated: false,
        skipped: 0,
        notes: [],
      };
      const outcomes = checkDuplicate(makeCheckInput({ item: '74001', drafts: [makeGoodDraft()], indexed_cases: index }));
      assert.equal(outcomes.length, 1);
      assert.deepEqual([outcomes[0].verdict, outcomes[0].code], ['refute', CODES.DUPLICATE_CASE]);
      assert.ok(outcomes[0].statement.includes('doc_102'));
      assert.deepEqual(outcomes[0].grounds, [entry.reference]);
    });

    it('marks a draft unknown when its command line has no head in the locked catalog, and says why', () => {
      const bad = { ...makeGoodDraft(), steps: [{ command: 'warp the core gently' }] };
      const outcomes = checkDuplicate(makeCheckInput({ item: '74001', drafts: [bad], indexed_cases: SYNTHETIC_INDEX_VIEW }));
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].verdict, 'unknown');
      assert.equal(outcomes[0].reason, 'missing_input');
      assert.match(outcomes[0].missing ?? '', /完整/);
      assert.match(outcomes[0].missing ?? '', /下一步/);
    });

    it('concludes not-duplicate when none of the draft’s heads has any index entry (not narrowed)', () => {
      const lonely = { ...makeGoodDraft(), title: '完全不同的用例', steps: [nativeStep('service http port 8080')] };
      const outcomes = checkDuplicate(makeCheckInput({ item: '74001', drafts: [lonely], indexed_cases: SYNTHETIC_INDEX_VIEW_COMPLETE }));
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].verdict, 'support');
    });

    it('gives an unknown outcome when no duplicate found but index has skipped sources', () => {
      const good = makeGoodDraft();
      const input = makeCheckInput({
        item: '74001',
        drafts: [good],
        indexed_cases: INCOMPLETE_INDEX_VIEW,
      });
      const outcomes = checkDuplicate(input);
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].verdict, 'unknown');
      assert.equal(outcomes[0].reason, 'integrity_unproven');
      assert.ok(outcomes[0].statement.includes('3'));
    });

    it('counts duplicate claims by item, requirement and code when the statement is reworded', () => {
      const draft = makeDuplicateDraft();
      const outcomes = checkDuplicate(makeCheckInput({ item: '74001', drafts: [draft], indexed_cases: SYNTHETIC_INDEX_VIEW }));
      assert.equal(outcomes.length, 1);
      const claim = outcomes[0];
      assert.equal(claim.item, '74001');
      assert.equal(claim.code, CODES.DUPLICATE_CASE);
      const data = claim.data ?? {};
      assert.equal(data.requirement, 'not_duplicate');
      assert.equal(DUPLICATE_CLAIM_RULE, 'defect-to-case.duplicate_claim_identity@1');
      assert.equal(data.rule_version, DUPLICATE_CLAIM_RULE);
      const duplicate = data.duplicate_of;
      assert.ok(duplicate !== null && typeof duplicate === 'object' && !Array.isArray(duplicate));
      const reference = (duplicate as { reference?: unknown }).reference;
      assert.equal(typeof reference, 'string');
      const reworded = { ...claim, statement: '措辞已换，这条主张不再用起草前缀' };
      const sameWordsOtherItem = { ...claim, item: '74002' };
      const counts = countDuplicateClaims([claim, reworded, sameWordsOtherItem]);
      assert.equal(counts.get(duplicateClaimCountKey(claim) ?? ''), 2);
      assert.equal(counts.get(duplicateClaimCountKey(sameWordsOtherItem) ?? ''), 1);
      assert.equal(duplicateClaimCountKey(reworded), duplicateClaimCountKey(claim));
      const prefix = `起草用例“${draft.title}”与已索引用例重复`;
      const byPrefix = [claim, reworded, sameWordsOtherItem].filter((outcome) => outcome.statement.startsWith(prefix));
      assert.equal(byPrefix.length, 0);
      assert.equal(byPrefix.some((outcome) => outcome.statement === reworded.statement), false);
    });
  });
});
