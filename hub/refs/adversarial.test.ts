import {testParsers as defaultParsers} from "../testing/parsers.ts";
import {createTestParserRegistry as createDefaultRegistry} from '../testing/parsers.ts';
import { kityminderParser, xmlParser, htmlParser } from '../testing/parsers.ts';
// Adversarial inputs for every core parser: large inputs that must scale linearly, nesting and entity attacks, invalid
// UTF-8, NUL and control characters, attribute bombs and random bytes. A parser either succeeds or throws a ParseError.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {ParseEncodingError,ParseError,ParseForbiddenError,ParseLimitError,ParseSyntaxError,candidatesFrom,createDocumentCache,findQuote,jsonParser,markdownParser,resolveReference,srcFragment,textParser,type Parser} from "./api.ts";
import { assertLinearGrowth } from '../testing/growth.ts';
import { fixture, seeded, timed, utf8 } from './test-support.ts';

const MB = 1024 * 1024;
// A 10 MB input takes about 0.1-2.5 s locally and up to about 5 s on a CI runner. The ceiling is a catastrophic guard
// (a hang or an exponential blow-up), about ten times that; super-linear time is caught by the growth check instead,
// which compares the CPU time of the same input at two sizes and so does not depend on how fast or busy the runner is.
const CEILING_MS = 60_000;
// Growth is measured between 128 KB and 1 MB (factor 8): large enough to be well above timer noise, small enough to
// repeat. Any cost quadratic in the input is already dominant at these sizes.
const GROWTH_SMALL = 128 * 1024;

function fill(unit: string, bytes: number): string {
  return unit.repeat(Math.ceil(bytes / Buffer.byteLength(unit)));
}

function bounded(parser: Parser, input: Uint8Array, bound: number, options = {}): ReturnType<typeof timed> {
  const outcome = timed(() => parser.parse(input, options));
  assert.ok(outcome.ms < bound, `${parser.id} took ${outcome.ms.toFixed(0)} ms on ${input.length} bytes`);
  if (outcome.error !== null) assert.ok(outcome.error instanceof ParseError, `${parser.id}: ${String(outcome.error)}`);
  return outcome;
}

/** Parses the 10 MB input under the catastrophic ceiling, then checks that the cost grows linearly with the size. */
function scaled(parser: Parser, make: (bytes: number) => Uint8Array, options = {}): ReturnType<typeof timed> {
  const outcome = bounded(parser, make(10 * MB), CEILING_MS, options);
  assertLinearGrowth(parser.id, make, (input) => parser.parse(input, options), { small: GROWTH_SMALL });
  return outcome;
}

/** Scales a count chosen for a 10 MB input to an input of `bytes` bytes. */
function per10MB(count: number, bytes: number): number {
  return Math.max(1, Math.round((count * bytes) / (10 * MB)));
}

describe('10 MB inputs parse within the ceiling and in linear time', () => {
  it('kityminder@1', () => {
    const map = (bytes: number): Uint8Array => {
      const children = Array.from({ length: per10MB(40_000, bytes) }, (_, i) => ({ data: { id: `c${i}`, text: `用例标题 ${'文字'.repeat(20)} ${i}`, priority: 2, resource: ['smoke'] }, children: [{ data: { id: `e${i}`, text: '期望结果' } }] }));
      return utf8(JSON.stringify({ root: { data: { id: 'r', text: 'root' }, children } }));
    };
    assert.ok(map(10 * MB).length > 8 * MB);
    const outcome = scaled(kityminderParser, map);
    assert.equal(outcome.error, null);
  });

  it('xml@1', () => {
    const item = '<item name="add" help="Create"><arguments><arg name="pool_name" type="STRING" length="32" optional="0" help="Name of the pool"/></arguments></item>\n';
    const outcome = scaled(xmlParser, (bytes) => utf8(`<commands><scope name="g"><menu name="m">${fill(item, bytes)}</menu></scope></commands>`));
    assert.equal(outcome.error, null);
  });

  it('html@1', () => {
    const entry = '<font color=red>Rel_X_1 (build on  2026-01-01 ): Released on 2026-01-02</font> </br><BLOCKQUOTE><A href=a.array>image</A> ( 42M )<BR></BLOCKQUOTE><hr>\n';
    const outcome = scaled(htmlParser, (bytes) => utf8(`<html><body>${fill(entry, bytes)}</body></html>`));
    assert.equal(outcome.error, null);
  });

  it('markdown@1', () => {
    // Realistic line lengths: the line limit (1M lines) is far above real manuals, which run 40-80 bytes per line.
    const unit =
      '## 小节：会话保持的配置与验证\n\n一段说明文字，描述会话保持的行为、超时与异常处理，用来测试大文件的解析速度。\n\n' +
      '+--------------+------------------------------+\n| 参数         | 说明                         |\n+--------------+------------------------------+\n\n' +
      '- 列表项：按源地址保持会话\n- 列表项：按 Cookie 保持会话\n\n```\n# 代码块里的井号不是标题\n```\n\n';
    const outcome = scaled(markdownParser, (bytes) => utf8(fill(unit, bytes)));
    assert.equal(outcome.error, null);
  });

  it('json@1 and text@1', () => {
    const json = (bytes: number): Uint8Array => utf8(JSON.stringify(Array.from({ length: per10MB(220_000, bytes) }, (_, i) => ({ id: i, name: `名称${i}`, tags: ['a', 'b'] }))));
    assert.ok(json(10 * MB).length > 8 * MB);
    assert.equal(scaled(jsonParser, json).error, null);
    assert.equal(scaled(textParser, (bytes) => utf8(fill('a line of text 一行文字\n', bytes))).error, null);
  });

  it('refuses input above the byte limit before decoding it', () => {
    const big = new Uint8Array(17 * MB).fill(0x61);
    for (const parser of defaultParsers()) {
      const outcome = bounded(parser, big, 1_000);
      assert.ok(outcome.error instanceof ParseLimitError && outcome.error.limit === 'maxBytes', parser.id);
    }
  });
});

