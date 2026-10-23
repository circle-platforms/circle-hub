import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractIds, leadingIds, markedIds } from './ids.ts';

const ids = (text: string, options?: { leading?: boolean }) => extractIds(text, options).map((f) => `${f.kind ?? '?'}:${f.id}`);

describe('ids in titles', () => {
  it('reads the kind from the word right before the number', () => {
    assert.deepEqual(ids('bug 61001 会话保持'), ['bug:61001']);
    assert.deepEqual(ids('Bug 118000&118001 内存泄漏'), ['bug:118000', 'bug:118001']);
    assert.deepEqual(ids('缺陷 70412、70413'), ['bug:70412', 'bug:70413']);
    assert.deepEqual(ids('需求20931 证书链校验'), ['story:20931']);
    assert.deepEqual(ids('需求单 20932'), ['story:20932']);
    assert.deepEqual(ids('Story#20777 认证方式'), ['story:20777']);
    assert.deepEqual(ids('stories 20001 and 20002'), ['story:20001', 'story:20002']);
    assert.deepEqual(ids('bug to case-需求20931 证书'), ['story:20931']);
    assert.deepEqual(ids('Bug-to-Case-缺陷71001'), ['bug:71001']);
  });

  it('reads bug-to-case numbers as defects, including misspellings', () => {
    for (const title of ['bug to case 90101 会话', 'Bug2case 90101', 'bugtocase90101', 'but-to-case 90101', 'Butocase 90101', 'bug ro case 90101', 'Bug-to-Case-90101', 'bugt-to-case 90101']) {
      assert.deepEqual(ids(title), ['bug:90101'], title);
    }
  });

  it('reads unmarked numbers at the start of a title, after neutral words and brackets', () => {
    assert.deepEqual(ids('33001-SSL证书链'), ['?:33001']);
    assert.deepEqual(ids('146001 146002 两个缺陷的回归'), ['?:146001', '?:146002']);
    assert.deepEqual(ids('回归 - 112233 会话'), ['?:112233']);
    assert.deepEqual(ids('Test-129001-导出'), ['?:129001']);
    assert.deepEqual(ids('【SSL】31057 证书'), ['?:31057']);
    assert.deepEqual(ids('[31057] 证书'), ['?:31057']);
    assert.deepEqual(ids('31057 并发连接数限制'), ['?:31057']);
    assert.deepEqual(leadingIds('二轮回归测试 31058'), [{ kind: null, id: '31058' }]);
  });

  it('never reads a leading quantity as an id: fewer than five digits, or a number glued to Han text or a unit', () => {
    // Unmarked ids of the defect system have five digits or more (case-review measured 947 of 949 sampled unmarked ids at
    // 10,000 or more); four-digit numbers at the start are ports, limits and sizes.
    for (const title of ['8080 端口测试', '4094 VLAN 上限', '1024 位 RSA 证书导入', '4096位密钥导入', '1000条规则压力', '10000并发压力测试', '20000ms 超时', '50000 qps 压力', '12345%']) {
      assert.deepEqual(ids(title), [], title);
    }
    // A marker still names a short or glued id.
    assert.deepEqual(ids('bug 8080 端口'), ['bug:8080']);
    assert.deepEqual(ids('需求20931证书链'), ['story:20931']);
  });

  it('reads only marked ids where a leading number is no id (folders deep in the tree, the map path, the case text)', () => {
    assert.deepEqual(ids('61001-会话保持', { leading: false }), []);
    assert.deepEqual(ids('10000 并发握手', { leading: false }), []);
    assert.deepEqual(ids('bug 61001 会话保持', { leading: false }), ['bug:61001']);
    assert.deepEqual(ids('bug to case 61001', { leading: false }), ['bug:61001']);
    assert.deepEqual(ids('需求20931 证书', { leading: false }), ['story:20931']);
  });

  it('never reads versions, dates, years, times, prefixes or glued numbers as ids', () => {
    for (const title of [
      '10.6.1.32 验证',
      '2026/7 回归',
      '2025 年度回归',
      '20260531 发布',
      '2024-06-26 会话',
      '12:30 定时任务',
      '201：3.2.1-主线-2026/06/30',
      '1001：网络',
      '10001：网络',
      'option28 参数',
      'debug 61001',
      'history 61001',
      'bug 1',
      '需求 1234567890',
      'SSL 证书 3a',
      '',
    ]) {
      assert.deepEqual(ids(title), [], title);
    }
    assert.deepEqual(ids('bug 61001 2026/7 回归'), ['bug:61001']);
    assert.deepEqual(ids('bug 61001 10.6.1 回归'), ['bug:61001']);
  });

  it('names each id once, a marked kind before the unmarked reading', () => {
    assert.deepEqual(ids('61001-会话保持 bug 61001'), ['bug:61001']);
    assert.deepEqual(ids('需求 20931 bug 20931'), ['story:20931', 'bug:20931']);
    assert.deepEqual(markedIds('bug 61001 bug 61001'), [
      { kind: 'bug', id: '61001' },
      { kind: 'bug', id: '61001' },
    ]);
    assert.deepEqual(ids('bug 61001 bug 61001'), ['bug:61001']);
  });

  it('reads NFKC forms and stays linear on long or hostile titles', () => {
    assert.deepEqual(ids('ＢＵＧ　６１００１'), ['bug:61001']);
    assert.deepEqual(ids('需求：２０９３１'), ['story:20931']);
    const long = `${'bug '.repeat(20000)}61001`;
    const started = performance.now();
    assert.deepEqual(ids(long), []);
    assert.deepEqual(ids(`${'需求20931、'.repeat(3000)}`).length, 1);
    assert.ok(performance.now() - started < 2000);
    assert.deepEqual(ids('\ud800 bug 61001 \udfff'), ['bug:61001']);
  });
});

