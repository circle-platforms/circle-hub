import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import ids, { idsFromTitle } from './ids.ts';
import { assertTotal, hostileInputs, internalWarnings, randomText, seeded } from '../testing/test-support.ts';

const of = (title: string) => {
  const { stories, bugs, plm, unclassified } = idsFromTitle(title);
  return { stories, bugs, plm, unclassified };
};
const none = { stories: [], bugs: [], plm: [], unclassified: [] };

describe('ids in document titles', () => {
  it('reads the marked conventions', () => {
    assert.deepEqual(of('bug to case 61001 会话保持'), { ...none, bugs: ['61001'] });
    assert.deepEqual(of('Bug-to-Case-7101 7102-支持导出报表'), { ...none, bugs: ['7101', '7102'] });
    assert.deepEqual(of('bug-to-case 161001 & 161002'), { ...none, bugs: ['161001', '161002'] });
    assert.deepEqual(of('Bug2case 110801&110802&110803'), { ...none, bugs: ['110801', '110802', '110803'] });
    assert.deepEqual(of('bugtocase 61005'), { ...none, bugs: ['61005'] });
    assert.deepEqual(of('bug61006 某银行项目'), { ...none, bugs: ['61006'] });
    assert.deepEqual(of('Test List of Bug 161007_SSL子功能'), { ...none, bugs: ['161007'] });
    assert.deepEqual(of('PLM7201-接口超时'), { ...none, plm: ['7201'] });
    assert.deepEqual(of('需求7301 支持新算法'), { ...none, stories: ['7301'] });
    assert.deepEqual(of('Story#7302 会话保持'), { ...none, stories: ['7302'] });
    assert.deepEqual(of('缺陷 61008：显示错误'), { ...none, bugs: ['61008'] });
  });

  it('lets the marker next to the number win', () => {
    assert.deepEqual(of('bug to case-需求7303 登录锁定'), { ...none, stories: ['7303'] });
  });

  it('reads misspelled markers seen in real titles', () => {
    for (const title of ['but-to-case_161011_SSH', 'Butocase 161011', 'bugt-to-case 161011', 'bug ro case - 161011 说明', 'bug to cae 161011', 'bug to csase 161011']) {
      assert.deepEqual(of(title), { ...none, bugs: ['161011'] }, title);
    }
  });

  it('reads lists separated by spaces, &, 、, commas and "and"', () => {
    assert.deepEqual(of('bug to case 61021 61022 61023'), { ...none, bugs: ['61021', '61022', '61023'] });
    assert.deepEqual(of('Bug to case 61024、61025'), { ...none, bugs: ['61024', '61025'] });
    assert.deepEqual(of('bug 61026 and 61027'), { ...none, bugs: ['61026', '61027'] });
    assert.deepEqual(of('Bug-to-case-161028/161029 宕机'), { ...none, bugs: ['161028', '161029'] });
    assert.deepEqual(of('bug to case 161030showtech 采集'), { ...none, bugs: ['161030'] });
  });

  it('returns unmarked leading ids as unclassified', () => {
    assert.deepEqual(of('7401-日志导出支持压缩'), none);
    assert.deepEqual(of('回归 - 161090 会话表'), { ...none, unclassified: ['161090'] });
    assert.deepEqual(of('二轮回归-161040-支持批量导入'), { ...none, unclassified: ['161040'] });
    assert.deepEqual(of('回归测试-7402 161041-日志分级'), none);
    assert.deepEqual(of('[回归]161042 161043 - 支持新调度'), { ...none, unclassified: ['161042', '161043'] });
    assert.deepEqual(of('161044 161045支持多个端口'), { ...none, unclassified: ['161044', '161045'] });
    assert.deepEqual(of('Test-161046-cookie flags'), { ...none, unclassified: ['161046'] });
    assert.deepEqual(of('[7403] 端口复用'), none);
    assert.deepEqual(of('161047回归测试'), { ...none, unclassified: ['161047'] });
  });

  it('reads full-width digits and marks', () => {
    assert.deepEqual(of('ｂｕｇ ｔｏ ｃａｓｅ\u3000６１０５１＆６１０５２'), { ...none, bugs: ['61051', '61052'] });
    assert.deepEqual(of('需求＃７３０４'), { ...none, stories: ['7304'] });
  });

  it('never takes versions, dates, alarm numbers or glued words for ids', () => {
    for (const title of [
      '10.6.1-R2-2026/7 测试',
      '某银行-20260531',
      '20260531 回归',
      '2026/7 发布',
      '2026 年度回归',
      'bug-to-case 2/27 patch-SSL握手',
      'bug to case 10.6.1.32 版本',
      'bug to case 2026-06-26 问题',
      '设备产生ID为900000001的告警',
      'option28 支持',
      'TLS-AES128-CCM 套件',
      '000-997-000：其他用例集',
      'demo 版本 Rel_APV_10_6_1_57',
      'bug to case abc',
      'debug 61060',
    ]) {
      assert.deepEqual(of(title), none, title);
    }
    assert.deepEqual(of('bug to case 61061 某行-NSAE-HG-K-10.6.1.32.5.6-设备产生ID为900000001的告警'), { ...none, bugs: ['61061'] });
    assert.deepEqual(of('161062 某单位+NSAE HG_U_10.6.1.186+升级到 K10.6.2.59 后启动失败'), { ...none, unclassified: ['161062'] });
  });
});

