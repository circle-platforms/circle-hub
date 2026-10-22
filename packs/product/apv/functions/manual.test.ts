import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import manual, { canonicalSignature, parseAnchor, produceManualEntries } from './manual.ts';
import type { ManualCatalog, ManualResult } from './types.ts';
import { assertTotal, fixtureBytes, hostileInputs, internalWarnings, jsonDocument, markdown, markdownDocument, seeded, utf8 } from '../testing/test-support.ts';

const md = markdownDocument(fixtureBytes('manual.md'));
const fromMarkdown = produceManualEntries(md.model);
const catalogDocument = jsonDocument(fixtureBytes('manual-catalog.json'));
const fromCatalog = produceManualEntries(catalogDocument.model as unknown as ManualCatalog);

const signatures = (result: ManualResult) => result.entries.filter((entry) => entry.data.form === 'signature');

describe('command anchors in markdown', () => {
  it('reads the bold head and the italic parameters', () => {
    assert.deepEqual(parseAnchor('**demo login** *\\<account_name\\> \\<secret\\>*'), {
      words: ['demo', 'login'],
      variants: null,
      signature: 'demo login <account_name> <secret>',
      params: [
        { name: 'account_name', required: true },
        { name: 'secret', required: true },
      ],
    });
    assert.deepEqual(parseAnchor('**?**')?.words, ['?']);
  });

  it('expands alternatives into variants and keys the entry by the words before them', () => {
    const anchor = parseAnchor('**demo mode {on\\|off}**');
    assert.deepEqual([anchor?.words, anchor?.variants], [['demo', 'mode'], [['demo', 'mode', 'on'], ['demo', 'mode', 'off']]]);
    const leading = parseAnchor('**\\[show\\|clear\\] demo counter**');
    assert.deepEqual([leading?.words, leading?.variants], [['demo', 'counter'], [['demo', 'counter'], ['show', 'demo', 'counter'], ['clear', 'demo', 'counter']]]);
  });

  it('reads alternatives of several words inside a head group', () => {
    const anchor = parseAnchor('**demo acl permit {tcp\\|udp\\|probe hello\\|probe bye}** *\\<source_ip\\> \\<source_mask\\>*');
    assert.deepEqual(anchor?.words, ['demo', 'acl', 'permit']);
    assert.deepEqual(anchor?.variants, [
      ['demo', 'acl', 'permit', 'tcp'],
      ['demo', 'acl', 'permit', 'udp'],
      ['demo', 'acl', 'permit', 'probe', 'hello'],
      ['demo', 'acl', 'permit', 'probe', 'bye'],
    ]);
    assert.deepEqual(parseAnchor('**\\[no ip\\|clear\\] demo route**')?.variants, [['demo', 'route'], ['no', 'ip', 'demo', 'route'], ['clear', 'demo', 'route']]);
    for (const text of ['**demo acl {esp\\|\\|ah}**', '**demo acl {esp\\| }**', '**demo acl {icmp echo-“reply”}**']) assert.equal(parseAnchor(text), null, text);
  });

  it('reads anchors written in several emphasis spans', () => {
    const anchor = parseAnchor('**demo probe** *\\<name\\>* **{tcp\\|udp}** *\\[\\<port\\>\\]\\[\\<timeout\\>\\]*');
    assert.deepEqual(anchor?.params, [
      { name: 'name', required: true },
      { name: 'tcp|udp', required: true },
      { name: 'port', required: false },
      { name: 'timeout', required: false },
    ]);
    assert.deepEqual(parseAnchor('**demo route** **static** *\\[metric\\]*')?.words, ['demo', 'route', 'static']);
    assert.deepEqual(parseAnchor('**demo show baseline *\\[regex\\]***')?.params, [{ name: 'regex', required: false }]);
    assert.deepEqual(parseAnchor('**demo mode {on\\|** **off}**')?.variants, [['demo', 'mode', 'on'], ['demo', 'mode', 'off']]);
  });

  it('never takes prose, labels or broken syntax for an anchor', () => {
    for (const text of [
      '**enable** 命令用于进入 Enable 级别。',
      '**注意：** 修改路由会立即生效。',
      '**Note** this is prose',
      '命令“**enable**”用于进入。',
      '**demo broken** *\\<name*',
      '**demo** \\_\\<x\\>',
      '*demo pool add*',
      '**demo pool add**\n第二行',
      '**<x>**',
      '**',
      '',
    ]) {
      assert.equal(parseAnchor(text), null, text);
    }
  });

  it('filters anchors by the known first words when heads are given', () => {
    const heads = new Set(['demo']);
    assert.ok(parseAnchor('**demo pool add**', heads));
    assert.equal(parseAnchor('**other enable**', heads), null);
    assert.ok(parseAnchor('**\\[show\\|demo\\] counter**', heads), 'a variant may carry the known first word');
  });

  it('writes the canonical signature without emphasis and escapes', () => {
    assert.equal(canonicalSignature('**demo bind** *\\<if\\>   \\<ip\\>* {mask\\|len} \\[shared\\]'), 'demo bind <if> <ip> {mask|len} [shared]');
  });
});