describe('pathological 10 MB inputs are refused or parsed within the ceiling and in linear time', () => {
  const cases: Array<[string, Parser, (bytes: number) => Uint8Array, (error: unknown) => boolean]> = [
    ['deep XML', xmlParser, (bytes) => utf8(fill('<a>', bytes)), (e) => e instanceof ParseLimitError && e.limit === 'maxDepth'],
    ['deep HTML', htmlParser, (bytes) => utf8(fill('<div>', bytes)), (e) => e instanceof ParseLimitError && e.limit === 'maxDepth'],
    ['deep nested lists in HTML', htmlParser, (bytes) => utf8(fill('<ul><li>', bytes)), (e) => e instanceof ParseLimitError && e.limit === 'maxDepth'],
    ['deep JSON', jsonParser, (bytes) => utf8('['.repeat(bytes / 2) + ']'.repeat(bytes / 2)), (e) => e instanceof ParseLimitError && e.limit === 'maxDepth'],
    ['deep mind map', kityminderParser, (bytes) => utf8(fill('{"root":{"children":[', (bytes * 9) / 10)), (e) => e instanceof ParseSyntaxError || e instanceof ParseLimitError],
    ['one HTML tag with a million attributes', htmlParser, (bytes) => utf8(`<i ${fill('x ', bytes)}>`), (e) => e instanceof ParseLimitError && e.limit === 'maxAttributes'],
    ['one XML tag with a million attributes', xmlParser, (bytes) => utf8(`<i ${Array.from({ length: per10MB(1_200_000, bytes) }, (_, i) => `a${i}="1"`).join(' ')}/>`), (e) => e instanceof ParseLimitError && e.limit === 'maxAttributes'],
    ['an XML quote storm', xmlParser, (bytes) => utf8(`<a ${fill('b="x "y" ', bytes)}/>`), (e) => e instanceof ParseError],
    ['10 MB of <', xmlParser, (bytes) => utf8(fill('<', bytes)), (e) => e instanceof ParseSyntaxError],
    ['a 10 MB JSON string of quotes', kityminderParser, (bytes) => utf8(JSON.stringify(fill('"', bytes / 2))), (e) => e instanceof ParseSyntaxError],
    ['too many lines', textParser, (bytes) => utf8(fill('\n', bytes)), (e) => e instanceof ParseLimitError && e.limit === 'maxNodes'],
    ['XML attribute values that never close', xmlParser, (bytes) => utf8(`<r>${fill('<a b="', bytes)}`), (e) => e instanceof ParseError],
    ['XML attribute values that never close, single quotes', xmlParser, (bytes) => utf8(`<r>${fill("<a b='", bytes)}`), (e) => e instanceof ParseError],
    ['an attribute bomb inside select', htmlParser, (bytes) => utf8(`<select><plaintext><p ${fill('a ', bytes)}>`), (e) => e instanceof ParseLimitError && e.limit === 'maxAttributes'],
    ['nested templates', htmlParser, (bytes) => utf8(fill('<template>', bytes)), (e) => e instanceof ParseLimitError && e.limit === 'maxDepth'],
    ['repeated body tags with new attributes', htmlParser, (bytes) => utf8(Array.from({ length: per10MB(2_000, bytes) }, (_, t) => `<body ${Array.from({ length: 500 }, (_, i) => `b${t}_${i}`).join(' ')}>`).join('')), (e) => e instanceof ParseLimitError && e.limit === 'maxAttributes'],
    ['foster-parented text before a table', htmlParser, (bytes) => utf8(`<table>${fill('x<b>y</b>', bytes)}`), (e) => e instanceof ParseLimitError],
    ['misnested formatting around tables', htmlParser, (bytes) => utf8(fill('<a><table><a>', bytes)), (e) => e instanceof ParseLimitError],
    ['text deep inside formatting elements', htmlParser, (bytes) => utf8(`<p>${'<b>'.repeat(250)}${fill('<i>x</i>', bytes)}`), (e) => e instanceof ParseLimitError],
    ['a long heading over many blocks', markdownParser, (bytes) => utf8(`# ${'h'.repeat(20_000)}\n\n${fill('p\n\n', bytes)}`), (e) => e instanceof ParseLimitError],
  ];
  for (const [name, parser, input, expected] of cases) {
    it(`${name} (${parser.id})`, () => {
      const outcome = scaled(parser, input);
      assert.ok(expected(outcome.error), `${name}: ${String(outcome.error)}`);
    });
  }

  it('accepts what is merely unusual, within the ceiling and in linear time', () => {
    const accepted: Array<[string, Parser, (bytes: number) => Uint8Array]> = [
      ['many tags with 500 attributes each', htmlParser, (bytes) => utf8(`<html><body>${fill(`<i ${Array.from({ length: 500 }, (_, i) => `a${i}`).join(' ')}></i>`, bytes)}`)],
      ['a 10 MB heading line', markdownParser, (bytes) => utf8(`# ${fill('a # ', bytes)}x`)],
      ['a 10 MB pipe line', markdownParser, (bytes) => utf8(fill('| a ', bytes))],
      ['dash rules and text', markdownParser, (bytes) => utf8(fill('---\ntext\n', (bytes * 3) / 10))],
      ['an unclosed fence', markdownParser, (bytes) => utf8(`\`\`\`\n${fill('# 代码里的一行，不是标题\n', bytes)}`)],
      ['a 10 MB single line', textParser, (bytes) => utf8(fill('x', bytes))],
      ['10 MB of <', htmlParser, (bytes) => utf8(fill('<', bytes))],
      ['10 MB of nested quotes in a value', htmlParser, (bytes) => utf8(`<a title="${fill("'", bytes)}">x</a>`)],
      ['10 MB of headings with long runs of spaces', markdownParser, (bytes) => utf8(fill(`# a${' '.repeat(100_000)}b\n`, bytes))],
    ];
    for (const [name, parser, input] of accepted) {
      const outcome = scaled(parser, input);
      assert.equal(outcome.error, null, `${name}: ${String(outcome.error)}`);
    }
  });
});

