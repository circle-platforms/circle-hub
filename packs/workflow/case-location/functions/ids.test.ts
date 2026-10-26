// famx-id-fields@1 (declared for the owner's R6 rule, 2026-10-24): an identifier comes from a whole field the author
// wrote — `bug:<decimal list>` or `story:<decimal list>`, or a field that is only a decimal list, whose kind the caller's
// declared id ranges give. Nothing is read out of prose: no marker word, no misspelling of one, no leading number, no
// date or version, no folded full-width form. What the grammar does not read is simply absent, and the answer says what
// is missing and who declares it (the author writes the field, or a model proposes the link with a verbatim quote).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bugToCaseIds, extractIds, hasIds, leadingIds, markedIds, normalizeId } from './ids.ts';

const ids = (text: string, options?: { leading?: boolean }) => extractIds(text, options).map((f) => `${f.kind ?? '?'}:${f.id}`);

describe('declared identifier fields', () => {
  it('reads a whole bug or story field, with a comma-separated decimal list', () => {
    assert.deepEqual(ids('bug:61001'), ['bug:61001']);
    assert.deepEqual(ids('story:20931'), ['story:20931']);
    assert.deepEqual(ids('bug:118000,118001'), ['bug:118000', 'bug:118001']);
    assert.deepEqual(ids('story:20931,20932,20933'), ['story:20931', 'story:20932', 'story:20933']);
    assert.deepEqual(markedIds('bug:61001'), [{ kind: 'bug', id: '61001' }]);
    assert.ok(hasIds('bug:61001'));
    assert.ok(!hasIds('bug to case 61001'), 'a marker word in prose is not a declared field');
    assert.ok(!hasIds('61001'), 'a bare list has no declared kind');
  });

  it('reads a whole decimal list as identifiers of undeclared kind', () => {
    assert.deepEqual(ids('61001'), ['?:61001']);
    assert.deepEqual(ids('61001,61002'), ['?:61001', '?:61002']);
    assert.deepEqual(leadingIds('20931'), [{ kind: null, id: '20931' }]);
    assert.deepEqual(extractIds('61001', { leading: false }), [], 'the caller can ask for declared kinds only');
    // The kind of an undeclared list is the caller's declared range, never a word in the text.
    assert.deepEqual(markedIds('61001'), []);
  });

  it('normalizes an identity by the declared decimal grammar and accepts nothing else', () => {
    assert.equal(normalizeId('61001'), '61001');
    assert.equal(normalizeId('123456789012'), '123456789012', 'twelve digits are inside the grammar');
    for (const text of ['', '0', '061001', '61001 ', ' 61001', '61001.0', 'bug:61001', '1234567890123', '-1', '1e5', '６１００１', '61001,61002']) {
      assert.equal(normalizeId(text), null, JSON.stringify(text));
    }
  });

  it('reads nothing out of prose, misspellings, dates, versions or folded forms', () => {
    for (const text of [
      // The retired rule read a kind from the word before a number, tolerated misspellings of it, and read unmarked
      // numbers at the start of a title. None of that is a declared field.
      'bug 61001 会话保持', 'Bug 118000&118001 内存泄漏', '缺陷 70412、70413', '需求20931 证书链校验',
      '需求单 20932', 'Story#20777 认证方式', 'stories 20001 and 20002', 'bug to case-需求20931 证书',
      'Bug-to-Case-缺陷71001', 'but61001', 'bugt61001', 'ro61001', 'cases61001',
      '61001-会话保持', '2026/7 回归', '10.6.1.32 验证', '回归测试',
      // A declared field is the whole text: not folded, not embedded, not padded, not open-ended.
      'bug:61001 会话保持', 'bug: 61001', 'BUG:61001', 'ｂｕｇ:61001', 'bug:061001', 'bug:', 'bug:61001,',
      'story:20931 bug:61001', 'bug:61001;story:20931',
    ]) {
      assert.deepEqual(ids(text), [], JSON.stringify(text));
    }
    assert.deepEqual(bugToCaseIds('bug to case 61001, but61002, bugt61003'), [], 'the retired bug-to-case reading yields nothing');
    // A field that is only a decimal list is an identifier of undeclared kind, whatever it also looks like: the retired
    // rule dropped dates, years and quantities by meaning. The author's field or the caller's declared range decides the
    // kind; nothing here guesses it, and a date-shaped list stays an unread kind rather than being silently dropped.
    assert.deepEqual(ids('20260531'), ['?:20260531']);
  });

  it('stays linear on a long declared list and on hostile text', () => {
    const list = `bug:${Array.from({ length: 200 }, (_, k) => 10000 + k).join(',')}`;
    assert.equal(extractIds(list).length, 200);
    assert.deepEqual(ids(`bug:${'6'.repeat(13)}`), [], 'a number outside the declared digit length is not an id');
    assert.deepEqual(ids(`bug:61001,${'6'.repeat(13)}`), [], 'one bad member refuses the whole field');
    assert.deepEqual(ids('bug:'.padEnd(100000, '6')), []);
    assert.deepEqual(ids(`${'需求20931 '.repeat(5000)}`), [], 'repeated marker words in prose are not scanned');
  });
});
