import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import manual, { canonicalSignature, parseAnchor, produceManualEntries } from './manual.ts';
import { commandCatalog } from './cases-commands.ts';
import { canonicalJson } from './util.ts';
import type { ManualCatalog, ManualResult, MarkdownModel } from './types.ts';
import { assertTotal, fixtureBytes, hostileInputs, internalWarnings, jsonDocument, markdown, markdownDocument, seeded, sliceBytes, utf8, xml } from '../testing/test-support.ts';

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
  it('places the blocks after an anchor at its command node and every other block at its section node', () => {
    assert.deepEqual(
      fromMarkdown.entries.map((entry) => [entry.data.form, entry.path, entry.fragments[0].selector]),
      [
        ['signature', '/commands/show/demo/status', 'h/基本配置/显示命令/**show%20demo%20status**%20*\\[pool_name\\]*'],
        ['text', '/manual/manual/引言', 'b/0/引言'],
        ['text', '/manual/manual/引言', 'b/1/引言'],
        ['text', '/manual/manual/基本配置', 'b/0/基本配置'],
        ['text', '/manual/manual/基本配置', 'b/1/基本配置'],
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
        ['text', '/manual/manual/基本配置/显示命令/其他说明', 'b/0/基本配置/显示命令/其他说明'],
        ['text', '/manual/manual/基本配置/显示命令/其他说明', 'b/1/基本配置/显示命令/其他说明'],
        ['text', '/manual/manual/基本配置/显示命令/其他说明', 'b/2/基本配置/显示命令/其他说明'],
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
        // The broken signature and the blocks after it describe no command: they hang at the manual root
        // (the text has no heading), the paragraph itself marked signature_rejected.
        ['text', '/manual/manual', '**demo acl d'],
        ['text', '/manual/manual', '该命令用于丢弃流量。'],
        ['text', '/manual/manual', '| 参数 | 说明 |\n'],
        ['signature', '/commands/demo/acl/log', 'demo acl log'],
        ['text', '/commands/demo/acl/log', '该命令用于记录日志。'],
        ['text', '/commands/demo/acl/log', '**Note** thi'],
      ],
    );
    assert.equal(result.entries[4].data.signature_rejected, true);
    assert.equal(result.entries[4].kind, 'behaviour');
    assert.deepEqual(result.unplaced, []);
    assert.ok(result.warnings.some((warning) => warning.includes('有 1 段写成命令签名的文字不能作为命令锚点')), result.warnings.join('\n'));
  });

  it('records the signature, its parameters and variants', () => {
    const route = signatures(fromMarkdown).find((entry) => entry.path === '/commands/demo/route/static');
    assert.deepEqual(route?.data, {
      words: ['demo', 'route', 'static'],
      form: 'signature',
      signature: '[no] demo route static <network> <netmask|prefix> <gateway> {permanent|temporary} [metric]',
      command_literals: ['demo route static', 'no demo route static'],
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

  it('hangs every non-anchor block at its section node and leaves nothing unplaced', () => {
    assert.deepEqual(fromMarkdown.unplaced, []);
    const hung = fromMarkdown.entries.filter((entry) => entry.path?.startsWith('/manual/'));
    assert.deepEqual(
      hung.map((entry) => [entry.kind, entry.path, entry.fragments[0].selector, entry.data.section]),
      [
        ['behaviour', '/manual/manual/引言', 'b/0/引言', '引言'],
        ['behaviour', '/manual/manual/引言', 'b/1/引言', '引言'],
        ['behaviour', '/manual/manual/基本配置', 'b/0/基本配置', '基本配置'],
        ['behaviour', '/manual/manual/基本配置', 'b/1/基本配置', '基本配置'],
        ['behaviour', '/manual/manual/基本配置/显示命令/其他说明', 'b/0/基本配置/显示命令/其他说明', '基本配置 / 显示命令 / 其他说明'],
        ['behaviour', '/manual/manual/基本配置/显示命令/其他说明', 'b/1/基本配置/显示命令/其他说明', '基本配置 / 显示命令 / 其他说明'],
        ['behaviour', '/manual/manual/基本配置/显示命令/其他说明', 'b/2/基本配置/显示命令/其他说明', '基本配置 / 显示命令 / 其他说明'],
      ],
    );
    // "**demo broken** *\<name*" is written as a signature but its brackets do not close: it hangs at its section,
    // marked signature_rejected, with a warning.
    const rejected = hung.find((entry) => entry.fragments[0].selector === 'b/1/基本配置/显示命令/其他说明');
    assert.equal(rejected?.data.signature_rejected, true);
    assert.deepEqual(fromMarkdown.warnings, ['有 1 段写成命令签名的文字不能作为命令锚点（括号不配对、转义多余或首词不是已知命令），这些段落及其后的块不归到前一条命令，挂在所在章节节点']);
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
        assert.ok(entry.path !== null && (entry.path.startsWith('/commands/') || entry.path.startsWith('/manual/')), text);
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

describe('manual section placement', () => {
  it('hangs the preamble at the manual namespace root and names the manual by options.name', () => {
    const result = produceManualEntries(markdown('前言一段，标题之前。\n\n# 章\n\n正文。\n'), null, { name: 'cli' });
    assert.deepEqual(
      result.entries.map((entry) => [entry.path, entry.data.section]),
      [
        ['/manual/cli', ''],
        ['/manual/cli/章', '章'],
      ],
    );
    assert.deepEqual(result.unplaced, []);
  });

  it('hangs blocks of repeated and empty headings by their ordinal segments', () => {
    const result = produceManualEntries(markdown('# 重复\n\n甲\n\n# 重复\n\n乙\n\n##\n\n丙\n'));
    assert.deepEqual(
      result.entries.map((entry) => [entry.statement, entry.path]),
      [
        ['甲', '/manual/manual/重复'],
        ['乙', '/manual/manual/重复[2]'],
        ['丙', '/manual/manual/重复[2]/[1]'],
      ],
    );
  });

  it('nests a skipped heading level under the nearest lower one, without a synthetic segment', () => {
    const result = produceManualEntries(markdown('# 章\n\n### 小节\n\n正文。\n'));
    assert.deepEqual(result.entries.map((entry) => entry.path), ['/manual/manual/章/小节']);
  });

  it('hangs a block at the manual root when its section path cannot be written, with a warning', () => {
    // A hand-written model whose block points at a section that does not exist.
    const model = { sections: [], blocks: [{ kind: 'paragraph', section: 3, index: 0, line: 0, lines: 1, text: '孤儿块。', selector: 'b/0' }] };
    const result = produceManualEntries(model as unknown as MarkdownModel);
    assert.deepEqual(result.entries.map((entry) => entry.path), ['/manual/manual']);
    assert.ok(result.warnings.some((warning) => warning.includes('1 个块指向不存在的章节')), result.warnings.join('\n'));
  });

  it('accepts the manual name through { model, name }', () => {
    const result = manual({ model: markdown('# 章\n\n正文。\n'), name: 'app' }) as ManualResult;
    assert.deepEqual(result.entries.map((entry) => entry.path), ['/manual/app/章']);
  });
});

describe('author-marked command literals', () => {
  it('records the literals the author marked (bold, backticks, quotes), as written and never resolved', () => {
    const result = produceManualEntries(
      markdown('# 概述\n\n成员池用 **demo pool add** 添加成员；先执行 “demo pool create”。也可见 `demo pool mode` 与『demo probe』。\n'),
    );
    assert.deepEqual(result.entries[0].path, '/manual/manual/概述');
    assert.deepEqual(result.entries[0].data.command_literals, ['demo pool add', 'demo pool create', 'demo pool mode', 'demo probe']);
  });

  it('records the command lines of code blocks (after the prompt) and the signature of a signature entry', () => {
    const result = produceManualEntries(markdown('**demo pool add** *\\<name\\>*\n\n示例：\n\n    Box(config)#demo pool add p1 192.0.2.5\n    成员添加成功\n'));
    const [signature, , code] = result.entries;
    assert.deepEqual(signature.data.command_literals, ['demo pool add']);
    assert.deepEqual(code.data.command_literals, ['demo pool add p1 192.0.2.5'], 'the output line is not a command line');
  });

  it('records nothing from prose without marks, from CJK spans, or from html blocks', () => {
    const result = produceManualEntries(markdown('# 章\n\n命令见上。\n\n**注意：** 慎用。\n\n<div>demo pool add</div>\n'));
    assert.ok(result.entries.every((entry) => entry.data.command_literals === undefined));
  });

  it('extracts literals in linear time over unmatched marks', () => {
    const text = `# 章\n\n${'“'.repeat(80_000)}\n`;
    const start = performance.now();
    const result = produceManualEntries(markdown(text));
    const ms = performance.now() - start;
    assert.ok(ms < 3000, `took ${ms} ms`);
    assert.ok(result.entries.every((entry) => entry.data.command_literals === undefined));
  });

  it('dedupes a repeated literal and caps one block’s literals at 100', () => {
    const mention = `${Array.from({ length: 120 }, (_, k) => `**demo c${k}**`).join('，')}，**demo c0** 再提一次。`;
    const result = produceManualEntries(markdown(`# 章\n\n${mention}\n`));
    const literals = result.entries[0].data.command_literals as string[];
    assert.equal(literals.length, 100);
    assert.equal(literals[0], 'demo c0');
    assert.equal(result.entries[0].data.command_literals_cut, true);
  });

  it('counts every literal in the drift total, past the per-entry cap, and keeps the list inside one stored warning', () => {
    const mention = Array.from({ length: 150 }, (_, k) => `**demo missing${k}**`).join('，');
    const catalog = commandCatalog(xml('<commands><scope type="global"><menu name="demo"><item name="present" help_string="p"><arguments></arguments></item></menu></scope></commands>')).catalog;
    const result = produceManualEntries(markdown(`# 章\n\n${mention}\n`), null, { catalog });
    const entry = result.entries[0];
    assert.equal((entry.data.command_literals as string[]).length, 100);
    assert.equal(entry.data.command_literals_cut, true);
    const drift = result.warnings.find((warning) => warning.includes('漂移候选'));
    assert.ok(drift, result.warnings.join('\n'));
    assert.ok(drift.includes('有 150 个命令字面'), drift);
    assert.ok(drift.endsWith(' 等'), drift);
    assert.ok(drift.length < 1000, `${drift.length} characters`);
  });
});

describe('placement against the build’s command tree', () => {
  const TREE =
    '<commands><scope type="global"><menu name="demo"><menu name="pool">' +
    '<item name="add" help_string="a"><arguments></arguments></item>' +
    '<item name="mode" help_string="m"><arguments></arguments></item></menu>' +
    '<menu name="route"><item name="static" help_string="s"><arguments></arguments></item></menu>' +
    '</menu><menu name="show"><menu name="demo"><item name="status" help_string="t"><arguments></arguments></item></menu></menu></scope></commands>';
  const catalog = commandCatalog(xml(TREE)).catalog;

  it('hangs a signature at its command node only when the command exists in the tree; its text blocks follow it', () => {
    const text = '**demo pool add** *\\<name\\>*\n\n该命令用于添加成员。\n\n**demo probe** *\\<name\\>*\n\n该命令用于探测。\n';
    const withTree = produceManualEntries(markdown(text), null, { catalog });
    assert.deepEqual(
      withTree.entries.map((entry) => [entry.data.form, entry.path]),
      [
        ['signature', '/commands/demo/pool/add'],
        ['text', '/commands/demo/pool/add'],
        ['signature', '/manual/manual'],
        ['text', '/manual/manual'],
      ],
    );
    const without = produceManualEntries(markdown(text));
    assert.ok(without.entries.every((entry) => entry.path?.startsWith('/commands/')), 'without a tree the literal decides (unchecked)');
  });

  it('hangs a variant signature at the common node of its variants when every variant exists', () => {
    const tree =
      '<commands><scope type="global"><menu name="demo"><menu name="pool"><item name="add" help_string="a"><arguments></arguments></item></menu>' +
      '<menu name="route"><item name="add" help_string="b"><arguments></arguments></item></menu></menu></scope></commands>';
    const variants = commandCatalog(xml(tree)).catalog;
    const result = produceManualEntries(markdown('**demo {pool\\|route} add** *\\<name\\>*\n\n该命令用于添加。\n'), null, { catalog: variants });
    assert.deepEqual(
      result.entries.map((entry) => [entry.data.form, entry.path]),
      [
        ['signature', '/commands/demo'],
        ['text', '/commands/demo'],
      ],
    );
    // One variant missing: the signature stays at its section node.
    const partial = commandCatalog(xml('<commands><scope type="global"><menu name="demo"><menu name="pool"><item name="add" help_string="a"><arguments></arguments></item></menu></menu></scope></commands>')).catalog;
    const missing = produceManualEntries(markdown('**demo {pool\\|route} add** *\\<name\\>*\n\n该命令用于添加。\n'), null, { catalog: partial });
    assert.deepEqual(
      missing.entries.map((entry) => [entry.data.form, entry.path]),
      [
        ['signature', '/manual/manual'],
        ['text', '/manual/manual'],
      ],
    );
  });

  it('hangs a signature at the key node when the tree models the alternatives as items below it', () => {
    const tree =
      '<commands><scope type="global"><menu name="demo"><menu name="acl"><menu name="permit">' +
      '<item name="tcp" help_string="t"><arguments></arguments></item>' +
      '<item name="udp" help_string="u"><arguments></arguments></item>' +
      '</menu></menu></menu></scope></commands>';
    const catalog = commandCatalog(xml(tree)).catalog;
    const result = produceManualEntries(markdown('**demo acl permit {tcp\\|udp}** *\\<source_ip\\>*\n\n该命令用于放行。\n'), null, { catalog });
    assert.deepEqual(result.entries[0].path, '/commands/demo/acl/permit');
    assert.ok(!result.warnings.some((warning) => warning.includes('漂移候选')), 'no false drift entry for a placed signature');
  });

  it('lists the literals the tree cannot resolve as drift candidates in the warnings', () => {
    const text = '**demo pool add** *\\<name\\>*\n\n该命令用于添加成员。\n\n**demo probe** *\\<name\\>*\n\n该命令用于探测，先执行 “demo pool create”。\n';
    const result = produceManualEntries(markdown(text), null, { catalog });
    const drift = result.warnings.find((warning) => warning.includes('漂移候选'));
    assert.ok(drift, result.warnings.join('\n'));
    assert.ok(drift.includes('有 2 个命令字面') && drift.includes('demo probe') && drift.includes('demo pool create'), drift);
    assert.ok(!drift.includes('demo pool add'), 'resolvable literals are not drift');
  });
});

describe('command tables split by row', () => {
  const catalog = commandCatalog(
    xml(
      '<commands><scope type="global"><menu name="demo"><menu name="pool">' +
        '<item name="add" help_string="a"><arguments></arguments></item>' +
        '<item name="mode" help_string="m"><arguments></arguments></item></menu></menu>' +
        '<menu name="show"><menu name="demo"><item name="status" help_string="t"><arguments></arguments></item></menu></menu></scope></commands>',
    ),
  ).catalog;

  const TABLE = [
    '# 命令一览',
    '',
    '| 命令 | 说明 |',
    '| --- | --- |',
    '| **demo pool add** *\\<name\\>* | 添加成员 |',
    '| **demo pool mode** *\\<name\\>* | 设置算法 |',
    '| **demo probe** *\\<name\\>* | 探测（本构建没有） |',
    '| **demo pool add** 与 **demo pool mode** | 配合使用 |',
    '| **demo pool add** 与 **show demo status** | 跨分支 |',
    '| **demo pool add** 与 **demo probe** | 一成一缺 |',
  ].join('\n');

  it('splits every signature row decided by the manual alone; the tree only chooses the path', () => {
    const result = produceManualEntries(markdown(TABLE), null, { catalog });
    const placed = result.entries.filter((entry) => entry.path?.startsWith('/commands/'));
    assert.deepEqual(
      placed.map((entry) => [entry.data.form, entry.path, entry.statement]),
      [
        ['signature', '/commands/demo/pool/add', 'demo pool add <name>'],
        ['text', '/commands/demo/pool/add', '添加成员'],
        ['signature', '/commands/demo/pool/mode', 'demo pool mode <name>'],
        ['text', '/commands/demo/pool/mode', '设置算法'],
        // Two commands of the tree whose nearest common ancestor is deeper than /commands: one row at the ancestor.
        ['text', '/commands/demo/pool', '**demo pool add** 与 **demo pool mode** | 配合使用'],
      ],
    );
    // The rows that stay at the section node: a missing command (still split out as a signature), a pair whose common
    // ancestor is /commands itself (not a placement), and a pair of which only one command exists.
    const sectioned = result.entries.filter((entry) => entry.path?.startsWith('/manual/'));
    assert.deepEqual(
      sectioned.map((entry) => [entry.data.form, entry.path, entry.statement]),
      [
        ['signature', '/manual/manual/命令一览', 'demo probe <name>'],
        ['text', '/manual/manual/命令一览', '探测（本构建没有）'],
        ['text', '/manual/manual/命令一览', '**demo pool add** 与 **show demo status** | 跨分支'],
        ['text', '/manual/manual/命令一览', '**demo pool add** 与 **demo probe** | 一成一缺'],
      ],
    );
  });

  it('splits the same rows with another tree or none: the entries’ content never depends on the tree (K01 R[1])', () => {
    const bare = produceManualEntries(markdown(TABLE));
    const other = produceManualEntries(markdown(TABLE), null, { catalog: commandCatalog(xml('<commands><scope type="global"><menu name="demo"><item name="probe" help_string="p"><arguments></arguments></item></menu></scope></commands>')).catalog });
    const content = (result: ManualResult) => result.entries.map((entry) => canonicalJson({ kind: entry.kind, statement: entry.statement, data: entry.data, applicability: entry.applicability }));
    assert.deepEqual(content(bare), content(other));
  });

  it('hangs a signature row of a table under an anchor at the section node when the command is missing', () => {
    const text = '**demo pool add** *\\<name\\>*\n\n| 命令 | 说明 |\n| --- | --- |\n| **demo probe** *\\<name\\>* | 本构建没有 |\n| name | 成员名 |\n';
    const result = produceManualEntries(markdown(text), null, { catalog });
    assert.deepEqual(
      result.entries.map((entry) => [entry.data.form, entry.path, entry.statement]),
      [
        ['signature', '/commands/demo/pool/add', 'demo pool add <name>'],
        ['signature', '/manual/manual', 'demo probe <name>'],
        ['text', '/manual/manual', '本构建没有'],
        ['text', '/commands/demo/pool/add', '| 命令 | 说明 |\n| name | 成员名 |'],
      ],
    );
  });

  it('never takes a bold span inside a prose cell for a signature (a mention is a literal only)', () => {
    const text = '| 命令 | 说明 |\n| --- | --- |\n| 成员名 | 先用 **demo pool create** 创建 |\n| **demo pool add** *\\<name\\>* | 添加成员 |\n';
    const result = produceManualEntries(markdown(`# 章\n\n${text}`), null, { catalog });
    assert.deepEqual(
      result.entries.map((entry) => [entry.data.form, entry.path, entry.statement]),
      [
        ['signature', '/commands/demo/pool/add', 'demo pool add <name>'],
        ['text', '/commands/demo/pool/add', '添加成员'],
        ['text', '/manual/manual/章', '| 命令 | 说明 |\n| 成员名 | 先用 **demo pool create** 创建 |'],
      ],
    );
    const rest = result.entries[2];
    assert.deepEqual(rest.data.command_literals, ['demo pool create'], 'the mention is recorded as a literal');
  });

  it('cites the row lines of the table block, locatable by the parser', () => {
    const document = markdownDocument(TABLE);
    const result = produceManualEntries(document.model as MarkdownModel, null, { catalog });
    const lines = (selector: string): string[] => (document.locate(selector)?.text ?? '').split('\n');
    for (const entry of result.entries) {
      for (const fragment of entry.fragments) {
        const located = document.locate(fragment.selector);
        assert.ok(located, fragment.selector);
        if (fragment.range === undefined) continue;
        const text = sliceBytes(located.text, fragment.range);
        assert.ok(lines(fragment.selector).includes(text), `${entry.path}: ${text}`);
      }
    }
  });

  it('never splits a table that is not a pipe table, or a pipe table without a resolvable signature row', () => {
    const grid = ['# 章', '', '+-----+-----+', '| a   | b   |', '+-----+-----+', '| **demo pool add** | x |', '+-----+-----+'].join('\n');
    const fromGrid = produceManualEntries(markdown(grid), null, { catalog });
    assert.deepEqual(fromGrid.entries.map((entry) => [entry.path, entry.data.block]), [['/manual/manual/章', 'table']]);
    const plain = ['# 章', '', '| 命令 | 说明 |', '| --- | --- |', '| 添加成员 | 用池命令 |'].join('\n');
    const fromPlain = produceManualEntries(markdown(plain), null, { catalog });
    assert.deepEqual(fromPlain.entries.map((entry) => [entry.path, entry.data.block]), [['/manual/manual/章', 'table']]);
  });
});

describe('tree-independent content', () => {
  const TEXT = [
    '# 概述',
    '',
    '本手册为合成。命令字面见 `demo pool add`。',
    '',
    '## 命令',
    '',
    '**demo pool add** *\\<name\\>*',
    '',
    '该命令用于添加成员。',
    '',
    '**demo probe** *\\<name\\>*',
    '',
    '该命令用于探测，仅 hg-k 平台支持。',
    '',
    '| 命令 | 说明 |',
    '| --- | --- |',
    '| **demo pool add** *\\<name\\>* | 添加成员 |',
    '| **demo route static** *\\<net\\>* | 静态路由 |',
    '| **demo pool add** 与 **demo route static** | 配合 |',
  ].join('\n');
  const TREE_A = '<commands><scope type="global"><menu name="demo"><menu name="pool"><item name="add" help_string="a"><arguments></arguments></item></menu><menu name="route"><item name="static" help_string="s"><arguments></arguments></item></menu></menu></scope></commands>';
  const TREE_B = '<commands><scope type="global"><menu name="demo"><menu name="route"><item name="static" help_string="s"><arguments></arguments></item></menu></menu></scope></commands>';

  it('keeps every entry’s digest-bearing content identical across trees; only placement moves (K01 R[1])', () => {
    const model = markdown(TEXT);
    const a = produceManualEntries(model, null, { catalog: commandCatalog(xml(TREE_A)).catalog });
    const b = produceManualEntries(model, null, { catalog: commandCatalog(xml(TREE_B)).catalog });
    // What entryDigest covers (hub/knowledge/digest.ts): kind, statement, data, applicability — never the tree.
    const content = (result: ManualResult) => result.entries.map((entry) => canonicalJson({ kind: entry.kind, statement: entry.statement, data: entry.data, applicability: entry.applicability }));
    assert.deepEqual(content(a), content(b));
    const pathsA = a.entries.map((entry) => entry.path);
    const pathsB = b.entries.map((entry) => entry.path);
    const moved = pathsA.flatMap((path, k) => (path === pathsB[k] ? [] : [k]));
    assert.deepEqual(moved, [1, 2, 5, 6, 9], 'exactly the entries naming the removed command move');
    assert.equal(pathsA[1], '/commands/demo/pool/add');
    assert.equal(pathsB[1], '/manual/manual/概述/命令');
    assert.equal(pathsA[9], '/commands/demo', 'the two-command row at the common ancestor');
    assert.equal(pathsB[9], '/manual/manual/概述/命令');
    // Determinism: the same input twice gives byte-identical entries.
    assert.equal(canonicalJson(a.entries), canonicalJson(produceManualEntries(model, null, { catalog: commandCatalog(xml(TREE_A)).catalog }).entries));
  });
});

describe('applicability from explicit conditions', () => {
  it('reads platforms and models from the sentences written for them; builds stay undeclared on manual entries', () => {
    const result = produceManualEntries(
      markdown(
        [
          '# 平台差异',
          '',
          '仅 hg-k 平台支持本节内容。',
          '',
          '## 会话保持',
          '',
          '适用于 X9000 系列机型。',
          '',
          '该功能仅适用于 hg-k、zx-neokylin 平台，自 Rel_APV_10_6_1_8 起可用。',
          '',
          '适用于 Rel_APV_10_6_1_8 和 Rel_APV_10_6_1_9 构建的命令见下。',
        ].join('\n'),
      ),
    );
    const [own, model, mixed, builds] = result.entries;
    assert.deepEqual(own.applicability, { platforms: ['hg-k'] });
    assert.deepEqual(model.applicability, { models: ['X9000'] });
    assert.deepEqual(mixed.applicability, { platforms: ['hg-k', 'zx-neokylin'] }, 'a start build ("自…起") is not a manual-entry condition');
    assert.equal(builds.applicability, null, 'which builds use a manual is said by the composition, never by the entry (K02 F[6])');
  });

  it('counts a condition only for the entry whose own text states it (no positional inheritance until the owner decides)', () => {
    const result = produceManualEntries(markdown('## 仅 hg-k 平台支持\n\n适用于 ft-kylinv10 平台的功能。\n\n本节的另一段。\n\n### 小节\n\n子节的一段。\n'));
    const [own, other, sub] = result.entries;
    assert.deepEqual(own.applicability, { platforms: ['ft-kylinv10'] });
    assert.equal(other.applicability, null, 'a sibling block states nothing');
    assert.equal(sub.applicability, null, 'a subsection states nothing');
  });

  it('does not read a condition of a bare heading (a heading is no entry’s own text)', () => {
    const result = produceManualEntries(markdown('## 仅 hg-k 平台支持\n\n**demo pool add** *\\<name\\>*\n\n该命令用于添加成员。\n'));
    assert.ok(result.entries.every((entry) => entry.applicability === null));
  });

  it('keeps a command block’s condition on its own entry and lets nothing leak to a sibling command', () => {
    const result = produceManualEntries(markdown('## 命令\n\n**demo pool add** *\\<name\\>*\n\n该命令仅适用于 hg-k 平台。\n\n**demo pool mode** *\\<name\\>*\n\n该命令用于设置算法。\n'));
    const [add, addText, mode, modeText] = result.entries;
    assert.equal(add.applicability, null, 'the opening ended at the first anchor');
    assert.deepEqual(addText.applicability, { platforms: ['hg-k'] });
    assert.equal(mode.applicability, null);
    assert.equal(modeText.applicability, null, 'no leak to a sibling command');
  });

  it('never reads a negation, a vague or deictic word, an exception or a partial list as a condition', () => {
    const sentences = [
      '不适用于 hg-k 平台。',
      '不再适用于 hg-k 平台。',
      '无法适用于 hg-k 平台。',
      '不能适用于 hg-k 平台。',
      '并非适用于 hg-k 平台。',
      '仅 hg-k 平台不支持。',
      '不仅 hg-k 平台支持，ft-kylinv10 平台也支持。',
      '适用于 hg-k 平台以外的所有平台。',
      '适用于 hg-k 平台之外的环境。',
      '部分平台支持本功能。',
      '适用于大多数平台。',
      '适用于所有硬件平台。',
      '适用于部分硬件平台。',
      '适用于该平台。',
      '适用于上述平台。',
      '适用于全部平台。',
      '仅特定平台支持。',
      '仅少量平台支持。',
      '适用于以下平台：hg-k、ft-kylinv10。',
      '适用于 hg-k 和其他平台。',
      '适用于非虚拟平台。',
      '没有某部件时不适用。',
      '适用于 APV 系列。',
      '适用于 NSAE、X9000 系列。',
    ];
    for (const sentence of sentences) {
      const result = produceManualEntries(markdown(`# 章\n\n${sentence}\n`));
      assert.ok(result.entries.every((entry) => entry.applicability === null), sentence);
    }
    // And the positive forms still read: every item of a coordinated list, from the closed set.
    const positive = produceManualEntries(markdown('# 章\n\n适用于 hg-k 平台和 ft-kylinv10 平台。\n\n仅虚拟平台支持。\n\n适用于 X9000、X8000 机型。\n'));
    assert.deepEqual(positive.entries[0].applicability, { platforms: ['ft-kylinv10', 'hg-k'] });
    assert.deepEqual(positive.entries[1].applicability, { platforms: ['虚拟'] });
    assert.deepEqual(positive.entries[2].applicability, { models: ['X8000', 'X9000'] });
  });

  it('leaves applicability null when nothing declares a condition', () => {
    assert.ok(fromMarkdown.entries.every((entry) => entry.applicability === null));
  });
});
