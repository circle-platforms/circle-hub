import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import manual, { canonicalSignature, parseAnchor, produceManualEntries } from './manual.ts';
import {manualRelations} from '../testing/relations.ts';
import { commandCatalog } from './cases-commands.ts';
import { canonicalJson } from './util.ts';
import type { ManualCatalog, ManualResult, MarkdownModel } from './types.ts';
import { assertTotal, fixtureBytes, hostileInputs, internalWarnings, jsonDocument, markdown, markdownDocument, seeded, sliceBytes, utf8 } from '../testing/test-support.ts';

import {STRICT_MANUAL_CATALOG,placementXml as xml} from '../testing/strict-command-fixture.ts';
const md = markdownDocument(fixtureBytes('manual.md'));
const fromMarkdown = produceManualEntries(md.model,null,{catalog:STRICT_MANUAL_CATALOG});
const catalogDocument = jsonDocument(fixtureBytes('manual-catalog-v2.json'));
const fromCatalog = produceManualEntries(catalogDocument.model as unknown as ManualCatalog,null,{catalog:STRICT_MANUAL_CATALOG});

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
    for (const text of ['**demo acl {esp\\|\\|ah}**', '**demo acl {esp\\| }**']) assert.equal(parseAnchor(text), null, text);
    assert.deepEqual(parseAnchor('**demo acl {icmp echo-“reply”}**')?.words,['demo','acl','icmp','echo-“reply”']);
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

  it('parses candidate structure without treating a first-word list as command identity', () => {
    const heads = new Set(['demo']);
    assert.ok(parseAnchor('**demo pool add**', heads));
    assert.deepEqual(parseAnchor('**other enable**',heads),parseAnchor('**other enable**'));
    assert.ok(produceManualEntries(markdown('**other enable**'),null,{catalog:STRICT_MANUAL_CATALOG}).entries.every(entry=>entry.data.form!=='signature'));
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
        ['text','/manual/manual/合成适用范围：装有%20Card-A%20时','b/0/合成适用范围：装有%20Card-A%20时'],
        ['text','/manual/manual/合成适用范围：装有%20Card-A%20时/合成子节','b/0/合成适用范围：装有%20Card-A%20时/合成子节'],
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
    const result = produceManualEntries(markdown(text),null,{catalog:STRICT_MANUAL_CATALOG});
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
    // Since the applicability and section work landed, every entry also carries its section path and the
    // applicability state (declared from the source structure, unjudged until a verified contribution); the [no]
    // group contributes its own literal alternative.
    const state = (route?.data as { applicability_state: unknown }).applicability_state;
    assert.equal((state as { schema: string }).schema, 'applicability-state@1');
    assert.equal((state as { judgment_status: string }).judgment_status, 'unjudged');
    assert.deepEqual((route?.data as { section_path: string[] }).section_path, ['基本配置']);
    assert.deepEqual((route?.data as Record<string, unknown>), {
      words: ['demo', 'route', 'static'],
      form: 'signature',
      signature: '[no] demo route static <network> <netmask|prefix> <gateway> {permanent|temporary} [metric]',
      signature_literals: [{ primary: 'demo route static', alternatives: ['demo route static', 'no demo route static'] }],
      params: [
        { name: 'network', required: true },
        { name: 'netmask|prefix', required: true },
        { name: 'gateway', required: true },
        { name: 'permanent|temporary', required: true },
        { name: 'metric', required: false },
      ],
      variants: [['demo', 'route', 'static'], ['no', 'demo', 'route', 'static']],
      section_path: ['基本配置'],
      applicability_state: state,
    });
    assert.equal(route?.statement, route?.data.signature);
  });

  it('hangs every non-anchor block at its section node and leaves nothing unplaced', () => {
    assert.deepEqual(fromMarkdown.unplaced, []);
    const hung = fromMarkdown.entries.filter((entry) => entry.path?.startsWith('/manual/'));
    assert.deepEqual(
      hung.map((entry) => [entry.kind, entry.path, entry.fragments[0].selector]),
      [
        ['behaviour', '/manual/manual/引言', 'b/0/引言'],
        ['behaviour', '/manual/manual/引言', 'b/1/引言'],
        ['behaviour', '/manual/manual/基本配置', 'b/0/基本配置'],
        ['behaviour', '/manual/manual/基本配置', 'b/1/基本配置'],
        ['behaviour', '/manual/manual/基本配置/显示命令/其他说明', 'b/0/基本配置/显示命令/其他说明'],
        ['behaviour', '/manual/manual/基本配置/显示命令/其他说明', 'b/1/基本配置/显示命令/其他说明'],
        ['behaviour', '/manual/manual/基本配置/显示命令/其他说明', 'b/2/基本配置/显示命令/其他说明'],
        ['behaviour','/manual/manual/合成适用范围：装有%20Card-A%20时','b/0/合成适用范围：装有%20Card-A%20时'],
        ['behaviour','/manual/manual/合成适用范围：装有%20Card-A%20时/合成子节','b/0/合成适用范围：装有%20Card-A%20时/合成子节'],
      ],
    );
    // "**demo broken** *\<name*" is written as a signature but its brackets do not close: it hangs at its section,
    // marked signature_rejected, with a warning.
    const rejected = hung.find((entry) => entry.fragments[0].selector === 'b/1/基本配置/显示命令/其他说明');
    assert.equal(rejected?.data.signature_rejected, true);
    assert.deepEqual(fromMarkdown.warnings.filter(warning=>!warning.startsWith('适用条件')), ['有 1 段写成命令签名的文字不能作为命令锚点（括号不配对、转义多余、首词不是已知命令或斜杠头），这些段落及其后的块不归到前一条命令，挂在所在章节节点']);
  });

  it('gives fragments the markdown@1 document locates, with the same text', () => {
    const decoder = new TextDecoder();
    for (const entry of fromMarkdown.entries) {
      // A shared table entry cites one fragment per line (the range picks the line out of the block's text).
      const located = entry.fragments
        .filter((fragment,index)=>index===0||!fragment.applicability)
        .map((fragment) => {
          const text = md.locate(fragment.selector)?.text ?? '';
          const range = (fragment as { range?: [number, number] }).range;
          return range === undefined ? text : decoder.decode(new TextEncoder().encode(text).slice(range[0], range[1]));
        })
        .join('\n');
      assert.ok(located !== '', entry.fragments[0].selector);
      if (entry.data.form === 'text') assert.equal(located.replace(/\n+$/, '').trim(), entry.statement.trim());
    }
    for (const item of fromMarkdown.unplaced) assert.equal(md.locate(item.fragment.selector)?.text.trim(), item.text);
  });

  it('keeps NUL bytes out of the entries', () => {
    const result = produceManualEntries(markdown(utf8('**demo nul**\n\n说明\u0000文字。\n')),null,{catalog:STRICT_MANUAL_CATALOG});
    assert.deepEqual(result.entries.map((entry) => entry.statement), ['demo nul', '说明文字。']);
  });

  it('does not accept heads alone as a locked command grammar', () => {
    const result = manual({ model: md.model, heads: ['demo', 'show'] }) as ManualResult;
    const paths = signatures(result).map((entry) => entry.path);
    assert.ok(!paths.includes('/commands/?') && !paths.includes('/commands/enable'));
    assert.ok(!paths.includes('/commands/demo/pool/add')&&!paths.includes('/commands/show/demo/status'));
    assert.ok(result.warnings.some(w=>w.includes('命令树')&&w.includes('下一步')));
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
        ['text', '/commands/demo/pool/add', 'demo pool add p1 192.0.2.5 20\ndemo pool add p1 192.0.2.6', 'p/worked_examples/0/lines'],
        ['text', '/commands/help', 'help', 'p/worked_examples/1/lines'],
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

  it('uses explicit head identity: numeric words do not make a signature an example, and no longest-prefix fallback occurs', () => {
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
    const result = produceManualEntries(catalog,null,{catalog:STRICT_MANUAL_CATALOG});
    assert.deepEqual(
      result.entries.map((entry) => [entry.data.form, entry.path, entry.statement, entry.data.example ?? false]),
      [
        ['signature','/commands/demo/policy/agent','demo policy agent <agent>',false],
        ['signature','/commands/demo/disk/warn','demo disk warn <high> <low>',false],
        ['signature','/commands/demo/limit','demo limit <method> <value>',false],
        ['signature','/commands/demo/v6/6','demo v6 6',false],
      ],
    );
    assert.deepEqual(result.unplaced.map(item=>[item.kind,item.fragment.selector,item.text]),[
      ['behaviour','p/signatures/1/signature_verbatim','demo policy agent "Demo 1.0" css'],
      ['behaviour','p/signatures/3/signature_verbatim','demo disk warn 80 60'],
      ['behaviour','p/signatures/4/signature_verbatim','demo limit get 100'],
      ['behaviour','p/signatures/6/signature_verbatim','other “x_server”'],
    ]);
    for (const entry of result.entries) assert.ok(!/["“”]/.test(entry.path ?? ''), entry.path ?? '');
  });

  it('gives fragments the json@1 document locates', () => {
    for (const entry of fromCatalog.entries) assert.ok(catalogDocument.locate(entry.fragments[0].selector), entry.fragments[0].selector);
    for (const item of fromCatalog.unplaced) assert.ok(catalogDocument.locate(item.fragment.selector), item.fragment.selector);
    const verbatim = catalogDocument.locate('p/signatures/1/signature_verbatim');
    assert.equal(canonicalSignature(verbatim?.text ?? ''), fromCatalog.entries[1].statement);
  });

  it('recognises the catalog by the schema in identity too', () => {
    const result = produceManualEntries({ identity: { schema: 'ist.manual-command-catalog' }, signatures: [{ head_tokens: ['x'], params: [], signature_verbatim: '**x**' }] } as unknown as ManualCatalog,null,{catalog:STRICT_MANUAL_CATALOG});
    assert.equal(result.entries.length, 1);
    const unknown = produceManualEntries({ schema: 'other', signatures: [] } as unknown as ManualCatalog,null,{catalog:STRICT_MANUAL_CATALOG});
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
    const tree=commandCatalog(xml('<commands>'+Array.from({length:8000},(_,k)=>`<item name="demo c${k} set"><arguments><arg type="STRING"/><arg type="STRING" optional="YES"/></arguments></item>`).join('')+'</commands>')).catalog;
    const result = produceManualEntries(model,null,{catalog:tree});
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
      result.entries.map((entry) => [entry.path]),
      [['/manual/cli'], ['/manual/cli/章']],
    );
    assert.deepEqual(result.unplaced, []);
  });

  it('hangs blocks of repeated and empty headings by their ordinal segments', () => {
    const result = produceManualEntries(markdown('# 重复\n\n甲\n\n# 重复\n\n乙\n\n##\n\n丙\n'),null,{catalog:STRICT_MANUAL_CATALOG});
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
    const result = produceManualEntries(markdown('# 章\n\n### 小节\n\n正文。\n'),null,{catalog:STRICT_MANUAL_CATALOG});
    assert.deepEqual(result.entries.map((entry) => entry.path), ['/manual/manual/章/小节']);
  });

  it('hangs a block at the manual root when its section path cannot be written, with a warning', () => {
    // A hand-written model whose block points at a section that does not exist.
    const model = { level: 0, key: '', charset: 'utf-8', lines: 0, nulRemoved: 0, sections: [], blocks: [{ kind: 'paragraph', section: 3, index: 0, line: 0, lines: 1, text: '孤儿块。', selector: 'b/0' }] };
    const result = produceManualEntries(model as unknown as MarkdownModel,null,{catalog:STRICT_MANUAL_CATALOG});
    assert.deepEqual(result.entries.map((entry) => entry.path), ['/manual/manual']);
    assert.ok(result.warnings.some((warning) => warning.includes('1 个块指向不存在的章节')), result.warnings.join('\n'));
  });

  it('accepts the manual name through { model, name }', () => {
    const result = manual({ model: markdown('# 章\n\n正文。\n'), name: 'app' }) as ManualResult;
    assert.deepEqual(result.entries.map((entry) => entry.path), ['/manual/app/章']);
  });
});

describe('author-marked command literals', () => {
  it('retains marked prose verbatim without classifying it as commands', () => {
    const result = produceManualEntries(
      markdown('# 概述\n\n成员池用 **demo pool add** 添加成员；先执行 “demo pool create”。也可见 `demo pool mode` 与『demo probe』。\n'),
    null,{catalog:STRICT_MANUAL_CATALOG});
    assert.deepEqual(result.entries[0].path, '/manual/manual/概述');
    assert.equal(result.entries[0].data.command_literals,undefined);
    for(const source of ['**demo pool add**','“demo pool create”','`demo pool mode`','『demo probe』'])assert.ok(result.entries[0].statement.includes(source));
  });

  it('records the command lines of code blocks (after the prompt) and the signature of a signature entry', () => {
    const result = produceManualEntries(markdown('**demo pool add** *\\<name\\>*\n\n示例：\n\n    Box(config)#demo pool add p1 192.0.2.5\n    demo pool add p1 192.0.2.5\n    成员添加成功\n'),null,{catalog:STRICT_MANUAL_CATALOG});
    const [signature, , code] = result.entries;
    assert.deepEqual(signature.data.signature_literals, [{primary:'demo pool add',alternatives:['demo pool add']}]);
    // 决定 60/62 (integrator, 2026-10-25): a code block is a structural position, so every whole line is a command
    // claim. The line the locked tree resolves is stored as its canonical identity and links exactly; the lines it
    // cannot resolve (the prompted form and the device output) are stored exactly as written and become drift facts of
    // the run — a mismatch is reported, never repaired by stripping a prompt or by guessing a command.
    assert.deepEqual(code.data.command_literals,['    成员添加成功','Box(config)#demo pool add p1 192.0.2.5','demo pool add']);
    // The strict grammar strips neither the prompt nor the indentation: the line is kept exactly as written, and only
    // the whole line that resolves against the tree is recorded; the prompt line and the output line resolve to nothing.
    assert.deepEqual(code.data.command_lines,['    demo pool add p1 192.0.2.5'],'no prompt or output stripping: the bare line is kept verbatim');
  });

  it('records nothing from prose without marks, from CJK spans, or from html blocks', () => {
    const result = produceManualEntries(markdown('# 章\n\n命令见上。\n\n**注意：** 慎用。\n\n<div>demo pool add</div>\n'),null,{catalog:STRICT_MANUAL_CATALOG});
    assert.ok(result.entries.every((entry) => entry.data.command_literals === undefined));
  });

  it('extracts literals in linear time over unmatched marks', () => {
    const text = `# 章\n\n${'“'.repeat(80_000)}\n`;
    const start = performance.now();
    const result = produceManualEntries(markdown(text),null,{catalog:STRICT_MANUAL_CATALOG});
    const ms = performance.now() - start;
    assert.ok(ms < 3000, `took ${ms} ms`);
    assert.ok(result.entries.every((entry) => entry.data.command_literals === undefined));
  });

  it('dedupes a repeated prose mention and retains the complete mention list', () => {
    // 决定 60: a marked span in prose is stored verbatim as a mention — not classified, not filtered by its shape and
    // not built into a list grammar — and the former 100-item cap is gone, so nothing is silently truncated.
    const mention = `${Array.from({ length: 120 }, (_, k) => `**demo c${k}**`).join('，')}，**demo c0** 再提一次。`;
    const result = produceManualEntries(markdown(`# 章\n\n${mention}\n`),null,{catalog:STRICT_MANUAL_CATALOG});
    const mentions = result.entries[0].data.command_mentions as string[];
    assert.equal(mentions.length, 120);
    assert.equal(mentions[0], 'demo c0');
    assert.equal(result.entries[0].data.command_mentions_cut, undefined);
    assert.equal(result.entries[0].data.command_literals, undefined, 'prose claims no command');
  });

  it('keeps all 150 prose mentions verbatim and claims no drift for them', () => {
    // A mention the locked tree cannot match is still only a mention (决定 60): drift is a fact about a structural
    // position, and whether the author meant a command in prose is Circle's proposal with a verbatim quote, not the
    // pack's judgment.
    const mention = Array.from({ length: 150 }, (_, k) => `**demo missing${k}**`).join('，');
    const catalog = commandCatalog(xml('<commands><scope type="global"><menu name="demo"><item name="present" help_string="p"><arguments></arguments></item></menu></scope></commands>')).catalog;
    const result = produceManualEntries(markdown(`# 章\n\n${mention}\n`), null, { catalog });
    const entry = result.entries[0];
    assert.equal((entry.data.command_mentions as string[]).length, 150);
    assert.equal(entry.data.command_mentions_cut, undefined);
    assert.equal(entry.data.command_literals, undefined);
    assert.ok(!result.warnings.some(warning => warning.includes('漂移')), 'the isolated producer makes no whole-root drift claim');
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
        ['text', '/manual/manual'],
        ['text', '/manual/manual'],
      ],
    );
    const without = produceManualEntries(markdown(text));
    assert.ok(without.entries.every(entry=>!entry.path?.startsWith('/commands/')),'without a locked grammar, formatting establishes no command identity');
    assert.ok(without.warnings.some(w=>w.includes('命令树')&&w.includes('下一步')));
  });


  it('a bold single-word cell is a value, parameter or term, not a row signature (findings 4, 8, 13 of the second review)', () => {
    const tree =
      '<commands><scope type="global"><menu name="demo"><menu name="pool"><item name="state" help_string="s"><arguments></arguments></item>' +
      '<item name="add" help_string="a"><arguments></arguments></item></menu></menu></scope></commands>';
    const withEnable = commandCatalog(xml('<commands><scope type="global"><menu name="demo"><menu name="pool"><item name="state" help_string="s"><arguments></arguments></item></menu></menu><item name="enable" help_string="e"><arguments></arguments></item></scope></commands>')).catalog;
    const catalog = commandCatalog(xml(tree)).catalog;
    // A value table under demo pool state: the rows stay in the table entry at their command; no definitions of enable/disable.
    const values = produceManualEntries(markdown('**demo pool state** *\\<value\\>*\n\n| 取值 | 说明 |\n|---|---|\n| **enable** | 启用成员池 |\n| **disable** | 停用成员池 |\n'), null, { catalog });
    assert.ok(values.entries.every((entry) => entry.data.form !== 'signature' || entry.path === '/commands/demo/pool/state'), JSON.stringify(values.entries.map((e) => [e.data.form, e.path])));
    assert.ok(values.entries.some((entry) => String(entry.statement).includes('启用成员池') && entry.path === '/commands/demo/pool/state'), 'the rows stay with their command');
    // Even when the tree HAS a top-level enable: the value row never becomes a definition at /commands/enable.
    const withEnableTree = produceManualEntries(markdown('**demo pool state** *\\<value\\>*\n\n| 取值 | 说明 |\n|---|---|\n| **enable** | 启用成员池 |\n'), null, { catalog: withEnable });
    assert.ok(!withEnableTree.entries.some((entry) => entry.path === '/commands/enable'), JSON.stringify(withEnableTree.entries.map((e) => [e.data.form, e.path])));
    // A bold parameter table under demo pool add: the rows stay in the remainder at the command.
    const params = produceManualEntries(markdown('**demo pool add** *\\<name\\>*\n\n| 参数 | 说明 |\n|---|---|\n| **name** | 成员名 |\n| **weight** | 权重 |\n'), null, { catalog });
    assert.deepEqual(params.entries.map((e) => [e.data.form, e.path]), [
      ['signature', '/commands/demo/pool/add'],
      ['text', '/commands/demo/pool/add'],
    ], 'the parameter rows stay in the table remainder at their command');
    assert.ok(params.entries.some((entry) => String(entry.statement).includes('成员名') && entry.path === '/commands/demo/pool/add'), 'the parameter rows stay with their command');
    assert.ok(params.entries.every(entry=>entry.data.command_literals===undefined),'a parameter name in prose is never a command literal');
    // A glossary row outside any command stays in the table entry at its section.
    const glossary = produceManualEntries(markdown('# 术语\n\n| 术语 | 说明 |\n|---|---|\n| **VIP** | 虚拟服务地址 |\n'), null, { catalog });
    assert.ok(glossary.entries.every((entry) => entry.data.form !== 'signature'), JSON.stringify(glossary.entries.map((e) => [e.data.form, e.path])));
    // A header that names commands (命令) keeps single-word command rows as signatures.
    const commandHeader = produceManualEntries(markdown('## 配置命令\n\n| command_signature@2 | 说明 |\n|---|---|\n| **enable** | 进入特权级 |\n'), null, { catalog:withEnable });
    assert.ok(commandHeader.entries.some((entry) => entry.data.form === 'signature' && entry.statement.startsWith('enable')), JSON.stringify(commandHeader.entries.map((e) => [e.data.form, e.path])));
  });



  it('splits a cell on the documented comma and slash connectives and never joins two bold runs through a plain character (finding 19)', () => {
    const tree = commandCatalog(xml('<commands><scope type="global"><menu name="demo"><menu name="pool"><item name="add" help_string="a"><arguments></arguments></item><item name="mode" help_string="m"><arguments></arguments></item></menu></menu></scope></commands>')).catalog;
    for (const joined of ['**demo pool add**, **demo pool mode**', '**demo pool add**，**demo pool mode**', '**demo pool add**/**demo pool mode**', '**demo pool add**／**demo pool mode**', '**demo pool add** / **demo pool mode**']) {
      const result = produceManualEntries(markdown(`# 章\n\n## 配置命令\n\n| command_signature@2 | 说明 |\n|---|---|\n| ${joined} | 两步配合 |\n`), null, { catalog: tree });
      // Two signatures in one cell: the row hangs at the commands' common ancestor, and neither bold run is glued
      // into one head word (no %2F path, no drift for a placed row).
      assert.ok(result.entries.some((entry) => String(entry.statement).includes('两步配合') && entry.path === '/commands/demo/pool'), `${joined} hangs the row at the commands' common ancestor`);
      assert.ok(result.entries.every((entry) => !String(entry.path).includes('%2F')), `${joined} never glues two bold runs into one path`);
      assert.ok(!result.warnings.some((warning) => warning.includes('漂移候选')), `${joined} lists no drift: ${result.warnings.join('；')}`);
    }
    // A head token joining two bold runs through a plain character is not one command (no add%2Fmode path).
    const glued = produceManualEntries(markdown('# 章\n\n**demo pool add**/**demo pool mode**\n\n说明。\n'), null, { catalog: tree });
    assert.ok(glued.entries.every((entry) => !String(entry.path).includes('%2F')), 'no synthetic slash path');
    assert.ok(glued.entries.every((entry) => entry.path !== '/commands/demo/pool/add%2Fdemo/pool/mode'), 'the glued form never becomes one command');
  });

  it('hangs signatures at their section nodes when the command tree is unusable (finding 23)', async () => {
    const producers = await import('./producers.ts');
    const tree = xml('<commands><scope type="global"><menu name="demo"><item name="present" help_string="p"><arguments></arguments></item></menu></scope></commands>');
    void tree;
    const input = {
      slots: {
        tree: { parser: 'text@1', model: { lines: ['not xml'] } },
        cli: { parser: 'markdown@1', model: markdown('# 章\n\n**demo nothing here** *\\<x\\>*\n\n该命令不存在。\n') },
      },
      heads: null,
    };
    const out = producers.manual(input as never);
    const signatures = out.entries.filter((entry) => entry.data.form === 'signature');
    assert.equal(signatures.length,0,'without a locked tree no definition identity is established');
    assert.ok(out.entries.some(entry=>entry.statement.includes('**demo nothing here**')),'the source remains citable');
    assert.ok(out.entries.every((entry) => (entry.path ?? '').startsWith('/manual/')), 'no synthetic /commands path without a usable tree');
    assert.ok(out.warnings.some((warning) => warning.includes('命令树不可用') && warning.includes('签名留在章节节点')), out.warnings.join('；'));
  });


  it('a command-header cell splits two bold runs joined by a slash into two signatures (each placed by its own rule)', () => {
    const tree = commandCatalog(xml('<commands><scope type="global"><menu name="demo"><menu name="pool"><item name="add" help_string="a"><arguments></arguments></item><item name="mode" help_string="m"><arguments></arguments></item></menu></menu></scope></commands>')).catalog;
    for (const slash of ['/', '／', ' / ']) {
      const result = produceManualEntries(markdown(`# 章\n\n## 配置命令\n\n| command_signature@2 | 说明 |\n|---|---|\n| **demo pool add**${slash}**demo pool mode** | 两步配合 |\n`), null, { catalog: tree });
      // Two signature-shaped runs: the row is a multi-command row and hangs at the commands' placement (never one
      // glued head word, never a synthetic %2F path), with no drift for a placed row.
      assert.ok(result.entries.some((entry) => String(entry.statement).includes('两步配合') && entry.path === '/commands/demo/pool'), `${slash} hangs the row at the commands' common ancestor`);
      assert.ok(result.entries.every((entry) => !String(entry.path).includes('%2F')), `${slash} never glues two bold runs into one path`);
      assert.ok(!result.warnings.some((warning) => warning.includes('漂移候选')), `${slash} lists no drift: ${result.warnings.join('；')}`);
    }
    // Without the command header the glued cell stays one remainder row (finding 19 keeps its rule).
    const noHeader = produceManualEntries(markdown('# 章\n\n## 配置\n\n| 步骤 | 说明 |\n|---|---|\n| **demo pool add**/**demo pool mode** | 两步配合 |\n'), null, { catalog: tree });
    assert.ok(noHeader.entries.every((entry) => entry.data.form !== 'signature'), 'no signature outside a command header');
  });


  it('never splits inside parameter syntax: slashes and commas inside \<…\>, \[…\], \\{…\\} keep the row one signature (closure findings 1 and 16)', () => {
    // demo route static is a nested menu: menu demo > menu route > item static (the signature words must exist).
    const tree = commandCatalog(xml('<commands><scope type="global"><menu name="demo"><menu name="pool"><item name="add" help_string="a"><arguments></arguments></item><item name="mode" help_string="m"><arguments></arguments></item></menu><menu name="route"><item name="static" help_string="s"><arguments></arguments></item></menu><item name="probe" help_string="p"><arguments></arguments></item></menu><menu name="ip"><item name="route" help_string="r"><arguments></arguments></item></menu><menu name="show"><item name="ip" help_string="i"><arguments></arguments></item></menu><menu name="interface"><item name="ethernet" help_string="e"><arguments></arguments></item></menu><menu name="acl"><item name="permit" help_string="pe"><arguments></arguments></item></menu></scope></commands>')).catalog;
    // Under a command header: a slash inside the parameter keeps the definition.
    for (const row of [
      '| **demo route static** *\\<network/prefix\\>* | 静态路由 |',
      '| **ip route** *\\<A.B.C.D/M\\>* | 静态路由 |',
      '| **interface ethernet** *\\<slot/port\\>* | 接口 |',
      '| **show ip** *\\[ip/mask\\]* | 显示路由 |',
    ]) {
      const result = produceManualEntries(markdown(`# 章\n\n## 配置命令\n\n| command_signature@2 | 说明 |\n|---|---|\n${row}\n`), null, { catalog: tree });
      const signatures = result.entries.filter((entry) => entry.data.form === 'signature');
      assert.equal(signatures.length, 1, `${row}: ${JSON.stringify(result.entries.map((e) => [e.data.form, e.path]))}`);
      const first = signatures[0]; assert.ok(first !== null && (first.path ?? '').startsWith('/commands/'), row);
    }
    // In any table: a comma inside the parameter keeps the definition.
    for (const row of [
      '| **demo acl permit** *\\<port\\>\\[,\\<port\\>\\]* | 放行 |',
      '| **demo pool add** *\\<name,weight\\>* | 添加 |',
      '| **demo pool mode** *\\{tcp,udp\\}* | 模式 |',
    ]) {
      const result = produceManualEntries(markdown(`# 章\n\n## 格式\n\n| command_signature@2 | 说明 |\n|---|---|\n${row}\n`), null, { catalog: tree });
      const signatures = result.entries.filter((entry) => entry.data.form === 'signature');
      assert.equal(signatures.length, 1, `${row}: ${JSON.stringify(result.entries.map((e) => [e.data.form, e.path]))}`);
    }
    // A prose run holding more than connectives never joins two bold runs into one multi-command row.
    const mention = produceManualEntries(markdown('# 章\n\n## 配置命令\n\n| command_signature@2 | 说明 |\n|---|---|\n| **demo pool add** *\\<name\\>* | 添加成员，相关命令，**demo pool mode** |\n'), null, { catalog: tree });
    const placed = mention.entries.filter((entry) => entry.data.form === 'signature');
    assert.equal(placed.length, 1, `the mention row keeps its one definition: ${JSON.stringify(placed.map((e) => e.path))}`);
    assert.equal(placed[0]!.path, '/commands/demo/pool/add');
    const rowText = mention.entries.find((entry) => String(entry.statement).includes('相关命令'));
    assert.ok(rowText !== undefined && (rowText.data.command_mentions as string[]).includes('demo pool mode'), 'the mention stays a literal of the row text');
  });




  it('a description cell keeps its row a signature row, and only a closed header list names a command column (closure c3 item 3)', () => {
    const tree = commandCatalog(xml('<commands><scope type="global"><menu name="demo"><menu name="pool"><item name="add" help_string="a"><arguments></arguments></item><item name="create" help_string="c"><arguments></arguments></item><item name="mode" help_string="m"><arguments></arguments></item></menu></menu></scope></commands>')).catalog;
    // A bold mention in the description cell never steals the definition.
    const mention = produceManualEntries(markdown('# 章\n\n## 配置命令\n\n| command_signature@2 | 说明 |\n|---|---|\n| **demo pool add** *\\<name\\>* | 先执行 **demo pool create** *\\<name\\>* |\n'), null, { catalog: tree });
    assert.ok(mention.entries.some((entry) => entry.kind === 'definition' && entry.path === '/commands/demo/pool/add'), JSON.stringify(mention.entries.map((e) => [e.kind, e.path])));
    // Text before the first bold run is prose: the whole cell is prose, a bold span inside it is a mention.
    const proseFirst = produceManualEntries(markdown('# 章\n\n## 配置命令\n\n| command_signature@2 | 说明 |\n|---|---|\n| 先执行 **demo pool create** | 创建 |\n'), null, { catalog: tree });
    assert.ok(!proseFirst.entries.some((entry) => entry.kind === 'definition'), JSON.stringify(proseFirst.entries.map((e) => [e.kind, String(e.statement)])));
    // A header that QUALIFIES the command (命令说明, 命令模式) is not a command column.
    for (const headers of [['command_signature@2', '命令说明'], ['command_signature@2', '命令模式', '说明']]) {
      const doc = headers.length === 2
        ? `# 章\n\n## 配置命令\n\n| ${headers[0]} | ${headers[1]} |\n|---|---|\n| **demo pool add** *\\<name\\>* | 添加成员，参见 **demo pool mode** |\n`
        : `# 章\n\n## 配置命令\n\n| ${headers[0]} | ${headers[1]} | ${headers[2]} |\n|---|---|---|\n| **demo pool add** *\\<name\\>* | **config** | 添加 |\n`;
      const result = produceManualEntries(markdown(doc), null, { catalog: tree });
      assert.ok(result.entries.some((entry) => entry.kind === 'definition' && entry.path === '/commands/demo/pool/add'), JSON.stringify(result.entries.map((e) => [e.kind, e.path])));
      assert.ok(!result.entries.some((entry) => entry.kind === 'definition' && String(entry.statement).startsWith('config')), headers.join('/'));
      assert.ok(!result.entries.some((entry) => entry.kind === 'definition' && String(entry.statement).startsWith('demo pool mode')), headers.join('/'));
    }
  });

  it('keeps a multi-run cell whole: parameters and bold keywords ride with their signature (closure c3 item 1)', () => {
    const tree = commandCatalog(xml('<commands><scope type="global"><menu name="demo"><menu name="pool"><item name="add" help_string="a"><arguments></arguments></item><item name="mode" help_string="m"><arguments></arguments></item></menu><menu name="route"><item name="static" help_string="s"><arguments></arguments></item></menu></menu><menu name="show"><item name="version" help_string="v"><arguments></arguments></item></menu></scope></commands>')).catalog;
    // A bold parameter keyword after the head's parameters: one signature, both parameters.
    const keyword = produceManualEntries(markdown('# 章\n\n## 配置命令\n\n| command_signature@2 | 说明 |\n|---|---|\n| **demo pool add** *\\<name\\>* **weight** *\\<w\\>* | 添加 |\n'), null, { catalog: tree });
    const def = keyword.entries.find((entry) => entry.kind === 'definition' && entry.path === '/commands/demo/pool/add');
    assert.ok(def !== undefined, JSON.stringify(keyword.entries.map((e) => [e.kind, e.path])));
    assert.equal(def.statement, 'demo pool add <name> weight <w>');
    // Two parameterized signatures joined by 与 or 、: both commands appear (a row under their common parent with
    // both literals), and neither is dropped from the statement.
    for (const join of ['与', '、']) {
      const two = produceManualEntries(markdown(`# 章\n\n## 配置命令\n\n| command_signature@2 | 说明 |\n|---|---|\n| **demo pool add** *\\<name\\>* ${join} **demo pool mode** *\\<m\\>* | 说明 |\n`), null, { catalog: tree });
      const row = two.entries.find((entry) => String(entry.statement).includes('demo pool add') && String(entry.statement).includes('demo pool mode'));
      assert.ok(row !== undefined, join);
      const literals = ((row.data.signature_literals ?? []) as Array<{primary:string;alternatives:string[]}>).flatMap(group=>group.alternatives);
      assert.ok(literals.includes('demo pool add') && literals.includes('demo pool mode'), `${join}: ${JSON.stringify(literals)}`);
      assert.equal(manualRelations(two,tree).links.length,2);assert.deepEqual(manualRelations(two,tree).drift,[]);
    }
    // A ***-closed first signature still splits at the connective: both commands reach the row's statement.
    const star = produceManualEntries(markdown('# 章\n\n## 配置命令\n\n| command_signature@2 | 说明 |\n|---|---|\n| **demo pool add *\\<name\\>***、**demo pool mode** | 说明 |\n'), null, { catalog: tree });
    const starRow = star.entries.find((entry) => String(entry.statement).includes('demo pool add') && String(entry.statement).includes('demo pool mode'));
    assert.ok(starRow !== undefined, JSON.stringify(star.entries.map((e) => [e.kind, String(e.statement)])));
    const starLiterals = ((starRow.data.signature_literals ?? []) as Array<{primary:string;alternatives:string[]}>).flatMap(group=>group.alternatives);
    assert.ok(starLiterals.includes('demo pool add') && starLiterals.includes('demo pool mode'), JSON.stringify(starLiterals));
    // A plain word after the head and a note after the parameter are prose, never a re-wrapped signature.
    for (const cell of ['**show version** detail', '**demo pool add** *\\<name\\>* (optional)']) {
      const prose = produceManualEntries(markdown(`# 章\n\n## 配置命令\n\n| command_signature@2 | 说明 |\n|---|---|\n| ${cell} | 说明 |\n`), null, { catalog: tree });
      assert.ok(!prose.entries.some((entry) => entry.kind === 'definition' && String(entry.statement).includes('detail') || entry.kind === 'definition' && String(entry.statement).includes('(optional)')), cell);
      assert.ok(!prose.entries.some((entry) => entry.kind === 'definition' && String(entry.statement) === 'show version detail'), cell);
    }
  });

  it('lists as drift only the literals the tree cannot resolve, and records row literals (closure findings 4, 17, 20, 21)', () => {
    const tree = commandCatalog(xml('<commands><scope type="global"><menu name="demo"><menu name="pool"><item name="add" help_string="a"><arguments></arguments></item><item name="mode" help_string="m"><arguments></arguments></item></menu><menu name="route"><item name="static" help_string="s"><arguments></arguments></item><item name="add" help_string="a2"><arguments></arguments></item></menu><item name="probe" help_string="p"><arguments></arguments></item></menu><menu name="show"><item name="demo" help_string="d"><arguments></arguments></item></menu></scope></commands>')).catalog;
    // A variant signature with one variant present: only the missing one is drift.
    const variant = produceManualEntries(markdown('# 章\n\n| command_signature@2 |\n|---|\n| **demo {pool\\|probe} add** *\\<name\\>* |\n\n说明。\n'), null, { catalog: tree });
    assert.deepEqual(manualRelations(variant,tree).drift.map(g=>g.literal),['demo probe add']);
    assert.ok(!manualRelations(variant,tree).drift.some(g=>g.literal==='demo pool add'));
    // A multi-command row whose commands all exist at /commands/demo: no drift at all.
    const rowBoth = produceManualEntries(markdown('# 章\n\n## 配置命令\n\n| command_signature@2 | 说明 |\n|---|---|\n| **demo pool add** 与 **demo route static** | 跨分支 |\n'), null, { catalog: tree });
    assert.deepEqual(manualRelations(rowBoth,tree).drift,[]);
    // An unplaced multi-command row records the union of its anchors' literals and its prose mentions.
    const rowText = rowBoth.entries.find((entry) => String(entry.statement).includes('跨分支'));
    assert.ok(rowText !== undefined, JSON.stringify(rowBoth.entries.map((e) => e.path)));
    assert.deepEqual(([...(((rowText.data.signature_literals as {primary:string;alternatives:string[]}[]|undefined)?.flatMap(group=>group.alternatives) ?? []) as string[])]).sort(), ['demo pool add', 'demo route static'], JSON.stringify(rowText.data.command_literals));
    const withMention = produceManualEntries(markdown('# 章\n\n## 配置命令\n\n| command_signature@2 | 说明 |\n|---|---|\n| **demo probe** 与 **show demo status** | 配合，见 \`demo pool mode\` |\n'), null, { catalog: tree });
    const mentionEntry = withMention.entries.find((entry) => String(entry.statement).includes('配合'));
    assert.ok(mentionEntry !== undefined);
    assert.deepEqual(mentionEntry.data.command_mentions,['demo pool mode']);
    assert.deepEqual(mentionEntry.data.signature_literals,[{primary:'demo probe',alternatives:['demo probe']},{primary:'show demo status',alternatives:['show demo status']}]);
    assert.deepEqual(manualRelations(withMention,tree).drift.map(g=>g.literal),['show demo status']);
    assert.ok(!manualRelations(withMention,tree).drift.some(g=>['demo probe','demo pool mode'].includes(g.literal)));
    // A value row that mentions an existing command: no word-level drift (closure 5/21).
    const treeWithCreate = commandCatalog(xml('<commands><scope type="global"><menu name="demo"><menu name="pool"><item name="add" help_string="a"><arguments></arguments></item><item name="mode" help_string="m"><arguments></arguments></item><item name="create" help_string="c"><arguments></arguments></item></menu></menu></scope></commands>')).catalog;
    const mentionCell = produceManualEntries(markdown('**demo pool add** *\\<name\\>*\n\n| 参数 | 说明 |\n|---|---|\n| name | 名称，先用 **demo pool create** 创建 |\n'), null, { catalog: treeWithCreate });
    assert.deepEqual(manualRelations(mentionCell,treeWithCreate).drift,[]);
  });


  it('a bold paragraph with a slash in its head ends the current command and hangs at its section (closure finding 18)', () => {
    const tree = commandCatalog(xml('<commands><scope type="global"><menu name="demo"><menu name="pool"><item name="add" help_string="a"><arguments></arguments></item></menu></menu></scope></commands>')).catalog;
    for (const paragraph of ['**show ip/ipv6 route**', '**demo pool add**/**demo pool mode**']) {
      const result = produceManualEntries(markdown(`# 章\n\n**demo pool add** *\\<name\\>*\n\n添加成员。\n\n${paragraph}\n\n显示路由信息。\n`), null, { catalog: tree });
      // The paragraph and the text after it hang at the section node, never at demo pool add.
      const after = result.entries.filter((entry) => String(entry.statement).includes('显示路由信息'));
      assert.ok(after.length > 0, paragraph);
      assert.ok(after.every((entry) => (entry.path ?? '').startsWith('/manual/')), `${paragraph}: ${JSON.stringify(after.map((e) => e.path))}`);
      const added = result.entries.filter((entry) => String(entry.statement) === '添加成员。');
      assert.equal(added.length, 1);
      assert.equal(added[0]!.path, '/commands/demo/pool/add');
    }
  });

  it('drift follows the placement check for signatures: an extending signature is listed, a variant key never is, and [no] groups place like resolves (second review findings 11, 12, 14, 17, 18, 24)', () => {
    // A tree where demo pool is itself a complete command: **demo pool mode** is missing, and resolves() would
    // wrongly accept the 'demo pool' prefix. Drift must list demo pool mode.
    const treeWithPool =
      '<commands><scope type="global"><menu name="demo"><menu name="pool" help_string="p"><item name="add" help_string="a"><arguments></arguments></item></menu></menu></scope></commands>';
    const extendsTree = commandCatalog(xml(treeWithPool)).catalog;
    const missing = produceManualEntries(markdown('# 章\n\n| command_signature@2 |\n|---|\n| **demo pool mode** *\\<name\\>* |\n\n该命令用于设置。\n'), null, { catalog: extendsTree });
    assert.deepEqual(manualRelations(missing,extendsTree).drift.map(g=>g.literal),['demo pool mode']);
    // A variant signature whose key node exists: only the missing variants are drift, never the bare key.
    const treeWithDemoRoute = commandCatalog(xml('<commands><scope type="global"><menu name="demo"><menu name="route"><item name="add" help_string="a"><arguments></arguments></item></menu></menu></scope></commands>')).catalog;
    const variant = produceManualEntries(markdown('# 章\n\n| command_signature@2 |\n|---|\n| **demo {pool\\|route} add** *\\<name\\>* |\n\n该命令用于添加。\n'), null, { catalog: treeWithDemoRoute });
    assert.deepEqual(manualRelations(variant,treeWithDemoRoute).drift.map(g=>g.literal),['demo pool add']);
    assert.ok(!variant.warnings.some((warning) => /漂移候选[^：]*：demo（|demo、|、demo[^ ]/.test(warning) && /：demo/.test(warning)), 'the bare key demo is never a drift candidate');
    // An undeclared no-form cannot borrow the positive variants to pass full grammar verification.
    const bothTcpUdp = commandCatalog(xml('<commands><scope type="global"><menu name="demo"><menu name="health"><item name="tcp" help_string="t"><arguments></arguments></item><item name="udp" help_string="u"><arguments></arguments></item></menu></menu></scope></commands>')).catalog;
    const noGroup = produceManualEntries(markdown('# 章\n\n**[no] demo health {tcp\\|udp}**\n\n该命令用于探测。\n'), null, { catalog: bothTcpUdp });
    assert.equal(noGroup.entries[0].path, '/manual/manual/章', 'unlisted no-form variants cannot inherit a positive path');
    assert.equal(noGroup.entries[0].data.signature_rejected, true);
    assert.deepEqual(manualRelations(noGroup,bothTcpUdp).drift,[]);
    // A multi-command row that the placement check placed lists no drift literal of its own.
    const rowTree = commandCatalog(xml('<commands><scope type="global"><menu name="demo"><menu name="pool"><item name="add" help_string="a"><arguments></arguments></item></menu><menu name="route"><item name="add" help_string="a2"><arguments></arguments></item><item name="static" help_string="s"><arguments></arguments></item></menu></menu></scope></commands>')).catalog;
    const row = produceManualEntries(markdown('# 章\n\n## 配置命令\n\n| command_signature@2 | 说明 |\n|---|---|\n| **demo {pool\\|route} add** 与 **demo route static** | 配合 |\n'), null, { catalog: rowTree });
    assert.deepEqual(manualRelations(row,rowTree).drift,[]);
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
    const missing = produceManualEntries(markdown('| command_signature@2 |\n|---|\n| **demo {pool\\|route} add** *\\<name\\>* |\n\n该命令用于添加。\n'), null, { catalog: partial });
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
    assert.deepEqual(result.entries[0].data.signature_literals, [{primary:'demo acl permit',alternatives:['demo acl permit tcp','demo acl permit udp']}]);
  });

  it('retains resolvable and unresolved literals without judging them in isolation', () => {
    const text = '**demo pool add** *\\<name\\>*\n\n该命令用于添加成员。\n\n**demo probe** *\\<name\\>*\n\n该命令用于探测，先执行 “demo pool create”。\n';
    const result = produceManualEntries(markdown(text), null, { catalog });
    // 决定 60: the two anchors are signature literals of their own entries and the quoted prose span is a mention of
    // its paragraph; together they retain every name the author wrote, and none of them is judged in isolation.
    assert.deepEqual([...new Set(result.entries.flatMap(entry => [...((entry.data.command_literals as string[] | undefined) ?? []),...((entry.data.command_mentions as string[] | undefined) ?? []),...((entry.data.signature_literals as {primary:string;alternatives:string[]}[]|undefined)?.flatMap(group=>group.alternatives)??[])]))].sort(), ['demo pool add', 'demo pool create', 'demo probe']);
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
    '| command_signature@2 | 说明 |',
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
    const bare = produceManualEntries(markdown(TABLE),null,{catalog:STRICT_MANUAL_CATALOG});
    const other = produceManualEntries(markdown(TABLE), null, { catalog: commandCatalog(xml('<commands><scope type="global"><menu name="demo"><item name="probe" help_string="p"><arguments></arguments></item></menu></scope></commands>')).catalog });
    const content = (result: ManualResult) => result.entries.map((entry) => canonicalJson({ kind: entry.kind, statement: entry.statement, data: entry.data, applicability: entry.applicability }));
    assert.deepEqual(content(bare), content(other));
  });

  it('hangs a signature row of a table under an anchor at the section node when the command is missing', () => {
    const text = '**demo pool add** *\\<name\\>*\n\n| command_signature@2 | 说明 |\n| --- | --- |\n| **demo probe** *\\<name\\>* | 本构建没有 |\n| name | 成员名 |\n';
    const result = produceManualEntries(markdown(text), null, { catalog });
    assert.deepEqual(
      result.entries.map((entry) => [entry.data.form, entry.path, entry.statement]),
      [
        ['signature', '/commands/demo/pool/add', 'demo pool add <name>'],
        ['signature', '/manual/manual', 'demo probe <name>'],
        ['text', '/manual/manual', '本构建没有'],
        ['text', '/commands/demo/pool/add', '| command_signature@2 | 说明 |\n| name | 成员名 |'],
      ],
    );
  });

  it('never takes a bold span inside a prose cell for a signature (a mention is a literal only)', () => {
    const text = '| command_signature@2 | 说明 |\n| --- | --- |\n| 成员名 | 先用 **demo pool create** 创建 |\n| **demo pool add** *\\<name\\>* | 添加成员 |\n';
    const result = produceManualEntries(markdown(`# 章\n\n${text}`), null, { catalog });
    assert.deepEqual(
      result.entries.map((entry) => [entry.data.form, entry.path, entry.statement]),
      [
        ['signature', '/commands/demo/pool/add', 'demo pool add <name>'],
        ['text', '/commands/demo/pool/add', '添加成员'],
        ['text', '/manual/manual/章', '| command_signature@2 | 说明 |\n| 成员名 | 先用 **demo pool create** 创建 |'],
      ],
    );
    const rest = result.entries[2];
    // 决定 60: a marked span in a prose cell is a mention stored verbatim, not a command claim and not a signature.
    assert.deepEqual(rest.data.command_mentions, ['demo pool create'], 'the mention is recorded verbatim');
    assert.equal(rest.data.command_literals, undefined, 'a prose cell claims no command, so it can create no drift');
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
    assert.deepEqual(fromGrid.entries.map((entry) => [entry.path]), [['/manual/manual/章']]);
    const plain = ['# 章', '', '| command_signature@2 | 说明 |', '| --- | --- |', '| 添加成员 | 用池命令 |'].join('\n');
    const fromPlain = produceManualEntries(markdown(plain), null, { catalog });
    assert.deepEqual(fromPlain.entries.map((entry) => [entry.path]), [['/manual/manual/章']]);
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
    '该命令用于探测，仅 sy-k 平台支持。',
    '',
    '| command_signature@2 | 说明 |',
    '| --- | --- |',
    '| **demo pool add** *\\<name\\>* | 添加成员 |',
    '| **demo route static** *\\<net\\>* | 静态路由 |',
    '| **demo pool add** 与 **demo route static** | 配合 |',
  ].join('\n');
  const TREE_A = '<commands><scope type="global"><menu name="demo"><menu name="pool"><item name="add" help_string="a"><arguments></arguments></item></menu><menu name="route"><item name="static" help_string="s"><arguments></arguments></item></menu></menu></scope></commands>';
  const TREE_B = '<commands><scope type="global"><menu name="demo"><menu name="route"><item name="static" help_string="s"><arguments></arguments></item></menu></menu></scope></commands>';

  it('preserves every source fragment across trees while only verified commands become definitions', () => {
    const document = markdownDocument(Buffer.from(TEXT));
    const a = produceManualEntries(document.model, null, {catalog: commandCatalog(xml(TREE_A)).catalog});
    const b = produceManualEntries(document.model, null, {catalog: commandCatalog(xml(TREE_B)).catalog});
    const sources = (result: ManualResult) => [...new Set(result.entries.flatMap(entry => entry.fragments.map(fragment => {
      const located = document.locate(fragment.selector); assert.ok(located, fragment.selector);
      return canonicalJson({selector:fragment.selector,range:fragment.range,text:located.text});
    })))].sort();
    assert.deepEqual(sources(a), sources(b));
    assert.ok(a.entries.some(entry => entry.data.form === 'signature' && entry.path === '/commands/demo/pool/add'));
    assert.ok(!b.entries.some(entry => entry.path === '/commands/demo/pool/add'));
    assert.ok(b.entries.some(entry => entry.data.signature_rejected === true && entry.statement.includes('demo pool add')));
    assert.ok([...a.entries, ...b.entries].every(entry => entry.applicability === null));

  });
});

