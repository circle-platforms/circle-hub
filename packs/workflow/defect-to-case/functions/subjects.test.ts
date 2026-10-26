import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ItemSubjectInput } from '../../../../contracts/src/pack.ts';
import { makeDuplicateDraft, makeGoodDraft, makeNegativeExpectedRefutationDraft, SYNTHETIC_INDEX_VIEW } from '../testing/fixtures.ts';
import { commandSubject, duplicateSubject, quoteSubject } from './subjects.ts';

function makeItemInput(drafts: unknown[], groups: Record<string, unknown>[] = []): ItemSubjectInput {
  return {
    applies: 'item',
    item: {
      id: '74001',
      label: 'SLB健康检查间隔无法保存',
      location: 'src:sha_bug/json@1/p',
      fields: { id: '74001', title: 'SLB健康检查间隔无法保存' },
    },
    slots: {
      cases: drafts.map((d) => ({
        text: (d as { title?: string }).title ?? 'case title',
        data: d,
      })),
    },
    evidence: [],
    context: {
      product: 'famx',
      names: ['FAMX', 'FAMY'],
      line: '10.6.1',
      build: 'Rel_FAMX_10_6_1_57',
      root: '1111111111111111111111111111111111111111111111111111111111111111',
      parameters: {},
      groups,
    },
  };
}

describe('subjects', () => {
  it('commandSubject extracts command lines from drafts expecting resolution', () => {
    const good = makeGoodDraft();
    const neg = makeNegativeExpectedRefutationDraft();
    const input = makeItemInput([good, neg]);

    const subject = commandSubject(input) as { item: string; phrases: string[] };
    assert.equal(subject.item, '74001');
    // neg has expects_refutation: true, so its out-of-range command should not be checked by normal catalog support
    assert.deepEqual(subject.phrases, ['widget health interval 60']);
  });

  it('quoteSubject extracts quotation objects from draft expected results', () => {
    const good = makeGoodDraft({ ref: 'src:sha123/json@1/p/fields/fix' });
    const input = makeItemInput([good]);

    const subject = quoteSubject(input) as { item: string; quotes: Array<{ reference: string; text: string }> };
    assert.equal(subject.item, '74001');
    assert.equal(subject.quotes.length, 1);
    assert.equal(subject.quotes[0].reference, 'src:sha123/json@1/p/fields/fix');
    assert.equal(subject.quotes[0].text, '健康检查间隔设置成功');
  });

  it('duplicateSubject provides drafts and indexed_cases from context groups', () => {
    const dup = makeDuplicateDraft();
    const input = makeItemInput([dup], [{ indexed_cases: SYNTHETIC_INDEX_VIEW }]);

    const subject = duplicateSubject(input) as { item: string; drafts: unknown[]; indexed_cases: typeof SYNTHETIC_INDEX_VIEW };
    assert.equal(subject.item, '74001');
    assert.equal(subject.drafts.length, 1);
    assert.ok(subject.indexed_cases);
    assert.equal(subject.indexed_cases.total_entries, 1);
  });
});

it('duplicate subject derives distinct longest catalog heads for engine narrowed reads', () => {
  const input = makeItemInput([makeGoodDraft()]);
  input.catalog = [{ words: ['widget'] }, { words: ['widget', 'health', 'interval'] }];
  const subject = duplicateSubject(input) as { read_keys: string[] };
  assert.deepEqual(subject.read_keys, ['/commands/widget/health/interval']);
});
it('duplicate subject never guesses an unresolved command head', () => {
  const draft=makeGoodDraft();draft.steps=[{command:'unresolved'}];const input = makeItemInput([draft]); input.catalog = [];
  assert.deepEqual((duplicateSubject(input) as { read_keys: string[] }).read_keys, []);
});
it('duplicate subject reads the catalog command path and ignores a model read_keys declaration', () => {
  const draft = makeGoodDraft();
  draft.steps = [{ command: 'widget health interval 60' }];
  (draft as { read_keys?: string[] }).read_keys = ['user'];
  const input = makeItemInput([draft]);
  const root = 'b'.repeat(64);
  input.catalog = [{ words: ['widget'] }, { words: ['widget', 'health', 'interval'], reference: `tree:${root}/commands/widget/health/interval` }];
  assert.deepEqual((duplicateSubject(input) as { read_keys: string[] }).read_keys, ['/commands/widget/health/interval']);
});
