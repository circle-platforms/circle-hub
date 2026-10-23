// The decidability rules of deduplication on a narrowed index (the real-scale task): the binding may narrow the index
// with only=<命令路径>（the commands the drafts will use）; a draft is decidable when its command set meets the only
// list (its duplicate, if any, carries every command of the set, so it must appear under one of those keys); a draft
// whose commands all sit outside the only list is unknown, with the reason named. After narrowing, an entry's command
// set comes from its own commands field (a narrowed entry appears only under the listed keys, the keys no longer rebuild
// the whole set); an entry without a commands field is unknown, never "no commands". Without only, the old rule stands:
// decidable only when the view is complete; a truncated view is unknown.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IndexView } from '../../../../contracts/src/views.ts';
import { checkDuplicate } from './checks.ts';
import { buildCompactIndex, isCompactIndex } from './compact-index.ts';
import { goodDraft, SYNTHETIC_INDEX_VIEW, SYNTHETIC_INDEX_VIEW_COMPLETE } from '../testing/fixtures.ts';

const HEX2 = '2'.repeat(64);

/** A narrowed index view: only the show health detail key, entries carry their own commands field. */
/** The Hub echoes the narrowing in the view's notes (only=<keys>); entries keep their own commands field. */
const NARROWED_VIEW: IndexView = {
  ...SYNTHETIC_INDEX_VIEW,
  keys: { 'show health detail': [HEX2] },
  total_keys: 1,
  truncated: true,
  notes: ['only=show health detail'],
} as unknown as IndexView;

const inputOf = (options: { drafts?: unknown[]; indexed_cases?: unknown }): unknown => ({
  subject: {
    item: '74001',
    drafts: options.drafts ?? [goodDraft()],
    indexed_cases: options.indexed_cases ?? NARROWED_VIEW,
  },
});

describe('dedup on a narrowed index', () => {
  it('a draft whose command set meets the only list is decidable: a duplicate is refuted', () => {
    // The duplicate draft uses exactly the narrowed key's command (show health detail).
    const duplicate = goodDraft({ title: '健康检查详细信息查看', expected: [{ text: '健康检查状态显示正常', quote: { reference: 'src:x', text: '健康检查状态显示正常' } }] });
    const draftOnKey = { ...duplicate, steps: [{ command: 'show health detail', note: '查看' }] };
    const outcomes = checkDuplicate(inputOf({ drafts: [draftOnKey] }));
    assert.equal(outcomes[0].verdict, 'refute');
    assert.equal(outcomes[0].code, 'defect-to-case.duplicate_case');
  });

  it('a draft on the narrowed key without a duplicate is supported (decidable, not unknown)', () => {
    const draftOnKey = { ...goodDraft(), steps: [{ command: 'show health detail', note: '查看' }] };
    const outcomes = checkDuplicate(inputOf({ drafts: [draftOnKey] }));
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].verdict, 'support');
  });

  it('a draft whose commands all sit outside the only list is unknown, with the reason named', () => {
    const outside = { ...goodDraft(), steps: [{ command: 'widget health interval 60', note: '设置' }] };
    const outcomes = checkDuplicate(inputOf({ drafts: [outside] }));
    assert.equal(outcomes[0].verdict, 'unknown');
    assert.equal(outcomes[0].reason, 'missing_input');
    assert.match(outcomes[0].statement, /索引没有收窄到/);
    assert.match(outcomes[0].statement, /widget health interval/);
  });

  it('a draft with commands both inside and outside the only list is decidable (at least one inside)', () => {
    const mixed = { ...goodDraft(), steps: [{ command: 'show health detail', note: 'a' }, { command: 'widget health interval 60', note: 'b' }] };
    const outcomes = checkDuplicate(inputOf({ drafts: [mixed] }));
    assert.equal(outcomes[0].verdict, 'support', 'one command of the set inside the narrowing is enough');
  });

  it('an entry without a commands field on a narrowed index is unknown, never treated as command-less', () => {
    const missing: IndexView = {
      ...NARROWED_VIEW,
      entries: { [HEX2]: { ...NARROWED_VIEW.entries[HEX2]!, data: { ...NARROWED_VIEW.entries[HEX2]!.data, commands: undefined } } },
    };
    const draftOnKey = { ...goodDraft({ title: '健康检查详细信息查看' }), steps: [{ command: 'show health detail', note: '查看' }] };
    const outcomes = checkDuplicate(inputOf({ drafts: [draftOnKey], indexed_cases: missing }));
    assert.equal(outcomes[0].verdict, 'unknown');
    assert.match(outcomes[0].statement, /没有带 commands 字段|缺少 commands/);
  });

  it('without narrowing the old rule stands: a truncated view keeps "no duplicate" unknown', () => {
    const full: IndexView = { ...SYNTHETIC_INDEX_VIEW_COMPLETE, truncated: true, notes: ['truncated'] };
    const outcomes = checkDuplicate(inputOf({ indexed_cases: full }));
    assert.equal(outcomes[0].verdict, 'unknown');
    assert.equal(outcomes[0].reason, 'integrity_unproven');
  });

  it('without narrowing a complete view still supports a non-duplicate', () => {
    const outcomes = checkDuplicate(inputOf({ indexed_cases: SYNTHETIC_INDEX_VIEW_COMPLETE }));
    assert.equal(outcomes[0].verdict, 'support');
  });
});

describe('the compact index after narrowing', () => {
  it('builds an entry\'s command set from its own commands field, not from the keys', () => {
    const compact = buildCompactIndex(NARROWED_VIEW);
    assert.ok(isCompactIndex(compact));
    const bucket = compact.by_commands['show health detail'];
    assert.ok(bucket !== undefined && bucket.length === 1, JSON.stringify(Object.keys(compact.by_commands)));
    assert.equal(bucket[0].document, 'doc_101');
  });

  it('an entry whose data has no commands field and no usable key reconstruction counts as unknown-worthy, not empty', () => {
    const missing: IndexView = {
      ...NARROWED_VIEW,
      keys: {},
      entries: { [HEX2]: { ...NARROWED_VIEW.entries[HEX2]!, data: { ...NARROWED_VIEW.entries[HEX2]!.data, commands: undefined } } },
    };
    const compact = buildCompactIndex(missing);
    assert.ok(compact.unplacedCommands >= 1, `unplaced commands counted: ${compact.unplacedCommands}`);
    assert.equal(compact.total, 0);
  });

  it('a complete un-narrowed view with commands fields still buckets normally', () => {
    const compact = buildCompactIndex({ ...SYNTHETIC_INDEX_VIEW, truncated: false });
    assert.equal(compact.total, 1);
    assert.ok(compact.by_commands['show health detail'] !== undefined);
  });
});