function undeclaredManual(...args: Parameters<typeof produceManualEntries>): ManualResult {
  const result = produceManualEntries(...args);
  for (const entry of result.entries) {
    assert.equal(entry.applicability, null);
    assert.equal((entry.data.applicability_state as {declaration_status:string}).declaration_status, 'undeclared');
    assert.equal((entry.data.applicability_state as {judgment_status:string}).judgment_status, 'unjudged');
  }
  return result;
}

describe('prose applicability stays undeclared under famx-applicability@1', () => {
  it('preserves platform and model prose without declaring any applicability field', () => {
    const result = undeclaredManual(
      markdown(
        [
          '# 平台差异',
          '',
          '仅 sy-k 平台支持本节内容。',
          '',
          '## 会话保持',
          '',
          '适用于 X9000 系列机型。',
          '',
          '该功能仅适用于 sy-k、zx-demoos11 平台，自 Rel_FAMX_10_6_1_8 起可用。',
          '',
          '适用于 Rel_FAMX_10_6_1_8 和 Rel_FAMX_10_6_1_9 构建的命令见下。',
        ].join('\n'),
      ),
    null,{catalog:STRICT_MANUAL_CATALOG});
    const [own, model, mixed, builds] = result.entries;
    assert.deepEqual(own.applicability, null);
    assert.deepEqual(model.applicability, null);
    assert.deepEqual(mixed.applicability, null, 'a start build ("自…起") is not a manual-entry condition');
    assert.deepEqual(builds.applicability, null, 'which builds use a manual is said by the composition, never by the entry (K02 F[6])');
  });







  it('a model whose sections carry their own path arrays hangs anchors under those paths (closure c3 item 7)', () => {
    const tree = commandCatalog(xml('<commands><scope type="global"><menu name="demo"><menu name="pool"><item name="add" help_string="a"><arguments></arguments></item></menu><item name="probe" help_string="p"><arguments></arguments></item></menu></scope></commands>')).catalog;
    // Sections cited by text@1 line ranges carry path arrays: an anchor whose command exists still places by the
    // tree, and a missing command hangs at the model's own section path (not at the manual root, not by decoding h/).
    const blocks = [
      { kind: 'paragraph', section: 1, text: '**demo probe** *\\<name\\>*', selector: 'l/0-1' },
      { kind: 'paragraph', section: 1, text: '探测说明。', selector: 'l/2-3' },
    ];
    const model = { level: 0, key: '', charset: 'utf-8', lines: 0, nulRemoved: 0, sections: [{ title: '手册', parent: null, selector: 'l/0-99', path: [] }, { title: '配置命令', parent: 0, selector: 'l/0-99', path: ['配置命令'] }], blocks };
    const result = undeclaredManual(model as unknown as Parameters<typeof produceManualEntries>[0], null, { catalog: tree, fragmentParser: 'text@1' });
    const anchor = result.entries.find((entry) => entry.kind === 'definition');
    assert.ok(anchor !== undefined, JSON.stringify(result.entries.map((e) => [e.kind, String(e.statement)])));
    assert.equal(anchor.path, '/commands/demo/probe');
    const text = result.entries.find((entry) => entry.data.form === 'text');
    assert.ok(text !== undefined);
    assert.equal(text.path, '/commands/demo/probe');
    // A missing command hangs at the model's section path, and the fragments carry the model's parser key.
    const missing = undeclaredManual({ charset: 'utf-8', lines: 0, nulRemoved: 0, sections: model.sections, blocks: [{ kind: 'paragraph', section: 1, text: '**demo gone** *\\<x\\>*', selector: 'l/0-1' }] } as unknown as Parameters<typeof produceManualEntries>[0], null, { catalog: tree, fragmentParser: 'text@1' });
    const missingAnchor = missing.entries.find(entry => entry.data.signature_rejected === true);
    assert.ok(missing.entries.every(entry => entry.kind !== 'definition'));
    assert.deepEqual(missingAnchor?.data.command_mentions, ['demo gone']);
    assert.ok(missingAnchor !== undefined);
    assert.equal(missingAnchor.path, '/manual/manual/配置命令');
    assert.ok((missingAnchor.fragments ?? []).every((fragment) => fragment.parser === 'text@1'));
  });

  it('keeps condition prose with comma remarks and quiet tails undeclared (closure c3 item 4)', () => {
    const positives = [
      '适用于 sy-k 平台，用于配置成员。',
      '该命令仅 sy-k 平台支持，配置后立即生效。',
      '适用于 X9000 系列，默认关闭。',
      '适用于 sy-k 平台，配置后不需要重启。',
      '适用于 sy-k 平台,用于配置成员。',
      '适用于 sy-k 平台环境。',
      '适用于 X9000 系列设备。',
      '该命令可配置不同的超时时间，适用于 sy-k 平台。',
      '若未配置则使用默认值，适用于 sy-k 平台。',
      '该命令用于还原配置，适用于 sy-k 平台。',
      '无需重启，适用于 sy-k 平台。',
      '不同版本行为不同，仅 sy-k 平台支持。',
    ];
    for (const sentence of positives) {
      const result = undeclaredManual(markdown(`**demo pool add** *\\<name\\>*\n\n${sentence}\n`),null,{catalog:STRICT_MANUAL_CATALOG});
      const behaviour = result.entries.find((entry) => entry.data.form === 'text');
      const expected = /系列/.test(sentence) ? { models: ['X9000'] } : { platforms: ['sy-k'] };
      assert.deepEqual(behaviour?.applicability ?? null, null, `${sentence} 散文不声明条件`);
    }
    // A table row's own condition still splits the row out with its condition.
    const row = undeclaredManual(markdown('**demo pool add** *\\<name\\>*\n\n| 参数 | 说明 |\n|---|---|\n| weight | 权重，仅 sy-k 平台支持，默认 1 |\n'),null,{catalog:STRICT_MANUAL_CATALOG});
    const conditioned = row.entries.find((entry) => String(entry.statement).includes('权重'));
    assert.deepEqual(conditioned?.applicability ?? null, null, JSON.stringify(row.entries.map((e) => [String(e.statement).slice(0, 20), e.applicability])));
  });

  it('reads no 仅/只 that lacks the 支持 right after the series noun, wherever it stands (closure c3 item 2)', () => {
    const sentences = [
      '该命令在所有平台都可用，仅 sy-k 平台的输出格式有差异。',
      '该命令对所有平台有效，只 sy-k 平台的日志路径有变化。',
      '各平台默认开启，仅虚拟平台的默认值为关闭。',
      '该命令仅 X9000 系列的接口名称有差异。',
      '该命令仅 sy-k 平台。',
    ];
    for (const sentence of sentences) {
      const result = undeclaredManual(markdown(`**demo pool add** *\\<name\\>*\n\n${sentence}\n`),null,{catalog:STRICT_MANUAL_CATALOG});
      const behaviour = result.entries.find((entry) => entry.data.form === 'text');
      assert.equal(behaviour?.applicability ?? null, null, `${sentence} 不散文不声明条件`);
    }
    // Former positive prose spellings also remain undeclared, wherever the sentence starts.
    for (const sentence of ['仅 sy-k 平台支持。', '该命令仅 sy-k 平台支持。', '该命令仅 X9000 系列支持。']) {
      const result = undeclaredManual(markdown(`**demo pool add** *\\<name\\>*\n\n${sentence}\n`),null,{catalog:STRICT_MANUAL_CATALOG});
      const behaviour = result.entries.find((entry) => entry.data.form === 'text');
      assert.equal(behaviour?.applicability, null, 'prose never declares applicability');
    }
  });

  it('reads no exception, widening or partly joined condition (closure findings 6, 13, 14)', () => {
    const sentences = [
      '适用于 sy-k 平台外的所有平台。',
      '适用于 sy-k 平台外的环境。',
      '适用于虚拟平台外的环境。',
      '适用于 X9000 系列外的机型。',
      '适用于 sy-k 平台外。',
      '适用于 sy-k 平台除外的环境。',
      '也可适用于 sy-k 平台。',
      '亦可适用于 sy-k 平台。',
      '同样可以适用于 sy-k 平台。',
      '还可以适用于 sy-k 平台。',
      '该命令也能适用于 sy-k 平台。',
      '适用于 sy-k 平台，以及其他平台。',
      '仅 sy-k 平台（sz-demoos10 平台亦可）支持。',
      '适用于 X9000 系列及以上机型。',
      '适用于虚拟平台和物理设备。',
      '适用于虚拟平台和物理设备以外的环境。',
      '适用于 sy-k 平台的 X9000 系列。',
      '适用于 X9000 系列的 sy-k 平台。',
    ];
    for (const sentence of sentences) {
      const result = undeclaredManual(markdown(`**demo pool add** *\\<name\\>*\n\n${sentence}\n`),null,{catalog:STRICT_MANUAL_CATALOG});
      const behaviour = result.entries.find((entry) => entry.data.form === 'text');
      assert.equal(behaviour?.applicability ?? null, null, `${sentence} 不散文不声明条件`);
    }
    // Punctuation changes no declaration status.
    const closed = undeclaredManual(markdown('**demo pool add** *\\<name\\>*\n\n适用于 sy-k 平台，sz-demoos10 平台。\n'),null,{catalog:STRICT_MANUAL_CATALOG});
    assert.deepEqual(closed.entries.find((entry) => entry.data.form === 'text')?.applicability, null, 'punctuation never makes prose a declaration');
  });


  it('reads conditions in bounded time even on hostile paragraphs (closure findings 7 and 15)', () => {
    const hostile = (word: string) => undeclaredManual(markdown(`**demo pool add** *\\<name\\>*\n\n${word}\n`),null,{catalog:STRICT_MANUAL_CATALOG});
    const started1 = Date.now();
    hostile('适用于'.repeat(20000));
    assert.ok(Date.now() - started1 < 1000, `适用于×20000 took ${Date.now() - started1} ms`);
    const started2 = Date.now();
    hostile('仅 sy-k 平台支持'.repeat(20000));
    assert.ok(Date.now() - started2 < 1000, `仅…支持×20000 took ${Date.now() - started2} ms`);
  });

  it('reads no vague, deictic, negated, exception or garbled model value (closure findings 3 and 12)', () => {
    const sentences = [
      '适用于所有型号。',
      '仅部分型号支持。',
      '适用于该系列。',
      '适用于以下机型：X9000。',
      '适用于大多数机型。',
      '适用于硬件型号。',
      '适用于 X9000 等系列。',
      '仅在 X9000 系列上支持。',
      '适用于 X9000 系列及以上机型。',
      '该功能仅支持 X9000 系列。',
      '适用于非 X9000 系列。',
      '适用于除 X9000 以外的系列。',
      '只有部分型号支持。',
      '| 适用于 | X9000 系列 |',
    ];
    for (const sentence of sentences) {
      const result = undeclaredManual(markdown(`**demo pool add** *\\<name\\>*\n\n${sentence}\n`),null,{catalog:STRICT_MANUAL_CATALOG});
      const behaviour = result.entries.find((entry) => entry.data.form === 'text' && String(entry.statement).includes(sentence.slice(0, 4)));
      assert.equal(behaviour?.applicability ?? null, null, `${sentence} 不该读出型号`);
    }
    // The readable forms still read.
    const readable = undeclaredManual(markdown('**demo pool add** *\\<name\\>*\n\n仅 X9000 系列支持。\n'),null,{catalog:STRICT_MANUAL_CATALOG});
    assert.deepEqual(readable.entries.find((entry) => entry.data.form === 'text')?.applicability, null, 'prose is undeclared even with a tight spelling');
  });

  it('reads no negated, hedged, inclusive or partly listed condition, and no exception list (second review findings 3 and 6)', () => {
    const sentences = [
      '不会适用于 sy-k 平台。',
      '不可适用于 sy-k 平台。',
      '未适用于 sy-k 平台。',
      '尚未适用于 sy-k 平台。',
      '不一定仅 sy-k 平台支持。',
      '未必仅 sy-k 平台支持。',
      '不完全仅 sy-k 平台支持。',
      '并不总是仅 sy-k 平台支持。',
      '不是仅 sy-k 平台支持。',
      '也适用于 sy-k 平台。',
      '同样适用于 sy-k 平台。',
      '适用于 sy-k 平台以及其他平台。',
      '适用于 sy-k 平台等。',
      '适用于 sy-k 平台等环境。',
      '适用于 sy-k 平台、sz-demoos10 平台等。',
      '适用于 sy-k 平台和 sz-demoos10 平台以外的所有平台。',
      '适用于 sy-k 平台和 sz-demoos10 平台之外的环境。',
      '适用于虚拟平台和物理平台以外的环境。',
      '适用于 X9000 系列和 X8000 系列以外的机型。',
      '该命令用于添加成员。',
    ];
    for (const sentence of sentences) {
      const result = undeclaredManual(markdown(`**demo pool add** *\\<name\\>*\n\n${sentence}\n`),null,{catalog:STRICT_MANUAL_CATALOG});
      const behaviour = result.entries.find((entry) => entry.data.form === 'text');
      assert.equal(behaviour?.applicability, null, `${sentence} 不散文不声明条件`);
    }
    // The readable forms still read: a coordinated list counts only when every item of it is readable.
    const readable = undeclaredManual(markdown('**demo pool add** *\\<name\\>*\n\n该命令仅适用于 sy-k 平台与 zx-demoos11 平台。\n'),null,{catalog:STRICT_MANUAL_CATALOG});
    assert.deepEqual(readable.entries.find((entry) => entry.data.form === 'text')?.applicability, null, 'a prose list remains undeclared');
    for (const join of ['与', '及', '以及', '或']) {
      const closed = undeclaredManual(markdown(`**demo pool add** *\\<name\\>*\n\n适用于 sy-k 平台${join} sz-demoos10 平台。\n`),null,{catalog:STRICT_MANUAL_CATALOG});
      assert.deepEqual(closed.entries.find((entry) => entry.data.form === 'text')?.applicability, null, `${join} joins a closed list: both items read, never only the first`);
    }
    const modelsClosed = undeclaredManual(markdown('**demo pool add** *\\<name\\>*\n\n适用于 X9000 系列及 X8000 系列。\n'),null,{catalog:STRICT_MANUAL_CATALOG});
    assert.deepEqual(modelsClosed.entries.find((entry) => entry.data.form === 'text')?.applicability, null, 'a model list in prose remains undeclared');
  });

  it('stays linear on Han runs full of 和 (no exponential backtracking)', () => {
    const hostile = `适用于${'和平'.repeat(40)}。`;
    const started = Date.now();
    undeclaredManual(markdown(`**demo pool add** *\\<name\\>*\n\n${hostile}\n`),null,{catalog:STRICT_MANUAL_CATALOG});
    assert.ok(Date.now() - started < 500, 'a hostile clause must not backtrack exponentially');
  });




  it('a parameter or enumerated-alternative cell is a value row of the current command, and the current state resets (closure c3 item 5)', () => {
    const tree = commandCatalog(xml('<commands><scope type="global"><menu name="demo"><menu name="pool"><item name="add" help_string="a"><arguments></arguments></item></menu><menu name="acl"><menu name="permit"><item name="enable"><arguments></arguments></item><item name="disable"><arguments></arguments></item></menu></menu></menu><menu name="enable"><item name="config" help_string="c"><arguments></arguments></item></menu></scope></commands>')).catalog;
    // Parameter rows under a two-parameter signature stay value rows: no definition, no drift.
    const params = undeclaredManual(markdown('**demo pool add** *\\<name\\> \\[*weight*\\]*\n\n| 参数 | 说明 |\n|---|---|\n| **weight** *\\<1-100\\>* | 权重 |\n| **name** *\\<string\\>* | 成员名 |\n'), null, { catalog: tree });
    assert.ok(!params.entries.some((entry) => entry.kind === 'definition' && String(entry.statement).startsWith('weight')), JSON.stringify(params.entries.map((e) => [e.kind, String(e.statement).slice(0, 20)])));
    assert.ok(!params.entries.some((entry) => entry.kind === 'definition' && String(entry.statement).startsWith('name')));
    assert.deepEqual(manualRelations(params,tree).drift,[]);
    // The variant tails RESET at a heading anchor: a later bold cell that happens to equal an EARLIER variant's
    // alternative is a signature again, not a value row of the unrelated current command.
    const variant = undeclaredManual(markdown('**demo acl permit {enable\\|disable}**\n\n## **demo pool add** *\\<name\\>*\n\n| command_signature@2 | 说明 |\n|---|---|\n| **enable** | 进入特权模式 |\n'), null, { catalog: tree });
    const enableDef = variant.entries.find((entry) => entry.kind === 'definition' && String(entry.statement) === 'enable');
    assert.ok(enableDef !== undefined, JSON.stringify(variant.entries.map((e) => [e.kind, e.path, String(e.statement).slice(0, 24)])));
    // While the variant signature IS current, its alternative is a value row.
    const variantCurrent = undeclaredManual(markdown('**demo acl permit {enable\\|disable}**\n\n| command_signature@2 | 说明 |\n|---|---|\n| **enable** | 进入特权模式 |\n'), null, { catalog: tree });
    assert.ok(!variantCurrent.entries.some((entry) => entry.kind === 'definition' && String(entry.statement) === 'enable'), JSON.stringify(variantCurrent.entries.map((e) => [e.kind, String(e.statement).slice(0, 24)])));
    assert.deepEqual(manualRelations(variantCurrent,tree).drift,[]);
  });


  it('a prose mention in a placed multi-command row is retained without drift, and every structural signature literal is retained (closure c3 item 6)', () => {
    const tree = commandCatalog(xml('<commands><scope type="global"><menu name="demo"><menu name="pool"><item name="add" help_string="a"><arguments></arguments></item><item name="mode" help_string="m"><arguments></arguments></item></menu></menu></scope></commands>')).catalog;
    const row = undeclaredManual(markdown('# 章\n\n## 配置命令\n\n| command_signature@2 | 说明 |\n|---|---|\n| **demo pool add** 与 **demo pool mode** | 配合，见 `demo pool gone` |\n'), null, { catalog: tree });
    assert.deepEqual(manualRelations(row,tree).drift, []);
    assert.deepEqual(row.entries.find(entry => String(entry.statement).includes('配合'))?.data.command_mentions, ['demo pool gone']);
    // The shared evaluator sees every retained group; neither old truncation flag is emitted.
    const many = Array.from({ length: 105 }, (_, i) => `**demo pool cmd${i}**`).join(' 与 ');
    const cut = undeclaredManual(markdown(`# 章\n\n## 配置命令\n\n| command_signature@2 | 说明 |\n|---|---|\n| ${many} | 说明 |\n`), null, { catalog: tree });
    const rowEntry = cut.entries.find((entry) => String(entry.statement).includes('cmd0'));
    assert.ok(rowEntry !== undefined);
    assert.equal((rowEntry.data.signature_literals as unknown[]).length,105);
    assert.equal(manualRelations(cut,tree).drift.length,105);
    assert.equal((rowEntry.data as { command_literals_cut?: boolean }).command_literals_cut, undefined, JSON.stringify(rowEntry.data));
    assert.equal((rowEntry.data as { literals_cut?: boolean }).literals_cut, undefined, 'the undocumented flag never appears');
  });


  it('a command column that is not the first column keeps every other cell of the row (cursor regression)', () => {
    const tree = commandCatalog(xml('<commands><scope type="global"><menu name="demo"><menu name="pool"><item name="add" help_string="a"><arguments></arguments></item></menu></menu></scope></commands>')).catalog;
    const swapped = undeclaredManual(markdown('# 章\n\n## 配置命令\n\n| 说明 | command_signature@2 |\n|---|---|\n| 添加成员 | **demo pool add** *\\<name\\>* |\n'), null, { catalog: tree });
    const def = swapped.entries.find((entry) => entry.kind === 'definition');
    assert.ok(def !== undefined, JSON.stringify(swapped.entries.map((e) => [e.kind, e.path])));
    assert.equal(def.path, '/commands/demo/pool/add');
    const described = swapped.entries.find((entry) => entry.kind !== 'definition' && String(entry.statement).includes('添加成员'));
    assert.ok(described !== undefined, JSON.stringify(swapped.entries.map((e) => [e.kind, String(e.statement).slice(0, 30)])));
    assert.ok(!String(described.statement).includes('demo pool add'), 'the description never becomes the signature cell');
  });

  it('a shared multi-row entry carries a condition only when every row states it (closure finding 8)', () => {
    const tree = commandCatalog(xml('<commands><scope type="global"><menu name="demo"><menu name="pool"><item name="add" help_string="a"><arguments></arguments></item></menu></menu></scope></commands>')).catalog;
    // A grid table (not split by row): one row conditioned, one not — the shared entry stays 未声明.
    const grid = undeclaredManual(markdown('**demo pool add** *\\<name\\>*\n\n+-----+-----+\n| name | 成员名 |\n+-----+-----+\n| weight | 权重，仅 sy-k 平台支持 |\n+-----+-----+\n'), null, { catalog: tree });
    const shared = grid.entries.find((entry) => String(entry.statement).includes('成员名'));
    assert.equal(shared?.applicability ?? null, null, 'a partly conditioned table never declares a condition');
    const conditioned = grid.entries.find((entry) => String(entry.statement).includes('权重'));
    if (conditioned !== undefined && conditioned !== shared) {
      assert.deepEqual(conditioned.applicability, null);
    }
    // A pipe table whose HEADER line states a condition, rows not: the shared entry stays 未声明.
    const headerOnly = undeclaredManual(markdown('**demo pool add** *\\<name\\>*\n\n| 仅 sy-k 平台支持的参数 | 说明 |\n|---|---|\n| name | 成员名 |\n| weight | 权重 |\n'), null, { catalog: tree });
    const sharedHeader = headerOnly.entries.find((entry) => entry.data.form === 'text');
    assert.equal(sharedHeader?.applicability ?? null, null, 'a header condition alone never declares the rows\' condition');
  });

  it('table row condition prose remains undeclared alongside unconditioned rows (second review findings 2 and 5)', () => {
    const tree =
      '<commands><scope type="global"><menu name="demo"><menu name="pool"><item name="add" help_string="a"><arguments></arguments></item></menu></menu></scope></commands>';
    const catalog = commandCatalog(xml(tree)).catalog;
    // A split command table: the sz row states nothing, the sy-k row states its own condition.
    const split = undeclaredManual(markdown('# 章\n\n## 配置命令\n\n| command_signature@2 | 说明 |\n|---|---|\n| **demo pool add** *\\<name\\>* | 添加成员 |\n| sy-k | 仅 sy-k 平台支持硬件加速 |\n| sz | 软件实现 |\n'), null, { catalog });
    const conditioned = split.entries.find((entry) => String(entry.statement).includes('硬件加速'));
    assert.deepEqual(conditioned?.applicability, null, 'the conditioned row reads its own condition');
    const unconditioned = split.entries.find((entry) => String(entry.statement).includes('软件实现'));
    assert.ok(unconditioned !== undefined, JSON.stringify(split.entries.map((e) => String(e.statement).slice(0, 24))));
    assert.equal(unconditioned.applicability, null, 'the unconditioned row states nothing');
    // An unsplit parameter table under an anchor: the weight row states its own condition, the name row stays null.
    const params = undeclaredManual(markdown('**demo pool add** *\\<name\\>*\n\n| 参数 | 说明 |\n|---|---|\n| name | 成员名 |\n| weight | 权重，仅 sy-k 平台支持 |\n'), null, { catalog });
    const weightRow = params.entries.find((entry) => String(entry.statement).includes('权重'));
    assert.deepEqual(weightRow?.applicability, null, 'the weight row is its own entry with its own condition');
    const nameRow = params.entries.find((entry) => String(entry.statement).includes('成员名'));
    assert.ok(nameRow !== undefined, JSON.stringify(params.entries.map((e) => String(e.statement).slice(0, 24))));
    assert.equal(nameRow.applicability, null, 'the name row inherits nothing');
  });

  it('retains conflicting prose without fabricating declarations or declaration conflicts', () => {
    const result = undeclaredManual(markdown('## 仅 sy-k 平台支持\n\n适用于 sz-demoos10 平台的功能。\n\n本节的另一段。\n\n### 小节\n\n子节的一段。\n'),null,{catalog:STRICT_MANUAL_CATALOG});
    const [own, other, sub] = result.entries;
    for(const entry of [own,other,sub]){assert.equal(entry.applicability,null);assert.equal(entry.fragments.flatMap(fragment=>fragment.applicability??[]).filter(origin=>origin.conflict).length,0);}
  });

  it('does not inherit a prose heading condition into signatures or their body', () => {
    const result = undeclaredManual(markdown('## 仅 sy-k 平台支持\n\n**demo pool add** *\\<name\\>*\n\n该命令用于添加成员。\n'),null,{catalog:STRICT_MANUAL_CATALOG});
    assert.ok(result.entries.every(entry => entry.applicability === null));
  });

  it('keeps prose conditions undeclared on a command block and its siblings', () => {
    const result = undeclaredManual(markdown('## 命令\n\n**demo pool add** *\\<name\\>*\n\n该命令仅适用于 sy-k 平台。\n\n**demo pool mode** *\\<name\\>*\n\n该命令用于设置算法。\n'),null,{catalog:STRICT_MANUAL_CATALOG});
    const [add, addText, mode, modeText] = result.entries;
    assert.equal(add.applicability, null, 'the opening ended at the first anchor');
    assert.deepEqual(addText.applicability, null);
    assert.equal(mode.applicability, null);
    assert.equal(modeText.applicability, null, 'no leak to a sibling command');
  });

  it('never reads a negation, a vague or deictic word, an exception or a partial list as a condition', () => {
    const sentences = [
      '不适用于 sy-k 平台。',
      '不再适用于 sy-k 平台。',
      '无法适用于 sy-k 平台。',
      '不能适用于 sy-k 平台。',
      '并非适用于 sy-k 平台。',
      '仅 sy-k 平台不支持。',
      '不仅 sy-k 平台支持，sz-demoos10 平台也支持。',
      '适用于 sy-k 平台以外的所有平台。',
      '适用于 sy-k 平台之外的环境。',
      '部分平台支持本功能。',
      '适用于大多数平台。',
      '适用于所有硬件平台。',
      '适用于部分硬件平台。',
      '适用于该平台。',
      '适用于上述平台。',
      '适用于全部平台。',
      '仅特定平台支持。',
      '仅少量平台支持。',
      '适用于以下平台：sy-k、sz-demoos10。',
      '适用于 sy-k 和其他平台。',
      '适用于非虚拟平台。',
      '没有某部件时不适用。',
      '适用于 FAMX 系列。',
      '适用于 FAMY、X9000 系列。',
    ];
    for (const sentence of sentences) {
      const result = undeclaredManual(markdown(`# 章\n\n${sentence}\n`),null,{catalog:STRICT_MANUAL_CATALOG});
      assert.ok(result.entries.every((entry) => entry.applicability === null), sentence);
    }
    // Former positive forms still remain prose, even when their values occur in deployment closed sets.
    const positive = undeclaredManual(markdown('# 章\n\n适用于 sy-k 平台和 sz-demoos10 平台。\n\n仅虚拟平台支持。\n\n适用于 X9000、X8000 机型。\n'),null,{catalog:STRICT_MANUAL_CATALOG});
    assert.deepEqual(positive.entries[0].applicability, null);
    assert.deepEqual(positive.entries[1].applicability, null);
    assert.deepEqual(positive.entries[2].applicability, null);
  });

  it('leaves applicability null when nothing declares a condition', () => {
    assert.ok(undeclaredManual(markdown('# Plain\n\n普通说明。'),null,{catalog:STRICT_MANUAL_CATALOG}).entries.every((entry) => entry.applicability === null));
  });
});