describe('ids on bad input', () => {
  it('is total and keeps its invariants on random titles', () => {
    for (const [k, input] of hostileInputs().entries()) assertTotal(ids, input, `hostile ${k}`);
    assert.deepEqual(ids({ title: 'bug 61001' }), idsFromTitle('bug 61001'));
    const random = seeded(43);
    const parts = ['bug to case ', 'Bug ', '需求', 'PLM', 'Story#', '回归 - ', '61001', '7402', '10.6.1', '2026/7', '20260531', ' & ', '、', '-', '测试', ' ', '[', ']'];
    for (let i = 0; i < 1000; i++) {
      const title = Array.from({ length: random.int(10) }, () => (random.chance(0.15) ? randomText(random, 8) : random.pick(parts))).join('');
      const result = assertTotal(ids, title, title) as ReturnType<typeof idsFromTitle>;
      assert.deepEqual(internalWarnings(result), []);
      const normalized = title.normalize('NFKC');
      for (const id of [...result.bugs, ...result.stories, ...result.plm, ...result.unclassified]) {
        assert.match(id, /^[0-9]{1,9}$/);
        assert.ok(new RegExp(`(?<![0-9])0*${id}(?![0-9])`).test(normalized), `${id} is not a digit run of ${title}`);
      }
      for (const id of result.unclassified) assert.ok(![...result.bugs, ...result.stories, ...result.plm].includes(id));
    }
    const long = idsFromTitle(`bug ${'1'.repeat(10)} ${'x'.repeat(10000)}`);
    assert.ok(long.warnings.some((warning) => warning.includes('只看前 4096 个')));
  });
});

it('normalizes zero-padded identities and preserves original spellings', () => {
  for (const raw of ['0123', '001234', '００１２３４']) {
    const id = raw.normalize('NFKC').replace(/^0+(?=\d)/, '');
    const found = idsFromTitle(`bug ${raw}`);
    assert.deepEqual(found.bugs, [id]);
    assert.deepEqual(found.spellings?.filter(entry => entry.kind === 'bug').map(entry => entry.raw) ?? found.bugs, [raw]);
  }
});

it('keeps every raw spelling when a normalized identity repeats', () => {
  const found = idsFromTitle('bug 0123 and 123 and 00123');
  assert.deepEqual(found.bugs, ['123']);
  assert.deepEqual(found.spellings?.map(entry => entry.raw), ['0123', '123', '00123']);
});

it('rejects single marked digits and all-zero strings before normalization', () => {
  for (const title of ['bug 1', 'bug 0', '缺陷 00', '需求 00', 'PLM0', 'bug to case 00',
    '0', '00', '00000', '000000', 'bug 000000000', '缺陷 ００']) {
    const found = idsFromTitle(title);
    assert.deepEqual([...found.stories, ...found.bugs, ...found.plm, ...found.unclassified], [], title);
  }
});
it('applies written digit lengths before stripping only nonzero leading zeros', () => {
  for (const [title, expected] of [
    ['bug 01', ['1']], ['bug 000000001', ['1']], ['bug 0000000001', []],
    ['0123 合成文档', []], ['00123 合成文档', ['123']],
    ['001234 合成文档', ['1234']], ['00000001 合成文档', []],
  ] as const) {
    const found = idsFromTitle(title);
    assert.deepEqual([...found.stories, ...found.bugs, ...found.plm, ...found.unclassified], expected, title);
  }
});