describe('entries from the converted manual', () => {
  it('places the blocks after an anchor at its command node', () => {
    assert.deepEqual(
      fromMarkdown.entries.map((entry) => [entry.data.form, entry.path, entry.fragments[0].selector]),
      [
        ['signature', '/commands/show/demo/status', 'h/基本配置/显示命令/**show%20demo%20status**%20*\\[pool_name\\]*'],
        ['signature', '/commands/?', 'b/2/基本配置'],
        ['text', '/commands/?', 'b/3/基本配置'],
        ['signature', '/commands/demo/pool/add', 'b/4/基本配置'],
        ['text', '/commands/demo/pool/add', 'b/5/基本配置'],
        ['text', '/commands/demo/pool/add', 'b/6/基本配置'],
        ['text', '/commands/demo/pool/add', 'b/7/基本配置'],
        ['signature', '/commands/demo/pool/mode', 'b/8/基本配置'],
        ['text', '/commands/demo/pool/mode', 'b/9/基本配置'],
        ['signature', '/commands/demo/route/static', 'b/10/基本配置'],
        ['text', '/commands/demo/route/static', 'b/11/基本配置'],
        ['text', '/commands/demo/route/static', 'b/12/基本配置'],
        ['text', '/commands/demo/route/static', 'b/13/基本配置'],
        ['text', '/commands/demo/route/static', 'b/14/基本配置'],
        ['signature', '/commands/demo/probe', 'b/15/基本配置'],
        ['text', '/commands/demo/probe', 'b/16/基本配置'],
        ['signature', '/commands/enable', 'b/17/基本配置'],
        ['text', '/commands/enable', 'b/18/基本配置'],
        ['text', '/commands/show/demo/status', 'b/0/基本配置/显示命令/**show%20demo%20status**%20*\\[pool_name\\]*'],
        ['text', '/commands/show/demo/status', 'b/2/基本配置/显示命令/**show%20demo%20status**%20*\\[pool_name\\]*'],
        ['signature', '/commands/demo/pool/add', 'b/4/基本配置/显示命令/其他说明'],
        ['text', '/commands/demo/pool/add', 'b/5/基本配置/显示命令/其他说明'],
      ],
    );
    // K02 R[3]: a signature is a definition, the text under a command a behaviour; the finer form is data.
    assert.ok(fromMarkdown.entries.every((entry) => entry.kind === (entry.data.form === 'signature' ? 'definition' : 'behaviour')));
  });

  it('ends a command at a paragraph written as a signature that does not parse', () => {
    const text = [
      '**demo acl deny {tcp\\|udp}** *\\<source_ip\\>*',
      '该命令用于拒绝流量。',
      '**demo acl permit {gre\\|probe hello}** *\\<source_ip\\>*',
      '该命令用于放行流量。',
      '**demo acl drop \\\\tcp\\|udp}** *\\<source_ip\\>*',
      '该命令用于丢弃流量。',
      '| 参数 | 说明 |\n|---|---|\n| source_ip | 源地址 |',
      '**demo acl log** *\\<level\\>*',
      '该命令用于记录日志。',
      '**Note** this paragraph is prose about the command above.',
    ].join('\n\n');
    const result = produceManualEntries(markdown(text));
    assert.deepEqual(
      result.entries.map((entry) => [entry.data.form, entry.path, entry.statement.slice(0, 12)]),
      [
        ['signature', '/commands/demo/acl/deny', 'demo acl den'],
        ['text', '/commands/demo/acl/deny', '该命令用于拒绝流量。'],
        ['signature', '/commands/demo/acl/permit', 'demo acl per'],
        ['text', '/commands/demo/acl/permit', '该命令用于放行流量。'],
        ['signature', '/commands/demo/acl/log', 'demo acl log'],
        ['text', '/commands/demo/acl/log', '该命令用于记录日志。'],
        ['text', '/commands/demo/acl/log', '**Note** thi'],
      ],
    );
    assert.deepEqual(result.unplaced.map((item) => [item.kind, item.text.slice(0, 16)]), [
      ['definition', '**demo acl drop '],
      ['behaviour', '该命令用于丢弃流量。'],
      ['behaviour', '| 参数 | 说明 |\n|---'],
    ]);
    assert.ok(result.warnings.some((warning) => warning.includes('有 1 段写成命令签名的文字不能作为命令锚点')), result.warnings.join('\n'));
  });

  it('records the signature, its parameters and variants', () => {
    const route = signatures(fromMarkdown).find((entry) => entry.path === '/commands/demo/route/static');
    assert.deepEqual(route?.data, {
      words: ['demo', 'route', 'static'],
      form: 'signature',
      signature: '[no] demo route static <network> <netmask|prefix> <gateway> {permanent|temporary} [metric]',
      params: [
        { name: 'network', required: true },
        { name: 'netmask|prefix', required: true },
        { name: 'gateway', required: true },
        { name: 'permanent|temporary', required: true },
        { name: 'metric', required: false },
      ],
      variants: [['demo', 'route', 'static'], ['no', 'demo', 'route', 'static']],
    });
    assert.equal(route?.statement, route?.data.signature);
  });

  it('returns what it cannot place, citable by selector', () => {
    assert.deepEqual(
      fromMarkdown.unplaced.map((item) => [item.fragment.selector, item.section, item.kind]),
      [
        ['b/0/引言', '引言', 'behaviour'],
        ['b/0/基本配置', '基本配置', 'behaviour'],
        ['b/1/基本配置', '基本配置', 'behaviour'],
        ['b/0/基本配置/显示命令/其他说明', '基本配置 / 显示命令 / 其他说明', 'behaviour'],
        ['b/1/基本配置/显示命令/其他说明', '基本配置 / 显示命令 / 其他说明', 'definition'],
        ['b/2/基本配置/显示命令/其他说明', '基本配置 / 显示命令 / 其他说明', 'behaviour'],
      ],
    );
    // "**demo broken** *\<name*" is written as a signature but its brackets do not close.
    assert.deepEqual(fromMarkdown.warnings, ['有 1 段写成命令签名的文字不能作为命令锚点（括号不配对、转义多余或首词不是已知命令），这些段落及其后的块不归到前一条命令，留给归类']);
  });

  it('gives fragments the markdown@1 document locates, with the same text', () => {
    for (const entry of fromMarkdown.entries) {
      const located = md.locate(entry.fragments[0].selector);
      assert.ok(located, entry.fragments[0].selector);
      if (entry.data.form === 'text') assert.equal(located.text.trim(), entry.statement);
    }
    for (const item of fromMarkdown.unplaced) assert.equal(md.locate(item.fragment.selector)?.text.trim(), item.text);
  });

  it('keeps NUL bytes out of the entries', () => {
    const result = produceManualEntries(markdown(utf8('**demo nul**\n\n说明\u0000文字。\n')));
    assert.deepEqual(result.entries.map((entry) => entry.statement), ['demo nul', '说明文字。']);
  });

  it('accepts known heads through { model, heads }', () => {
    const result = manual({ model: md.model, heads: ['demo', 'show'] }) as ManualResult;
    const paths = signatures(result).map((entry) => entry.path);
    assert.ok(!paths.includes('/commands/?') && !paths.includes('/commands/enable'));
    assert.ok(paths.includes('/commands/demo/pool/add') && paths.includes('/commands/show/demo/status'));
  });
});

