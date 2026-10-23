// The decidability rules of deduplication on a narrowed index, at real scale. Three sources of truth:
// - The narrowing comes from the bound URI's only=… parameter (comma-separated, each percent-decoded, a trailing
//   @<64-hex> or @<hex>..<hex> revision stripped first); the view's own output carries no only field (README Needs).
// - The core caps every key at 2000 entries and says so in prose only: a key listing exactly the cap may have been cut.
// - Case entries carry no expected-text field: the comparison rests on the command-set key, the negative flag and the
//   title. A draft is decidable when some key of its command set sits in only and not every such key is possibly cut.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IndexView } from '../../../../contracts/src/views.ts';
import { checkDuplicate } from './checks.ts';
import { buildCompactIndex, isCompactIndex, MAX_INDEX_PER_KEY, onlyOfExternal } from './compact-index.ts';
import { goodDraft, SYNTHETIC_CATALOG, SYNTHETIC_INDEX_VIEW, SYNTHETIC_INDEX_VIEW_COMPLETE } from '../testing/fixtures.ts';

const HEX2 = '2'.repeat(64);
const NARROWED = 'knowledge:index:apv:Rel_APV_10_6_1_57?kind=case&key=commands&only=show%20health%20detail&fields=commands,document,node,title,negative';

const inputOf = (options: { drafts?: unknown[]; indexed_cases?: unknown }): unknown => ({
  subject: {
    item: '74001',
    drafts: options.drafts ?? [goodDraft()],
    indexed_cases: options.indexed_cases ?? SYNTHETIC_INDEX_VIEW,
  },
  catalog: SYNTHETIC_CATALOG,
});

describe('onlyOfExternal reads the bound URI', () => {
  it('splits on commas, percent-decodes each value and strips a trailing revision', () => {
    assert.deepEqual(onlyOfExternal(NARROWED), ['show health detail']);
    const two = 'knowledge:index:p:b?kind=case&key=commands&only=show%20health%20detail,widget%20health%20interval';
    assert.deepEqual(onlyOfExternal(two), ['show health detail', 'widget health interval']);
    const revised = `knowledge:index:p:b@${'a'.repeat(64)}?kind=case&key=commands&only=reboot@${'b'.repeat(64)}..${'c'.repeat(64)},ping`;
    assert.deepEqual(onlyOfExternal(revised), ['reboot', 'ping']);
  });

  it('no only parameter means not narrowed (null), an empty one too', () => {
    assert.equal(onlyOfExternal('knowledge:index:p:b?kind=case&key=commands'), null);
    assert.equal(onlyOfExternal('knowledge:index:p:b?kind=case&key=commands&only='), null);
    assert.equal(onlyOfExternal(null), null);
  });
});

describe('dedup narrowed by the bound URI', () => {
  it('a draft whose command set meets only is decidable: a duplicate is refuted on the title', () => {
    // The duplicate rides the narrowed key's command and shares the indexed case's title.
    const duplicate = goodDraft({ title: '健康检查详细信息查看' });
    const draftOnKey = { ...duplicate, steps: [{ command: 'show health detail', note: '查看' }] };
    const compact = buildCompactIndex(SYNTHETIC_INDEX_VIEW, undefined, NARROWED);
    const outcomes = checkDuplicate(inputOf({ drafts: [draftOnKey], indexed_cases: compact }));
    assert.equal(outcomes[0].verdict, 'refute');
    assert.equal(outcomes[0].code, 'defect-to-case.duplicate_case');
  });

  it('a draft on the narrowed key with a different title is supported (decidable, no duplicate)', () => {
    const draftOnKey = { ...goodDraft(), steps: [{ command: 'show health detail', note: '查看' }] };
    const compact = buildCompactIndex(SYNTHETIC_INDEX_VIEW, undefined, NARROWED);
    const outcomes = checkDuplicate(inputOf({ drafts: [draftOnKey], indexed_cases: compact }));
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].verdict, 'support');
  });

  it('a draft whose commands all sit outside only is unknown, with the reason named', () => {
    const outside = { ...goodDraft(), steps: [{ command: 'widget health interval 60', note: '设置' }] };
    const compact = buildCompactIndex(SYNTHETIC_INDEX_VIEW, undefined, NARROWED);
    const outcomes = checkDuplicate(inputOf({ drafts: [outside], indexed_cases: compact }));
    assert.equal(outcomes[0].verdict, 'unknown');
    assert.equal(outcomes[0].reason, 'missing_input');
    assert.match(outcomes[0].statement, /索引没有收窄到/);
    assert.match(outcomes[0].statement, /widget health interval/);
  });

  it('the same view without an only parameter keeps the old rule: complete view supports, truncated is unknown', () => {
    const support = buildCompactIndex(SYNTHETIC_INDEX_VIEW_COMPLETE, undefined, 'knowledge:index:p:b?kind=case&key=commands');
    assert.equal(checkDuplicate(inputOf({ indexed_cases: support }))[0].verdict, 'support');
    const truncated = buildCompactIndex({ ...SYNTHETIC_INDEX_VIEW_COMPLETE, truncated: true }, undefined, 'knowledge:index:p:b?kind=case&key=commands');
    assert.equal(checkDuplicate(inputOf({ indexed_cases: truncated }))[0].verdict, 'unknown');
  });

  it('entries carry no expected-text field: a shared title with a different expected text still duplicates', () => {
    // The index entry has no expected texts to compare; the title (and the command-set key) decides.
    const duplicate = goodDraft({ title: '健康检查详细信息查看', expected: [{ text: '完全不同的期望', quote: { reference: 'src:x', text: '完全不同的期望' } }] });
    const draftOnKey = { ...duplicate, steps: [{ command: 'show health detail', note: '查看' }] };
    const compact = buildCompactIndex(SYNTHETIC_INDEX_VIEW, undefined, NARROWED);
    const outcomes = checkDuplicate(inputOf({ drafts: [draftOnKey], indexed_cases: compact }));
    assert.equal(outcomes[0].verdict, 'refute', 'the title alone decides when the entries carry no expected texts');
  });
});

