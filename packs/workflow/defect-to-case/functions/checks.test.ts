import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PackCheckInput } from '../../../../hub/rules/api.ts';
import {
  INCOMPLETE_INDEX_VIEW,
  SYNTHETIC_CATALOG,
  SYNTHETIC_INDEX_VIEW,
  makeDuplicateDraft,
  makeGoodDraft,
  makeNegativeExpectedRefutationDraft,
  makeNegativeUnexpectedAcceptDraft,
} from '../testing/fixtures.ts';
import {
  checkCommandsRefutation,
  checkDraftShape,
  checkDuplicate,
  checkGroundedReading,
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
    sources,
    catalog,
  };
}

describe('pack checks', () => {
  describe('checkDraftShape', () => {
    it('supports a good draft', () => {
      const good = makeGoodDraft();
      const input = makeCheckInput({
        item: '71009',
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
        item: '71009',
        slots: { cases: [{ text: emptyTitle.title, data: emptyTitle }] },
      });
      const outcomes1 = checkDraftShape(input1);
      assert.equal(outcomes1[0].verdict, 'refute');
      assert.equal(outcomes1[0].code, CODES.SHAPE_INVALID);

      const input2 = makeCheckInput({
        item: '71009',
        slots: { cases: [{ text: longTitle.title, data: longTitle }] },
      });
      const outcomes2 = checkDraftShape(input2);
      assert.equal(outcomes2[0].verdict, 'refute');
      assert.equal(outcomes2[0].code, CODES.SHAPE_INVALID);
    });

    it('refutes a draft with no steps or step with empty command line', () => {
      const noSteps = { ...makeGoodDraft(), steps: [] };
      const emptyCmd = { ...makeGoodDraft(), steps: [{ command: '   ' }] };
      const outcomes1 = checkDraftShape(makeCheckInput({ item: '71009', slots: { cases: [{ text: 'a', data: noSteps }] } }));
      assert.equal(outcomes1[0].verdict, 'refute');
      assert.equal(outcomes1[0].code, CODES.SHAPE_INVALID);

      const outcomes2 = checkDraftShape(makeCheckInput({ item: '71009', slots: { cases: [{ text: 'b', data: emptyCmd }] } }));
      assert.equal(outcomes2[0].verdict, 'refute');
      assert.equal(outcomes2[0].code, CODES.SHAPE_INVALID);
    });

    it('refutes a draft with no expected result', () => {
      const noExpected = { ...makeGoodDraft(), expected: [] };
      const outcomes = checkDraftShape(makeCheckInput({ item: '71009', slots: { cases: [{ text: 'c', data: noExpected }] } }));
      assert.equal(outcomes[0].verdict, 'refute');
      assert.equal(outcomes[0].code, CODES.SHAPE_INVALID);
    });

    it('refutes priority out of range (not in 1..3)', () => {
      const badPriority = { ...makeGoodDraft(), priority: 5 };
      const outcomes = checkDraftShape(makeCheckInput({ item: '71009', slots: { cases: [{ text: 'd', data: badPriority }] } }));
      assert.equal(outcomes[0].verdict, 'refute');
      assert.equal(outcomes[0].code, CODES.SHAPE_INVALID);
    });

    it('refutes tags outside team template categories', () => {
      const badTag = { ...makeGoodDraft(), tags: ['UnknownTagCategory'] };
      const outcomes = checkDraftShape(makeCheckInput({ item: '71009', slots: { cases: [{ text: 'e', data: badTag }] } }));
      assert.equal(outcomes[0].verdict, 'refute');
      assert.equal(outcomes[0].code, CODES.SHAPE_INVALID);
    });

    it('refutes negative draft with negative false', () => {
      const negWithFalse = { ...makeGoodDraft(), tags: ['Negative'], negative: false };
      const outcomes = checkDraftShape(makeCheckInput({ item: '71009', slots: { cases: [{ text: 'f', data: negWithFalse }] } }));
      assert.equal(outcomes[0].verdict, 'refute');
      assert.equal(outcomes[0].code, CODES.SHAPE_INVALID);
    });

    it('refutes duplicate drafts in the same submission', () => {
      const d1 = makeGoodDraft();
      const d2 = makeGoodDraft();
      const outcomes = checkDraftShape(
        makeCheckInput({
          item: '71009',
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
        item: '71009',
        slots: { cases: [{ text: neg.title, data: neg }] },
      });
      const outcomes = checkCommandsRefutation(input);
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].verdict, 'support');
    });

    it('refutes a negative draft with expects_refutation true when catalog accepts the command', () => {
      const bad = makeNegativeUnexpectedAcceptDraft();
      const input = makeCheckInput({
        item: '71009',
        slots: { cases: [{ text: bad.title, data: bad }] },
      });
      const outcomes = checkCommandsRefutation(input);
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].verdict, 'refute');
      assert.equal(outcomes[0].code, CODES.NEGATIVE_ACCEPTED);
    });

    it('refutes a draft with expects_refutation false when catalog refutes the command', () => {
      const refutedDraft = {
        ...makeGoodDraft(),
        expects_refutation: false,
        steps: [{ command: 'widget health interval 99999' }],
      };
      const input = makeCheckInput({
        item: '71009',
        slots: { cases: [{ text: refutedDraft.title, data: refutedDraft }] },
      });
      const outcomes = checkCommandsRefutation(input);
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].verdict, 'refute');
      assert.equal(outcomes[0].code, CODES.UNEXPECTED_REFUTATION);
    });
  });

  describe('checkGroundedReading', () => {
    it('supports an expected result whose text is a faithful reading of quotation', () => {
      const good = makeGoodDraft();
      const input = makeCheckInput({
        item: '71009',
        slots: { cases: [{ text: good.title, data: good }] },
      });
      const outcomes = checkGroundedReading(input);
      assert.equal(outcomes[0].verdict, 'support');
    });

    it('refutes an expected result with no quotation', () => {
      const noQuote = {
        ...makeGoodDraft(),
        expected: [{ text: '健康检查正常', quote: null as never }],
      };
      const input = makeCheckInput({
        item: '71009',
        slots: { cases: [{ text: noQuote.title, data: noQuote }] },
      });
      const outcomes = checkGroundedReading(input);
      assert.equal(outcomes[0].verdict, 'refute');
      assert.equal(outcomes[0].code, CODES.QUOTE_MISSING);
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
        item: '71009',
        slots: { cases: [{ text: extraEntity.title, data: extraEntity }] },
      });
      const outcomes = checkGroundedReading(input);
      assert.equal(outcomes[0].verdict, 'refute');
      assert.equal(outcomes[0].code, CODES.UNSUPPORTED_ENTITY);
    });
  });

  describe('checkDuplicate', () => {
    it('supports a draft that is not a duplicate of an indexed case', () => {
      const good = makeGoodDraft();
      const input = makeCheckInput({
        item: '71009',
        drafts: [good],
        indexed_cases: SYNTHETIC_INDEX_VIEW,
      });
      const outcomes = checkDuplicate(input);
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].verdict, 'support');
    });

    it('refutes a draft that duplicates an indexed case with an advisory violation', () => {
      const dup = makeDuplicateDraft();
      const input = makeCheckInput({
        item: '71009',
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

    it('gives an unknown outcome when no duplicate found but index has skipped sources', () => {
      const good = makeGoodDraft();
      const input = makeCheckInput({
        item: '71009',
        drafts: [good],
        indexed_cases: INCOMPLETE_INDEX_VIEW,
      });
      const outcomes = checkDuplicate(input);
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].verdict, 'unknown');
      assert.equal(outcomes[0].reason, 'integrity_unproven');
      assert.ok(outcomes[0].statement.includes('3'));
    });
  });
});
