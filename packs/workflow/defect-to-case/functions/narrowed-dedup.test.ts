// The decidability rules of deduplication on a narrowed index, at real scale. Three sources of truth:
// - only and cut_keys come from the source view when present. Legacy views fall back to URI parsing
//   and the 2000-entry cap, with an explicit inference note.
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

/** A legacy view with exactly MAX_INDEX_PER_KEY digests under one key: possibly cut. */
const cappedView = (): IndexView => {
  const digests = Array.from({ length: MAX_INDEX_PER_KEY }, (_, i) => String(i + 1).padStart(64, '0'));
  const entries: IndexView['entries'] = {};
  for (const digest of digests) {
    entries[digest] = { ...SYNTHETIC_INDEX_VIEW.entries[HEX2]!, entry: digest, data: { ...SYNTHETIC_INDEX_VIEW.entries[HEX2]!.data } };
  }
  return { ...SYNTHETIC_INDEX_VIEW, keys: { 'show health detail': digests }, entries, total_keys: 1, total_entries: digests.length };
};

describe('the per-key cap of the core (2000 entries)', () => {
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


describe('index metadata fields take precedence over URI and cap inference', () => {
  const draftOnKey = { ...goodDraft(), steps: [{ command: 'show health detail', note: '查看' }] };
  const duplicate = { ...draftOnKey, title: '健康检查详细信息查看' };
  const outcome = (view: unknown, external: string, draft = draftOnKey) => {
    const compact = buildCompactIndex(view, 64 * 1024 * 1024, external);
    return { compact, result: checkDuplicate(inputOf({ drafts: [draft], indexed_cases: compact }))[0] };
  };

  it('uses only from the view even when the URI names another command: support, refute and unknown', () => {
    const view = { ...SYNTHETIC_INDEX_VIEW, only: ['show health detail'], cut_keys: [] };
    const external = 'knowledge:index:p:b?kind=case&key=commands&only=widget%20health%20interval';
    const good = outcome(view, external);
    assert.deepEqual(good.compact.only, ['show health detail']);
    assert.deepEqual(good.compact.cappedKeys, []);
    assert.equal(good.result.verdict, 'support');
    assert.ok(!good.compact.notes.some(note => note.includes('按 URI 和上限推断')));
    assert.equal(outcome(view, external, duplicate).result.verdict, 'refute');
    const outside = { ...draftOnKey, steps: [{ command: 'widget health interval 60', note: '设置' }] };
    assert.equal(outcome(view, external, outside).result.verdict, 'unknown');
  });

  it('does not widen a view to a command named only by the URI', () => {
    const view = { ...SYNTHETIC_INDEX_VIEW, only: ['widget health interval'], cut_keys: [] };
    const checked = outcome(view, NARROWED);
    assert.deepEqual(checked.compact.only, ['widget health interval']);
    assert.equal(checked.result.verdict, 'unknown');
    assert.equal(outcome(view, NARROWED, duplicate).result.verdict, 'refute');
  });

  it('a truncated narrowed view stays unknown even with authoritative metadata', () => {
    const external = 'knowledge:index:p:b?kind=case&key=commands';
    const view = { ...SYNTHETIC_INDEX_VIEW, truncated: true, only: ['show health detail'], cut_keys: [] };
    assert.equal(outcome(view, external).result.verdict, 'unknown');
    assert.equal(outcome({ ...view, only: [] }, NARROWED).result.verdict, 'unknown');
  });

  it('an explicit empty cut_keys keeps a key with exactly 2000 entries decidable', () => {
    const view = { ...cappedView(), only: ['show health detail'], cut_keys: [] };
    const checked = outcome(view, NARROWED);
    assert.deepEqual(checked.compact.cappedKeys, []);
    assert.equal(checked.result.verdict, 'support');
    assert.equal(outcome(view, NARROWED, duplicate).result.verdict, 'refute');
  });

  it('an explicitly cut key is unknown below 2000 entries, but a visible duplicate is still refuted', () => {
    const view = { ...SYNTHETIC_INDEX_VIEW, only: ['show health detail'], cut_keys: ['show health detail'] };
    const checked = outcome(view, NARROWED);
    assert.deepEqual(checked.compact.cappedKeys, ['show health detail']);
    assert.equal(checked.result.verdict, 'unknown');
    assert.match(checked.result.statement, /每键上限/);
    assert.doesNotMatch(checked.result.statement, /正好列到/);
    assert.equal(outcome(view, NARROWED, duplicate).result.verdict, 'refute');
  });

  it('old views infer URI narrowing and per-key cuts, and disclose the inference', () => {
    const good = outcome(SYNTHETIC_INDEX_VIEW, NARROWED);
    assert.equal(good.result.verdict, 'support');
    assert.deepEqual(good.compact.only, ['show health detail']);
    assert.ok(good.compact.notes.some(note => note.includes('按 URI 和上限推断')));
    const cut = outcome(cappedView(), NARROWED);
    assert.equal(cut.result.verdict, 'unknown');
    assert.deepEqual(cut.compact.cappedKeys, ['show health detail']);
    assert.ok(cut.compact.notes.some(note => note.includes('按 URI 和上限推断')));
    assert.equal(outcome(SYNTHETIC_INDEX_VIEW, NARROWED, duplicate).result.verdict, 'refute');
  });

  it('falls back separately for each absent field', () => {
    const only = outcome({ ...cappedView(), only: ['widget health interval'] }, NARROWED);
    assert.deepEqual(only.compact.only, ['widget health interval']);
    assert.deepEqual(only.compact.cappedKeys, ['show health detail']);
    assert.equal(only.result.verdict, 'unknown');
    assert.ok(only.compact.notes.some(note => note.includes('按 URI 和上限推断')));
    const cut = outcome({ ...cappedView(), cut_keys: [] }, NARROWED);
    assert.equal(cut.result.verdict, 'support');
    assert.deepEqual(cut.compact.cappedKeys, []);
    assert.deepEqual(cut.compact.only, ['show health detail']);
    assert.ok(cut.compact.notes.some(note => note.includes('按 URI 和上限推断')));
  });

  it('present malformed metadata cannot borrow the URI or claim completeness', () => {
    for (const fields of [{ only: null, cut_keys: [] }, { only: ['show health detail'], cut_keys: [123] }]) {
      const checked = outcome({ ...SYNTHETIC_INDEX_VIEW, ...fields }, NARROWED);
      assert.equal(checked.compact.complete, false);
      assert.equal(checked.result.verdict, 'unknown');
      assert.ok(checked.compact.notes.some(note => note.includes('字段形状无效')));
      assert.ok(!checked.compact.notes.some(note => note.includes('按 URI 和上限推断')));
    }
  });

});


describe('requested keys missing from narrowed views', () => {
  const draft = { ...goodDraft(), steps: [{ command: 'show health detail', note: '查看' }] };
  const check = (view: unknown) => checkDuplicate(inputOf({ drafts: [draft], indexed_cases: buildCompactIndex(view, undefined, NARROWED) }))[0];
  it('missing keys are unknown and name what must be read again', () => {
    const result = check({ ...SYNTHETIC_INDEX_VIEW, keys: {}, entries: {}, only: ['show health detail'], cut_keys: [], truncated: true });
    assert.equal(result.verdict, 'unknown');
    assert.equal(result.reason, 'integrity_unproven');
    assert.match(result.statement, /缺少.*show health detail/);
  });
  it('explicit empty keys prove absence only when the narrowed view is complete', () => {
    const view = { ...SYNTHETIC_INDEX_VIEW, keys: { 'show health detail': [] }, entries: {}, only: ['show health detail'], cut_keys: [] };
    assert.equal(check(view).verdict, 'support');
    assert.equal(check({ ...view, truncated: true }).verdict, 'unknown');
  });
  it('a visible duplicate remains refuted in a truncated source view', () => {
    const compact = buildCompactIndex({ ...SYNTHETIC_INDEX_VIEW, only: ['show health detail'], cut_keys: [], truncated: true });
    const result = checkDuplicate(inputOf({ drafts: [{ ...draft, title: '健康检查详细信息查看' }], indexed_cases: compact }))[0];
    assert.equal(result.verdict, 'refute');
    assert.equal(result.code, 'defect-to-case.duplicate_case');
  });
});

 it('one visible duplicate does not suppress another draft needing coverage', () => {
 const compact = buildCompactIndex({ ...SYNTHETIC_INDEX_VIEW, only: ['show health detail'], cut_keys: ['show health detail'], truncated: true });
 const drafts = ['健康检查详细信息查看', '另一份合成用例'].map(title => ({ ...goodDraft({ title }), steps: [{ command: 'show health detail' }] }));
 const results = checkDuplicate(inputOf({drafts, indexed_cases: compact}));
 assert.ok(results.some(r => r.verdict === 'refute'));
 assert.ok(results.some(r => r.verdict === 'unknown' && r.statement.includes('另一份合成用例') && /集成者/.test(r.statement)));
});

it('compacting preserves the exact skipped-document fact needed to repair coverage', () => {
  const compact = buildCompactIndex({ ...SYNTHETIC_INDEX_VIEW, only: ['show health detail'], cut_keys: [], truncated: false, skipped: 3 });
  const result = checkDuplicate(inputOf({ drafts: [{ ...goodDraft(), steps: [{ command: 'show health detail' }] }], indexed_cases: compact }))[0];
  assert.equal(result.verdict, 'unknown');
  assert.match(result.statement, /缺少 3 份文档.*新根/);
});

it('skipped composition sources cannot be repaired by rereading an absent key', () => {
  const command = 'widget health interval';
  const compact = buildCompactIndex({ ...SYNTHETIC_INDEX_VIEW, only: [command], cut_keys: [], truncated: false, skipped: 3 });
  assert.deepEqual(compact.missingKeys, []);
  const result = checkDuplicate(inputOf({ drafts: [{ ...goodDraft(), steps: [{ command }] }], indexed_cases: compact }))[0];
  assert.equal(result.verdict, 'unknown');
  assert.match(result.statement, /3 份文档.*新根/);
  assert.doesNotMatch(result.statement, /提高预算|重新读取这些键/);
});
it('per-key caps name a capability gap rather than an impossible budget increase', () => {
  const compact = buildCompactIndex({ ...SYNTHETIC_INDEX_VIEW, only: ['show health detail'], cut_keys: ['show health detail'], truncated: true });
  const result = checkDuplicate(inputOf({ drafts: [{ ...goodDraft({ title: '合成的新草稿' }), steps: [{ command: 'show health detail' }] }], indexed_cases: compact }))[0];
  assert.equal(result.verdict, 'unknown');
  assert.match(result.statement, /每键上限.*集成者/);
  assert.doesNotMatch(result.statement, /提高预算/);
});

it('c3 skipped sources and a draft outside only name both independent recovery steps',()=>{
 const compact=buildCompactIndex({...SYNTHETIC_INDEX_VIEW,only:['show health detail'],cut_keys:[],truncated:false,skipped:3});
 const outcome=checkDuplicate(inputOf({drafts:[goodDraft()],indexed_cases:compact}))[0];assert.equal(outcome.verdict,'unknown');assert.equal(outcome.reason,'integrity_unproven');
 assert.match(outcome.statement,/3 份文档.*新根/);assert.match(outcome.statement,/草稿命令.*only/);
});
it('c3 malformed cut keys name core metadata rather than nonexistent missing sources',()=>{
 const compact=buildCompactIndex({...SYNTHETIC_INDEX_VIEW,only:['widget health interval'],cut_keys:'show health detail',truncated:false,skipped:0});
 const outcome=checkDuplicate(inputOf({drafts:[goodDraft()],indexed_cases:compact}))[0];assert.equal(outcome.verdict,'unknown');assert.match(outcome.statement,/only.*cut_keys.*字段形状无效/);assert.match(outcome.statement,/集成者/);assert.doesNotMatch(outcome.statement,/修复缺失来源/);
});
