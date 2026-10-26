import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SYNTHETIC_CATALOG, SYNTHETIC_INDEX_VIEW, makeGoodDraft } from '../testing/fixtures.ts';
import { QUOTE_BYTES, QUOTE_SOURCE } from '../testing/structure.ts';
import { checkDuplicate, checkGroundedReading } from './checks.ts';

test('grounded reading derives the quote identity from a fix_notes reference and ignores a model identity', () => {
  const quote = '合成说明：保存设置成功。';
  const raw = JSON.stringify({ fix_notes: [{ comment: quote }, { comment: '另一条说明' }] });
  const sha = createHash('sha256').update(raw).digest('hex');
  const draft = makeGoodDraft();
  draft.expected = [{ text: quote, quote: { reference: `src:${sha}/json@1/p/fix_notes/0/comment`, text: quote }, identity: { digest: sha, sha256: sha, parser: 'json@1', path: 'p/fix_notes/0/comment', byte_span: { offset: 0, length: 4 }, after: 1 } }];
  const out = checkGroundedReading({ sources: { ['src:' + sha]: raw }, subject: { item: 'synthetic', slots: { cases: [{ data: draft }] } } });
  assert.equal(out[0].verdict, 'support');
});

test('a manual reference without a byte span is grounded when the quotation is unique', () => {
  const quote = '健康检查间隔设置成功';
  const raw = `# 手册\n\n${quote}\n`;
  const sha = createHash('sha256').update(raw).digest('hex');
  const draft = makeGoodDraft();
  draft.expected = [{ text: quote, quote: { reference: `src:${sha}/markdown@1/h/手册`, text: quote } }];
  const out = checkGroundedReading({ sources: { ['src:' + sha]: raw }, subject: { slots: { cases: [{ data: draft }] } } });
  assert.equal(out[0].verdict, 'support');
});

test('a repeated quotation in one fragment stays unresolved', () => {
  const quote = '相同说明';
  const raw = JSON.stringify({ fix_notes: [{ comment: quote + quote }] });
  const sha = createHash('sha256').update(raw).digest('hex');
  const draft = makeGoodDraft();
  draft.expected = [{ text: quote, quote: { reference: `src:${sha}/json@1/p/fix_notes/0/comment`, text: quote } }];
  const out = checkGroundedReading({ sources: { ['src:' + sha]: raw }, subject: { slots: { cases: [{ data: draft }] } } });
  assert.equal(out[0].verdict, 'unknown');
  assert.match(out[0].statement, /唯一的原始字节位置/);
});

test('a text line reference is grounded without a declared identity', () => {
  const quote = '健康检查间隔设置成功';
  const draft = makeGoodDraft();
  draft.expected = [{ text: quote, quote: { reference: `src:${QUOTE_SOURCE}/text@1/l/1`, text: quote } }];
  const out = checkGroundedReading({ sources: { ['src:' + QUOTE_SOURCE]: QUOTE_BYTES }, subject: { slots: { cases: [{ data: draft }] } } });
  assert.equal(out[0].verdict, 'support');
});

test('an empty complete command bucket is not a duplicate and does not need a model identity', () => {
  const draft = makeGoodDraft();
  draft.steps = [{ command: 'widget health interval 60' }];
  delete draft.expected[0].identity;
  delete draft.expected[0].after;
  const path = '/commands/widget/health/interval';
  const view = { ...structuredClone(SYNTHETIC_INDEX_VIEW), keys: {}, entries: {}, only: [path], cut_keys: [], total_keys: 0, total_entries: 0 };
  const out = checkDuplicate({ subject: { item: 'synthetic', drafts: [draft], indexed_cases: view }, catalog: SYNTHETIC_CATALOG })[0];
  assert.equal(out.verdict, 'support');
  assert.match(out.statement, /范围内没有重复/);
});

test('the same command without a draft structure stays unresolved', () => {
  const draft = makeGoodDraft();
  draft.steps = [{ command: 'widget health interval 60' }];
  delete draft.expected[0].identity;
  const path = '/commands/widget/health/interval';
  const entry = 'c'.repeat(64);
  const view = {
    ...structuredClone(SYNTHETIC_INDEX_VIEW), only: [path], cut_keys: [], total_keys: 1, total_entries: 1,
    keys: { [path]: [entry] },
    entries: { [entry]: { entry, kind: 'case', statement: '合成', reference: `tree:${'a'.repeat(64)}/case/x`, data: { document: 'doc', node: 'n', commands: [path] } } },
  };
  const out = checkDuplicate({ subject: { item: 'synthetic', drafts: [draft], indexed_cases: view }, catalog: SYNTHETIC_CATALOG })[0];
  assert.equal(out.verdict, 'unknown');
  assert.match(out.statement, /同命令/);
});
