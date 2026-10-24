import {QUOTE_BYTES,QUOTE_SOURCE} from './testing/structure.ts';
import {checkCommandsRefutation} from './testing/checks.ts';
// Hand-built defects and drafts test covering all required failure and pass modes.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PackCheckInput } from '../../../hub/rules/api.ts';
import {
  INCOMPLETE_INDEX_VIEW,
  SYNTHETIC_CATALOG,
  SYNTHETIC_INDEX_VIEW,
  SYNTHETIC_INDEX_VIEW_COMPLETE,
  makeDuplicateDraft,
  makeGoodDraft,
  makeNegativeExpectedRefutationDraft,
  makeNegativeUnexpectedAcceptDraft,
} from './testing/fixtures.ts';
import {
  checkDraftShape,
  checkDuplicate,
  checkGroundedReading,
} from './functions/checks.ts';
import { CODES } from './functions/types.ts';

function makeInput(subject: unknown, sources: Record<string, string> = {}): PackCheckInput {
  return {
    check: 'check_test',
    table: null,
    subject,
    context: {
      run: 'run_checks',
      pack: 'defect-to-case',
      sets: {},
    },
    sources: { ['src:'+QUOTE_SOURCE]:QUOTE_BYTES,...sources },
    catalog: SYNTHETIC_CATALOG,
  };
}