describe('entity expansion attempts', () => {
  it('refuses billion laughs, quadratic blowup and external entities before expanding anything', () => {
    const laughs = ['<!ENTITY lol "lol">', ...Array.from({ length: 9 }, (_, i) => `<!ENTITY lol${i + 1} "${`&lol${i || ''};`.repeat(10)}">`)].join('');
    const attempts = [
      `<?xml version="1.0"?><!DOCTYPE lolz [${laughs}]><lolz>&lol9;</lolz>`,
      `<!DOCTYPE x [<!ENTITY a "${'x'.repeat(100_000)}">]><x>${'&a;'.repeat(100_000)}</x>`,
      '<!DOCTYPE x [<!ENTITY ext SYSTEM "file:///etc/passwd">]><x>&ext;</x>',
      '<!DOCTYPE x [<!ENTITY % p SYSTEM "http://192.0.2.1/evil.dtd"> %p;]><x/>',
    ];
    for (const xml of attempts) {
      const outcome = bounded(xmlParser, utf8(xml), CEILING_MS);
      assert.ok(outcome.error instanceof ParseForbiddenError, xml.slice(0, 40));
    }
  });

  it('leaves undefined entity references unexpanded and refused', () => {
    assert.throws(() => xmlParser.parse(utf8('<x>&lol9;</x>')), ParseSyntaxError);
    const html = htmlParser.parse(utf8('<!DOCTYPE x [<!ENTITY a "boom">]><p>&a; &amp;</p>'));
    assert.ok(html.model.blocks.some((block) => block.text.includes('&a; &')), 'HTML has no entity declarations: &a; stays literal');
  });
});