describe('the per-key cap of the core (2000 entries)', () => {
  /** A view whose single key lists exactly MAX_INDEX_PER_KEY digests: possibly cut (a prose note is all the core gives). */
  const cappedView = (): IndexView => {
    const digests = Array.from({ length: MAX_INDEX_PER_KEY }, (_, i) => String(i + 1).padStart(64, '0'));
    const entries: IndexView['entries'] = {};
    for (const digest of digests) {
      entries[digest] = { ...SYNTHETIC_INDEX_VIEW.entries[HEX2]!, entry: digest, data: { ...SYNTHETIC_INDEX_VIEW.entries[HEX2]!.data } };
    }
    return { ...SYNTHETIC_INDEX_VIEW, keys: { 'show health detail': digests }, entries, total_keys: 1, total_entries: digests.length };
  };

  it('the compact index names the key as possibly cut and the check keeps such drafts unknown', () => {
    const compact = buildCompactIndex(cappedView(), 64 * 1024 * 1024, NARROWED);
    assert.ok(isCompactIndex(compact));
    assert.deepEqual(compact.cappedKeys, ['show health detail']);
    const draftOnKey = { ...goodDraft(), steps: [{ command: 'show health detail', note: '查看' }] };
    const outcomes = checkDuplicate(inputOf({ drafts: [draftOnKey], indexed_cases: compact }));
    assert.equal(outcomes[0].verdict, 'unknown');
    assert.equal(outcomes[0].reason, 'integrity_unproven');
    assert.match(outcomes[0].statement, /每键上限/);
  });

  it('a draft with one key under the cap and one capped key stays decidable (not every intersecting key is cut)', () => {
    // The widget key also carries a real entry under the cap (the capped digests all file under the show key).
    // A large byte budget keeps the compacting from dropping entries, so only the cap rule is under test.
    const mixed = buildCompactIndex({
      ...cappedView(),
      keys: { 'show health detail': Array.from({ length: MAX_INDEX_PER_KEY }, (_, i) => String(i + 1).padStart(64, '0')), 'widget health interval': [HEX2] },
      total_entries: MAX_INDEX_PER_KEY + 1,
    }, 64 * 1024 * 1024, 'knowledge:index:p:b?kind=case&key=commands&only=show%20health%20detail,widget%20health%20interval');
    const draftBoth = { ...goodDraft(), steps: [{ command: 'show health detail', note: 'a' }, { command: 'widget health interval', note: 'b' }] };
    const outcomes = checkDuplicate(inputOf({ drafts: [draftBoth], indexed_cases: mixed }));
    assert.equal(outcomes[0].verdict, 'support', 'the under-cap key in the intersection keeps the draft decidable');
  });

  it('a key under the cap is not named: the draft stays decidable (negative example of the cap rule)', () => {
    const compact = buildCompactIndex(SYNTHETIC_INDEX_VIEW, undefined, NARROWED);
    assert.deepEqual(compact.cappedKeys, []);
    const draftOnKey = { ...goodDraft(), steps: [{ command: 'show health detail', note: '查看' }] };
    assert.equal(checkDuplicate(inputOf({ drafts: [draftOnKey], indexed_cases: compact }))[0].verdict, 'support');
  });
});

describe('entries without a commands field', () => {
  it('counts them apart and keeps the no-duplicate claim unknown, never treating them as command-less', () => {
    const missing: IndexView = {
      ...SYNTHETIC_INDEX_VIEW,
      entries: { [HEX2]: { ...SYNTHETIC_INDEX_VIEW.entries[HEX2]!, data: { ...SYNTHETIC_INDEX_VIEW.entries[HEX2]!.data, commands: undefined } } },
    };
    const compact = buildCompactIndex(missing, undefined, NARROWED);
    assert.ok(compact.unplacedCommands >= 1);
    const draftOnKey = { ...goodDraft({ title: '健康检查详细信息查看' }), steps: [{ command: 'show health detail', note: '查看' }] };
    const outcomes = checkDuplicate(inputOf({ drafts: [draftOnKey], indexed_cases: compact }));
    assert.equal(outcomes[0].verdict, 'unknown');
    assert.match(outcomes[0].statement, /commands 字段/);
  });
});