describe('hand-built drafts and checks coverage', () => {
  it('1. accepts a good draft across all checks', () => {
    const good = makeGoodDraft();
    const shapeOutcomes = checkDraftShape(makeInput({ item: '74001', slots: { cases: [{ text: good.title, data: good }] } }));
    assert.equal(shapeOutcomes[0].verdict, 'support');

    const cmdOutcomes = checkCommandsRefutation(makeInput({ item: '74001', slots: { cases: [{ text: good.title, data: good }] } }));
    assert.equal(cmdOutcomes[0].verdict, 'support');

    const groundOutcomes = checkGroundedReading(makeInput({ item: '74001', slots: { cases: [{ text: good.title, data: good }] } }));
    assert.equal(groundOutcomes[0].verdict, 'support');

    // The narrowing now rides the bound URI (narrowed-dedup.test covers its rules); the plain view is complete here.
    const dupOutcomes = checkDuplicate(makeInput({ item: '74001', drafts: [good], indexed_cases: SYNTHETIC_INDEX_VIEW }));
    assert.equal(dupOutcomes[0].verdict, 'support');
  });

  it('2. refuses an unknown command or parameter out of range in refutation checks', () => {
    const unknownCmd = { ...makeGoodDraft(), steps: [{ command: 'invalid_head_cmd 123' }] };
    const out1 = checkCommandsRefutation(makeInput({ item: '74001', slots: { cases: [{ text: unknownCmd.title, data: unknownCmd }] } }));
    assert.equal(out1[0].verdict, 'refute');
    assert.equal(out1[0].code, 'core.catalog.membership_contradicted');

    const outOfRange = { ...makeGoodDraft(), steps: [{ command: 'widget health interval 99999' }] };
    const out2 = checkCommandsRefutation(makeInput({ item: '74001', slots: { cases: [{ text: outOfRange.title, data: outOfRange }] } }));
    assert.equal(out2[0].verdict, 'refute');
    assert.equal(out2[0].code, 'core.catalog.membership_contradicted');
  });

  it('3. refuses an expected result with no quotation, quote at case level, or quote missing reference', () => {
    // 缺 quote
    const noQuote = {
      ...makeGoodDraft(),
      expected: [{ text: '无引文的结果', quote: undefined as never }],
    };
    const out1 = checkGroundedReading(makeInput({ item: '74001', slots: { cases: [{ text: noQuote.title, data: noQuote }] } }));
    assert.equal(out1[0].verdict, 'refute');
    assert.equal(out1[0].code, CODES.QUOTE_MISSING);
    assert.ok(out1[0].statement.includes('/slots/cases/0/data/expected/0/quote'));
    assert.ok(out1[0].statement.includes('{"text":'));
    assert.ok(out1[0].statement.includes('"reference":'));
    assert.equal(out1[0].pointer, '/slots/cases/0/data/expected/0/quote');

    // quote 放在用例一级
    const quoteAtCaseLevel = {
      ...makeGoodDraft(),
      expected: [{ text: '引文放在用例一级' }],
    };
    const out2 = checkGroundedReading(
      makeInput({
        item: '74001',
        slots: {
          cases: [
            {
              text: quoteAtCaseLevel.title,
              quote: { reference: 'src:fix_sha', text: '健康检查间隔设置成功' },
              quotes: [{ reference: 'src:fix_sha', text: '健康检查间隔设置成功' }],
              data: quoteAtCaseLevel,
            },
          ],
        },
      }),
    );
    assert.equal(out2[0].verdict, 'refute');
    assert.equal(out2[0].code, CODES.QUOTE_MISSING);
    assert.ok(out2[0].statement.includes('/slots/cases/0/data/expected/0/quote'));
    assert.ok(out2[0].statement.includes('{"text":'));
    assert.ok(out2[0].statement.includes('"reference":'));
    assert.equal(out2[0].pointer, '/slots/cases/0/data/expected/0/quote');

    // quote 缺 reference
    const quoteMissingRef = {
      ...makeGoodDraft(),
      expected: [
        {
          text: '健康检查间隔设置成功',
          quote: { reference: '', text: '健康检查间隔设置成功' },
        },
      ],
    };
    const out3 = checkGroundedReading(makeInput({ item: '74001', slots: { cases: [{ text: quoteMissingRef.title, data: quoteMissingRef }] } }));
    assert.equal(out3[0].verdict, 'refute');
    assert.equal(out3[0].code, CODES.QUOTE_MISSING);
    assert.ok(out3[0].statement.includes('/slots/cases/0/data/expected/0/quote'));
    assert.ok(out3[0].statement.includes('{"text":'));
    assert.ok(out3[0].statement.includes('"reference":'));
    assert.equal(out3[0].pointer, '/slots/cases/0/data/expected/0/quote');

    // 多个期望结果中的第二个缺 quote
    const secondMissing = {
      ...makeGoodDraft(),
      expected: [
        makeGoodDraft().expected[0],
        { text: '第二个期望结果无引文', quote: undefined as never },
      ],
    };
    const out4 = checkGroundedReading(makeInput({ item: '74001', slots: { cases: [{ text: secondMissing.title, data: secondMissing }] } }));
    assert.equal(out4[0].verdict, 'refute');
    assert.equal(out4[0].code, CODES.QUOTE_MISSING);
    assert.ok(out4[0].statement.includes('/slots/cases/0/data/expected/1/quote'));
    assert.equal(out4[0].pointer, '/slots/cases/0/data/expected/1/quote');
  });

  it('4. refuses expected result containing number or command or on/off state not in quote', () => {
    const badEntity = {
      ...makeGoodDraft(),
      expected: [
        {
          text: '健康检查间隔 60 秒关闭',
          quote: { reference: 'src:ref', text: '健康检查间隔设置成功' },
        },
      ],
    };
    const out = checkGroundedReading(makeInput({ item: '74001', slots: { cases: [{ text: badEntity.title, data: badEntity }] } }));
    assert.equal(out[0].verdict, 'refute');
    assert.equal(out[0].code, CODES.EXPECT_NOT_IN_QUOTE);
  });

  it('5. refuses wrong shape drafts', () => {
    const badPrio = { ...makeGoodDraft(), priority: 0 };
    const out = checkDraftShape(makeInput({ item: '74001', slots: { cases: [{ text: badPrio.title, data: badPrio }] } }));
    assert.equal(out[0].verdict, 'refute');
    assert.equal(out[0].code, CODES.SHAPE_INVALID);
  });

  it('6. negative draft with and without expects_refutation', () => {
    // With expects_refutation: true on out-of-range command -> accepted
    const negWithExpect = makeNegativeExpectedRefutationDraft();
    const out1 = checkCommandsRefutation(makeInput({ item: '74001', slots: { cases: [{ text: negWithExpect.title, data: negWithExpect }] } }));
    assert.equal(out1[0].verdict, 'support');

    // With expects_refutation: true on valid command -> refuted (negative_accepted)
    const negUnexpectedAccept = makeNegativeUnexpectedAcceptDraft();
    const out2 = checkCommandsRefutation(makeInput({ item: '74001', slots: { cases: [{ text: negUnexpectedAccept.title, data: negUnexpectedAccept }] } }));
    assert.equal(out2[0].verdict, 'refute');
    assert.equal(out2[0].code, 'core.catalog.membership_contradicted');

    // Negative draft with expects_refutation: false on out-of-range command -> refuted (unexpected_refutation)
    const negWithoutExpect = {
      ...makeGoodDraft(),
      negative: true,
      expects_refutation: false,
      tags: ['Negative'],
      steps: [{ command: 'widget health interval 99999' }],
    };
    const out3 = checkCommandsRefutation(makeInput({ item: '74001', slots: { cases: [{ text: negWithoutExpect.title, data: negWithoutExpect }] } }));
    assert.equal(out3[0].verdict, 'refute');
    assert.equal(out3[0].code, 'core.catalog.membership_contradicted');
  });

  it('7. duplicate of an indexed case and incomplete index behavior', () => {
    const dup = makeDuplicateDraft();
    const outDup = checkDuplicate(makeInput({ item: '74001', drafts: [dup], indexed_cases: SYNTHETIC_INDEX_VIEW }));
    assert.equal(outDup[0].verdict, 'refute');
    assert.equal(outDup[0].code, CODES.DUPLICATE_CASE);

    const good = makeGoodDraft();
    const outIncomplete = checkDuplicate(makeInput({ item: '74001', drafts: [good], indexed_cases: INCOMPLETE_INDEX_VIEW }));
    assert.equal(outIncomplete[0].verdict, 'unknown');
    assert.equal(outIncomplete[0].reason, 'integrity_unproven');
  });

  it('8. empty submission for a defect', () => {
    const out = checkDraftShape(makeInput({ item: '74001', slots: { cases: [] } }));
    assert.equal(out[0].verdict, 'refute');
    assert.equal(out[0].code, CODES.SHAPE_INVALID);
  });
});