describe('invalid UTF-8', () => {
  const sequences: Array<[string, number[]]> = [
    ['a lone continuation byte', [0x80]],
    ['an overlong slash', [0xc0, 0xaf]],
    ['an overlong NUL', [0xe0, 0x80, 0x80]],
    ['a UTF-16 surrogate', [0xed, 0xa0, 0x80]],
    ['a code point above U+10FFFF', [0xf4, 0x90, 0x80, 0x80]],
    ['a truncated sequence', [0xe4, 0xb8]],
    ['an invalid lead byte', [0xff]],
  ];
  const utf8Parsers = [kityminderParser, jsonParser, markdownParser, textParser, xmlParser];
  for (const [name, bad] of sequences) {
    it(`refuses ${name} with its byte offset`, () => {
      for (const parser of utf8Parsers) {
        const prefix = parser === xmlParser ? '<a>' : parser === markdownParser || parser === textParser ? 'ok ' : '"';
        const input = new Uint8Array([...utf8(prefix), ...bad, ...utf8(parser === xmlParser ? '</a>' : '"')]);
        assert.throws(
          () => parser.parse(input),
          (error: unknown) => error instanceof ParseEncodingError && error.offset === prefix.length,
          `${parser.id}: ${name}`,
        );
      }
      assert.throws(() => htmlParser.parse(new Uint8Array([...utf8('<p>'), ...bad]), { mediaType: 'text/html; charset=utf-8' }), ParseEncodingError);
    });
  }
});

describe('NUL and control characters', () => {
  const controls = '\u0001\u0002\u0007\u0008\u000b\u000c\u001b\u007f';

  it('removes NUL but keeps other control characters in text formats', async () => {
    const text = textParser.parse(utf8(`a\u0000b${controls}c\n`));
    assert.equal(text.model.lines[0], `ab${controls}c`);
    const markdown = markdownParser.parse(utf8(`# 标\u0000题\n\n段\u0000落${controls}\n`));
    assert.equal((await markdown.locate('b/0/标题'))!.text, `段落${controls}`);
    const html = htmlParser.parse(utf8(`<p>a\u0000b${controls}</p>`));
    assert.ok(!html.model.blocks[0].text.includes('\u0000'));
    const json = jsonParser.parse(utf8(JSON.stringify({ k: `a\u0000b${controls}` })));
    assert.deepEqual(json.model, { k: `ab${controls}` });
    const map = kityminderParser.parse(utf8(JSON.stringify({ root: { data: { id: 'r', text: `a\u0000b${controls}` } } })));
    assert.equal(map.model.nodes[0].text, `ab${controls}`);
  });

  it('refuses raw control characters where the format forbids them', () => {
    assert.throws(() => xmlParser.parse(utf8('<a>\u0000</a>')), ParseSyntaxError);
    assert.throws(() => xmlParser.parse(utf8('<a>\u0001</a>')), ParseSyntaxError);
    assert.throws(() => xmlParser.parse(utf8('<a>&#0;</a>')), ParseSyntaxError);
    assert.throws(() => jsonParser.parse(utf8('{"k":"a\u0001b"}')), ParseSyntaxError);
    assert.throws(() => kityminderParser.parse(utf8('{"root":{"data":{"text":"a\u0000b"}}}')), ParseSyntaxError);
  });
});

describe('random bytes', () => {
  it('every parser either parses or throws a ParseError on 1500 random and corrupted inputs', async () => {
    const r = seeded(1021);
    const seeds = [fixture('mindmap.km.json'), fixture('command-tree.xml'), fixture('listing.html'), fixture('spec.md')];
    const parsers = defaultParsers();
    for (let i = 0; i < 1500; i++) {
      let input: Uint8Array;
      if (r.chance(0.4)) {
        input = Uint8Array.from({ length: r.int(600) }, () => r.int(256));
      } else {
        const base = r.pick(seeds);
        const copy = Uint8Array.from(base.subarray(0, Math.min(base.length, 4096)));
        for (let k = 0; k < 1 + r.int(8); k++) copy[r.int(copy.length)] = r.pick([0x3c, 0x3e, 0x22, 0x27, 0x26, 0x00, 0xff, 0x0a, 0x7b, 0x7d, 0x5b, 0x5d, 0x23, 0x7c, r.int(256)]);
        input = copy;
      }
      for (const parser of parsers) {
        try {
          const document = parser.parse(input);
          for (const selector of document.listSelectors('', { limit: 20 })) assert.ok((await document.locate(selector)), `${parser.id} lists ${selector} but cannot locate it`);
          JSON.stringify(document.model);
          JSON.stringify(document.summary());
        } catch (error) {
          assert.ok(error instanceof ParseError, `${parser.id} threw ${String(error)}`);
        }
      }
    }
  });
});