describe('entries from the manual command catalog', () => {
  it('reads signatures, value domains and worked examples', () => {
    assert.deepEqual(
      fromCatalog.entries.map((entry) => [entry.data.form, entry.path, entry.statement, entry.fragments[0].selector]),
      [
        ['signature', '/commands/help', 'help', 'p/signatures/0/signature_verbatim'],
        ['signature', '/commands/demo/pool/add', 'demo pool add <pool_name> <member_ip> [weight]', 'p/signatures/1/signature_verbatim'],
        ['signature', '/commands/demo/mode', 'demo mode {on|off}', 'p/signatures/2/signature_verbatim'],
        ['signature', '/commands/demo/route/static', 'demo route static <network> <gateway>', 'p/signatures/4/signature_verbatim'],
        ['text', '/commands/demo/pool/add', 'pool_name: 该参数指定成员池的名称。', 'p/value_domains/0/desc'],
        ['text', '/commands/demo/mode', 'mode: 可选。该参数指定调度算法，取值必须为： rr：轮询。 lc：最少连接。 默认值为“rr”。', 'p/value_domains/1/desc'],
        ['text', '/commands/demo/pool/add', 'Box(config)#demo pool add p1 192.0.2.5 20\nBox(config)#demo pool add p1 192.0.2.6', 'p/worked_examples/0/lines'],
        ['text', '/commands/help', 'Box>help', 'p/worked_examples/1/lines'],
      ],
    );
    assert.ok(fromCatalog.entries.every((entry) => entry.kind === (entry.data.form === 'signature' ? 'definition' : 'behaviour')));
    assert.deepEqual(fromCatalog.entries[2].data.variants, [['demo', 'mode', 'on'], ['demo', 'mode', 'off']]);
    assert.deepEqual(fromCatalog.entries[3].data.params, [
      { name: 'network', required: true },
      { name: 'gateway', required: true },
    ]);
    assert.deepEqual(fromCatalog.entries[5].data.values, ['rr', 'lc']);
  });

  it('returns unmatched value domains and examples unplaced, and skips malformed signatures', () => {
    assert.deepEqual(
      fromCatalog.unplaced.map((item) => [item.kind, item.section, item.fragment.selector]),
      [
        ['behaviour', 'demo unknown', 'p/value_domains/2'],
        ['behaviour', '', 'p/worked_examples/2'],
      ],
    );
    assert.deepEqual(fromCatalog.warnings, ['有 1 条签名格式不对或没有命令词，已跳过']);
  });

  it('files example lines listed as signatures under the command they exemplify, never at a synthetic path', () => {
    const catalog = {
      schema: 'ist.manual-command-catalog',
      signatures: [
        { head_tokens: ['demo', 'policy', 'agent'], params: [{ name: 'agent', required: true }], signature_verbatim: '**demo policy agent** *\\<agent\\>*' },
        { head_tokens: ['demo', 'policy', 'agent', '"Demo', '1.0"', 'css'], params: [], signature_verbatim: '**demo policy agent "Demo 1.0" css**' },
        { head_tokens: ['demo', 'disk', 'warn'], params: [{ name: 'high', required: true }, { name: 'low', required: true }], signature_verbatim: '**demo disk warn** *\\<high\\> \\<low\\>*' },
        { head_tokens: ['demo', 'disk', 'warn', '80', '60'], params: [], signature_verbatim: '**demo disk warn 80 60**' },
        { head_tokens: ['demo', 'limit', 'get', '100'], params: [], signature_verbatim: '**demo limit get 100**' },
        { head_tokens: ['demo', 'limit'], params: [{ name: 'method', required: true }], signature_verbatim: '**demo limit** *\\<method\\> \\<value\\>*' },
        { head_tokens: ['other', '“x_server”'], params: [], signature_verbatim: '**other “x_server”**' },
        { head_tokens: ['demo', 'v6', '6'], params: [], signature_verbatim: '**demo v6 6**' },
      ],
    } as unknown as ManualCatalog;
    const result = produceManualEntries(catalog);
    assert.deepEqual(
      result.entries.map((entry) => [entry.data.form, entry.path, entry.statement, entry.data.example ?? false]),
      [
        ['signature', '/commands/demo/policy/agent', 'demo policy agent <agent>', false],
        ['text', '/commands/demo/policy/agent', 'demo policy agent "Demo 1.0" css', true],
        ['signature', '/commands/demo/disk/warn', 'demo disk warn <high> <low>', false],
        ['text', '/commands/demo/disk/warn', 'demo disk warn 80 60', true],
        ['text', '/commands/demo/limit', 'demo limit get 100', true],
        ['signature', '/commands/demo/limit', 'demo limit <method> <value>', false],
        ['signature', '/commands/demo/v6/6', 'demo v6 6', false],
      ],
    );
    assert.deepEqual(result.unplaced.map((item) => [item.kind, item.fragment.selector, item.text]), [['behaviour', 'p/signatures/6/signature_verbatim', 'other “x_server”']]);
    for (const entry of result.entries) assert.ok(!/["“”]/.test(entry.path ?? ''), entry.path ?? '');
  });

  it('gives fragments the json@1 document locates', () => {
    for (const entry of fromCatalog.entries) assert.ok(catalogDocument.locate(entry.fragments[0].selector), entry.fragments[0].selector);
    for (const item of fromCatalog.unplaced) assert.ok(catalogDocument.locate(item.fragment.selector), item.fragment.selector);
    const verbatim = catalogDocument.locate('p/signatures/1/signature_verbatim');
    assert.equal(canonicalSignature(verbatim?.text ?? ''), fromCatalog.entries[1].statement);
  });

  it('recognises the catalog by the schema in identity too', () => {
    const result = produceManualEntries({ identity: { schema: 'ist.manual-command-catalog' }, signatures: [{ head_tokens: ['x'], params: [], signature_verbatim: '**x**' }] } as unknown as ManualCatalog);
    assert.equal(result.entries.length, 1);
    const unknown = produceManualEntries({ schema: 'other', signatures: [] } as unknown as ManualCatalog);
    assert.match(unknown.warnings[0], /既不是 markdown@1 模型/);
  });
});

describe('manual on bad input', () => {
  it('is total and deterministic on hostile and random inputs', () => {
    for (const [k, input] of hostileInputs().entries()) assertTotal(manual, input, `hostile ${k}`);
    const random = seeded(29);
    const pieces = ['**demo a**', ' *\\<x\\>*', ' **{p\\|q}**', '\\[', '\\]', '*', '**', '中文', '\n\n', '# 标题\n\n', '## **demo h**\n\n', '- 项\n', '> 引用\n', '\u0000', '<!-- -->\n\n', '|a|b|\n|-|-|\n'];
    for (let i = 0; i < 300; i++) {
      const text = Array.from({ length: random.int(12) }, () => random.pick(pieces)).join('');
      const result = assertTotal(manual, markdown(text), text) as ManualResult;
      assert.deepEqual(internalWarnings(result), []);
      for (const entry of result.entries) {
        assert.ok(entry.path?.startsWith('/commands/'), text);
        assert.ok(!entry.statement.includes('\u0000'));
      }
    }
  });

  it('reads a large manual quickly', () => {
    const parts: string[] = ['# 章\n\n'];
    for (let k = 0; k < 8000; k++) parts.push(`**demo c${k} set** *\\<name\\> \\[value\\]*\n\n该命令用于第 ${k} 项设置。\n\n| a | b |\n|---|---|\n| name | 名称 |\n\n`);
    const model = markdown(parts.join(''));
    const start = performance.now();
    const result = produceManualEntries(model);
    const ms = performance.now() - start;
    assert.equal(signatures(result).length, 8000);
    assert.equal(result.entries.length, 24000);
    assert.ok(ms < 3000, `took ${ms} ms`);
  });
});
