// Order independence tests for defect-to-case checks.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PackCheckInput } from '../../../hub/rules/api.ts';
import {
  SYNTHETIC_CATALOG,
  SYNTHETIC_INDEX_VIEW,
  makeDuplicateDraft,
  makeGoodDraft,
  makeNegativeExpectedRefutationDraft,
} from './testing/fixtures.ts';
import {
  checkCommandsRefutation,
  checkDraftShape,
  checkDuplicate,
  checkGroundedReading,
} from './functions/checks.ts';

function makeCheckInput(subject: unknown): PackCheckInput {
  return {
    check: 'test_check',
    table: null,
    subject,
    context: {
      run: 'run_order',
      pack: 'defect-to-case',
      sets: {},
    },
    sources: {},
    catalog: SYNTHETIC_CATALOG,
  };
}

describe('order independence', () => {
  it('checkDraftShape returns identical outcomes regardless of draft order', () => {
    const d1 = makeGoodDraft();
    const d2 = makeNegativeExpectedRefutationDraft();

    const in1 = makeCheckInput({
      item: '74001',
      slots: {
        cases: [
          { text: d1.title, data: d1 },
          { text: d2.title, data: d2 },
        ],
      },
    });
    const in2 = makeCheckInput({
      item: '74001',
      slots: {
        cases: [
          { text: d2.title, data: d2 },
          { text: d1.title, data: d1 },
        ],
      },
    });

    const o1 = checkDraftShape(in1);
    const o2 = checkDraftShape(in2);
    assert.equal(o1.length, o2.length);
    assert.deepEqual(o1.map((x) => x.verdict).sort(), o2.map((x) => x.verdict).sort());
  });

  it('checkDuplicate returns identical outcomes regardless of index entries order', () => {
    const dup = makeDuplicateDraft();
    const good = makeGoodDraft();

    const view1 = { ...SYNTHETIC_INDEX_VIEW };
    const view2 = {
      ...SYNTHETIC_INDEX_VIEW,
      entries: Object.fromEntries(Object.entries(SYNTHETIC_INDEX_VIEW.entries).reverse()),
    };

    const o1 = checkDuplicate(makeCheckInput({ item: '74001', drafts: [dup, good], indexed_cases: view1 }));
    const o2 = checkDuplicate(makeCheckInput({ item: '74001', drafts: [good, dup], indexed_cases: view2 }));

    assert.equal(o1.length, o2.length);
    assert.deepEqual(o1.map((x) => x.verdict).sort(), o2.map((x) => x.verdict).sort());
    assert.deepEqual(o1.map((x) => x.code).sort(), o2.map((x) => x.code).sort());
  });
});