// Parsing is not the only cost: listing, locating, quotation candidates, quotation search and resolution must stay
// linear too on inputs that parse (long names over many nodes, deep nesting, wide siblings, many links).
describe('every public API stays within the time bound on hostile input that parses', () => {
  const PIPELINE_BOUND_MS = 6_000;
  const names = Array.from({ length: 3 }, (_, i) => `n${i}${'q'.repeat(400)}`);
  let deepJson: unknown = Array.from({ length: 100_000 }, (_, i) => `v${i}`);
  for (let depth = 0; depth < 99; depth++) deepJson = [deepJson];
  const inputs: Array<[string, Parser, () => Uint8Array]> = [
    ['XML: long names over 20000 leaves', xmlParser, () => utf8(`${names.map((n) => `<${n}>`).join('')}${'<l a="1"/>'.repeat(20_000)}${[...names].reverse().map((n) => `</${n}>`).join('')}`)],
    ['XML: 1 MB of text 60 levels deep', xmlParser, () => utf8(`${'<a>'.repeat(60)}${`<t>${'x '.repeat(500)}</t>`.repeat(1_000)}${'</a>'.repeat(60)}`)],
    ['XML: 40000 siblings', xmlParser, () => utf8(`<r>${'<i/>'.repeat(40_000)}</r>`)],
    ['HTML: 200000 links in one block', htmlParser, () => utf8(`<p>${'<a href=x>y </a>'.repeat(200_000)}`)],
    ['HTML: foster-parented text', htmlParser, () => utf8(`<table>${'x<b>y</b>'.repeat(100_000)}`)],
    ['Markdown: a long heading over 40000 blocks', markdownParser, () => utf8(`# ${'h'.repeat(20_000)}\n\n${'p\n\n'.repeat(40_000)}# short\n\ntext\n`)],
    ['Markdown: 40000 sections', markdownParser, () => utf8(Array.from({ length: 40_000 }, (_, i) => `# 标题 ${i}\n\n的 段落\n`).join('\n'))],
    ['JSON: 100000 values 100 levels deep', jsonParser, () => utf8(JSON.stringify(deepJson))],
    ['mind map: 50000 nodes', kityminderParser, () => utf8(JSON.stringify({ root: { data: { id: 'r', text: 'root' }, children: Array.from({ length: 50_000 }, (_, i) => ({ data: { id: `c${i}`, text: `用例 ${i}`, note: 'a b' } })) } }))],
    ['text: 200000 lines', textParser, () => utf8('a b\n'.repeat(200_000))],
  ];
  for (const [name, parser, make] of inputs) {
    it(name, async () => {
      const bytes = make();
      const sha = createHash('sha256').update(bytes).digest('hex');
      const start = performance.now();
      const document = parser.parse(bytes);
      const selectors = document.listSelectors('', { properties: true });
      for (const selector of selectors) assert.ok((await document.locate(selector)), `${name}: ${selector}`);
      const candidates = (await candidatesFrom(document, sha, { properties: true }));
      for (const quote of ['x', 'a b', 'y', '的', 'no such text']) findQuote(candidates, quote);
      const ctx = {
        reader: { user: 'usr_01hzzzzzzzzzzzzzzzzzzzzzza', role: 'user' as const },
        parsers: createDefaultRegistry(),
        documents: createDocumentCache(),
        sources: { read: () => ({ bytes, mediaType: parser.mediaTypes[0].replace('/*', '/plain'), size: bytes.length, readTier: 'model_readable' as const }) },
      };
      for (const selector of [selectors[0], selectors[Math.floor(selectors.length / 2)], selectors[selectors.length - 1]]) {
        const result = await resolveReference(srcFragment(sha, `${parser.id}@${parser.version}`, selector), ctx);
        assert.ok(result.resolved, `${name}: ${selector}`);
      }
      const ms = performance.now() - start;
      assert.ok(ms < PIPELINE_BOUND_MS, `${name} took ${ms.toFixed(0)} ms`);
    });
  }
});