it('PLM remains unmarked', () => { assert.deepEqual(ids('PLM90101-导出'), ['?:90101']); });

it('normalizes identifier identity while retaining every original zero-padded spelling', () => {
  for (const raw of ['0123', '001234', '００１２３４']) {
    const id = raw.normalize('NFKC').replace(/^0+(?=\d)/, '');
    const found = extractIds(`bug ${raw}`);
    assert.equal(found.length, 1); assert.equal(found[0].id, id);
    assert.deepEqual(found[0].spellings ?? [found[0].id], [raw]);
  }
  const found = extractIds('bug 0123 and 123 and 00123');
  assert.equal(found.length, 1); assert.equal(found[0].id, '123');
  assert.deepEqual(found[0].spellings, ['0123', '123', '00123']);
});

it('uses the same decimal identity rule as the product pack', async () => {
  const product = await import('../../../product/apv/functions/ids.ts');
  for (const raw of ['0123', '001234', '００１２３４']) {
    assert.deepEqual(extractIds(`bug ${raw}`).map(found => found.id), product.idsFromTitle(`bug ${raw}`).bugs);
  }
});

it('rejects single marked digits and all-zero strings before normalization', () => {
  for (const title of ['bug 1', 'bug 0', '缺陷 00', '需求 00', 'PLM0', 'bug to case 00',
    '0', '00', '00000', '000000', 'bug 000000000', '缺陷 ００']) {
    const found = extractIds(title);
    assert.deepEqual(found.map(entry => entry.id), [], title);
  }
});
it('applies written digit lengths before stripping only nonzero leading zeros', () => {
  for (const [title, expected] of [
    ['bug 01', ['1']], ['bug 000000001', ['1']], ['bug 0000000001', []],
    ['0123 合成文档', []], ['00123 合成文档', ['123']],
    ['001234 合成文档', ['1234']], ['00000001 合成文档', []],
  ] as const) {
    const found = extractIds(title);
    assert.deepEqual(found.map(entry => entry.id), expected, title);
  }
});
