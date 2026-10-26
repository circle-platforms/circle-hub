// famx-id-fields@1 (declared for the owner's R6 rule, 2026-10-24): a document's identifiers come from a whole field the
// author wrote — `bug:<decimal list>` or `story:<decimal list>` — or from a field that is only a decimal list, whose kind
// nothing declares. Nothing is read out of a title's prose: no marker word, no misspelling of one, no `PLM` prefix, no
// padded or date-shaped number, no folded full-width form. What the grammar does not read is absent, and the answer says
// what is missing and who declares it (the author writes the field, or a model proposes the link with a verbatim quote).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import ids, { idsFromTitle, normalizeId } from './ids.ts';
import { assertTotal, hostileInputs, internalWarnings, randomText, seeded } from '../testing/test-support.ts';

const of = (title: string) => {
  const { stories, bugs, plm, unclassified } = idsFromTitle(title);
  return { stories, bugs, plm, unclassified };
};
const none = { stories: [], bugs: [], plm: [], unclassified: [] };
const MISSING = '缺少显式编号字段或经核验的模型编号主张；下一步由作者补 bug/story 编号字段或提交逐字引文后重产';

describe('declared identifier fields', () => {
  it('reads a whole bug or story field, with a comma-separated decimal list', () => {
    assert.deepEqual(of('bug:61001'), { ...none, bugs: ['61001'] });
    assert.deepEqual(of('story:7301'), { ...none, stories: ['7301'] });
    assert.deepEqual(of('bug:110801,110802,110803'), { ...none, bugs: ['110801', '110802', '110803'] });
    assert.deepEqual(of('story:7301,7302'), { ...none, stories: ['7301', '7302'] });
    assert.deepEqual(idsFromTitle('bug:61001').warnings, [], 'a declared field needs no repair warning');
    // The producer's input shape: a record with the title, or the title itself.
    assert.deepEqual(ids({ title: 'story:7301' }).stories, ['7301']);
    assert.deepEqual(ids('bug:61001').bugs, ['61001']);
  });

  it('reads a whole decimal list as identifiers of undeclared kind', () => {
    assert.deepEqual(of('61001'), { ...none, unclassified: ['61001'] });
    assert.deepEqual(of('61001,61002'), { ...none, unclassified: ['61001', '61002'] });
    // No kind is guessed for an undeclared list, and the answer names the missing declaration and the author's exit.
    assert.deepEqual(idsFromTitle('61001').warnings, [MISSING]);
  });

  it('normalizes an identity by the declared decimal grammar and accepts nothing else', () => {
    assert.equal(normalizeId('61001'), '61001');
    assert.equal(normalizeId('123456789012'), '123456789012', 'twelve digits are inside the grammar');
    for (const text of ['', '0', '061001', '61001 ', ' 61001', '61001.0', 'bug:61001', '1234567890123', '-1', '1e5', '６１００１', '61001,61002']) {
      assert.equal(normalizeId(text), null, JSON.stringify(text));
    }
  });

  it('reads nothing out of prose, misspellings, dates, versions or folded forms', () => {
    // A title that is only a decimal list is an identifier of undeclared kind, whatever it also looks like: the retired
    // rule dropped dates, years and quantities by meaning. Nothing here guesses the kind.
    assert.deepEqual(of('20260531'), { ...none, unclassified: ['20260531'] });
    assert.deepEqual(idsFromTitle('20260531').warnings, [MISSING]);
    for (const title of [
      // The retired rule read a kind from the word before a number, tolerated misspellings of that word, read unmarked
      // numbers at the start of a title, and gave `PLM` its own bucket. None of that is a declared field.
      'bug to case 61001 会话保持', 'Bug-to-Case-7101 7102-支持导出报表', 'bug-to-case 161001 & 161002',
      'Bug2case 110801&110802&110803', 'bugtocase 61005', 'bug61006 某银行项目', 'but61007', 'bugt61007', 'ro61007',
      'Test List of Bug 161007_SSL子功能', 'PLM7201-接口超时', '需求7301 支持新算法', 'Story#7302 会话保持',
      '缺陷 61008：显示错误', 'bug to case-需求7303 登录锁定', '需求单 7304', 'stories 7305 and 7306',
      '2026/7 回归', '10.6.1.32 验证', '61001-会话保持',
      // A declared field is the whole title: not folded, not embedded, not padded, not open-ended.
      'bug:61001 会话保持', 'bug: 61001', 'BUG:61001', 'ｂｕｇ:61001', 'bug:061001', 'bug:', 'bug:61001,',
      'story:7301 bug:61001', 'bug:61001;story:7301',
    ]) {
      assert.deepEqual(of(title), title === '61001-会话保持' ? none : none, JSON.stringify(title));
      assert.deepEqual(idsFromTitle(title).warnings, [MISSING], JSON.stringify(title));
    }
  });

  it('is total on hostile and long input, and stays linear', () => {
    const list = `bug:${Array.from({ length: 200 }, (_, k) => 10000 + k).join(',')}`;
    assert.equal(idsFromTitle(list).bugs.length, 200);
    assert.deepEqual(of(`bug:${'6'.repeat(13)}`), none, 'a number outside the declared digit length is not an identifier');
    assert.deepEqual(of(`bug:61001,${'6'.repeat(13)}`), none, 'one bad member refuses the whole field');
    assert.deepEqual(of(`bug:61001`.padEnd(100000, 'x')), none);
    assert.deepEqual(of(`${'需求20931 '.repeat(5000)}`), none, 'repeated marker words in prose are not scanned');
    for (const [k, input] of hostileInputs().entries()) {
      const out = assertTotal(ids, input, `hostile ${k}`) as ReturnType<typeof idsFromTitle>;
      assert.deepEqual(internalWarnings(out), []);
    }
    // Random prose never yields an identifier: the grammar reads whole declared fields only.
    const random = seeded(43);
    const parts = ['bug', 'story', 'to', 'case', '需求', '缺陷', '61001', '20260531', 'SSL', '-', '#', '：', ' '];
    for (let k = 0; k < 200; k++) {
      const title = Array.from({ length: random.int(10) }, () => (random.chance(0.15) ? randomText(random, 8) : random.pick(parts))).join('');
      const result = assertTotal(ids, title, title) as ReturnType<typeof idsFromTitle>;
      assert.deepEqual(internalWarnings(result), []);
      assert.deepEqual([result.stories, result.bugs, result.plm], [[], [], []], title);
    }
    assert.deepEqual(of(randomText(seeded(7), 4000)), none);
  });
});
