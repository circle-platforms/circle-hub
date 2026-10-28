import { htmlParser, kityminderParser, xmlParser } from '../testing/parsers.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  candidatesFrom, collapseWhitespace, findQuote, jsonParser, locateQuote, markdownParser, quoteMatches, sliceUtf8, textParser, type Parser, type QuoteCandidate, type QuoteSearch } from './api.ts';
import { fixture, seeded, sha256, timed, utf8 } from './test-support.ts';

const FRAGMENT = '超时时间设为 0 时，配置被拒绝。\r\n提示：参数超出范围 1-3600（Timeout）。';

describe('quoteMatches', () => {
  const matching: Array<[string, string]> = [
    ['NBSP', '超时时间设为 0 时'],
    ['tabs', '超时时间设为\t0\t\t时'],
    ['CRLF across lines', '配置被拒绝。\r\n提示：'],
    ['LF across lines', '配置被拒绝。\n提示：'],
    ['ideographic space', '超时时间设为　0　时'],
    ['runs of spaces', '超时时间设为    0   时'],
    ['leading and trailing white space', '  \n\t参数超出范围 1-3600　 '],
    ['the whole fragment', FRAGMENT],
    ['line separator and NEL', '超时时间设为 0\u0085时'],
  ];
  for (const [name, quote] of matching) {
    it(`matches exact ${name}`, () => assert.ok(quoteMatches(`before:${quote}:after`, quote)));
  }

  const different: Array<[string, string]> = [
    ['case', 'timeout'],
    ['ASCII comma for the full-width one', '超时时间设为 0 时,配置被拒绝'],
    ['ASCII colon for the full-width one', '提示:参数超出范围'],
    ['full-width digits', '参数超出范围 １-３６００'],
    ['ASCII parentheses', '1-3600(Timeout)'],
    ['a different digit', '超出范围 1-3601'],
    ['white space added inside a Latin word', 'Time out'],
    ['white space removed between Latin words', 'set100'],
    ['a dropped character', '超时间设为'],
    ['an empty quote', ''],
    ['white space only', '  　\t\r\n'],
  ];
  for (const [name, quote] of different) {
    it(`does not match with ${name}`, () => assert.equal(quoteMatches(FRAGMENT, quote), false));
  }

  it('rejects whitespace substitutions, including deletion beside W/F characters', () => {
    for (const [fragment, quote] of [
      ['页面\r\n跳转', '页面跳转'],
      ['页面\r\n跳转', '页面 跳转'],
      ['中 \n A', '中A'],
      ['Ａ \n B', 'ＡB'],
      ['a b', 'a  b'],
      ['a\tb', 'a b'],
      ['a\u00a0b', 'a b'],
      ['a\u3000b', 'a b'],
      ['abc', ' abc'],
      ['abc', 'abc '],
    ]) assert.equal(quoteMatches(fragment, quote), false, JSON.stringify([fragment, quote]));
  });

  it('rejects whitespace-only quotes even when the fragment contains them', () => {
    for (const quote of [' ', '\t\r\n', '\u00a0', '\u3000', '\u0085\u2028\u2029']) {
      assert.equal(quoteMatches(`中${quote}文`, quote), false, JSON.stringify(quote));
      assert.equal(locateQuote(`中${quote}文`, quote), null, JSON.stringify(quote));
    }
  });

  it('keeps Unicode normalization forms significant', () => {
    assert.equal(quoteMatches('café', 'café'), false);
    assert.ok(quoteMatches('café', 'café'));
  });

  it('keeps zero-width and format characters significant', () => {
    assert.equal(quoteMatches('ab', 'a​b'), false);
  });

  it('never matches half of a character', () => {
    assert.equal(quoteMatches('ok 😀 ok', '\ude00'), false);
    assert.equal(quoteMatches('ok 😀 ok', '\ud83d'), false);
    assert.equal(locateQuote('ok 😀 ok', '\ude00'), null);
    assert.ok(quoteMatches('ok 😀 ok', '😀'));
  });

  it('collapses white space', () => {
    assert.equal(collapseWhitespace(' a  　 b\r\n\tc '), 'a b c');
    assert.equal(collapseWhitespace(''), '');
    assert.equal(collapseWhitespace('　'), '');
  });
});

// hub/rules checks quotations with its own quoteMatches; both packages must pass the same vectors (hub/rules README).
describe('the verbatim quotation vectors shared with hub/rules', () => {
  type Vector = { note: string; fragment: string; quote: string; match: boolean };
  const file = new URL('../rules/quote-vectors.json', import.meta.url);
  const vectors = (JSON.parse(readFileSync(file, 'utf8')) as { vectors: Vector[] }).vectors;
  it(`agrees on all ${vectors.length} vectors`, () => {
    assert.ok(vectors.length >= 20);
    for (const vector of vectors) assert.equal(quoteMatches(vector.fragment, vector.quote), vector.match, vector.note);
  });
});

// The two survivors of the acceptance mutation check (M12: case-insensitive matching, M17: an empty quote matches
// anything) live in this matcher: the shared vectors already say no; these assertions name them so a regression in
// either direction fails with the mutation's name, not just a vector number.
describe('the refs-side verbatim matcher names its invariants', () => {
  it('case stays significant', () => {
    assert.equal(quoteMatches('Show Version', 'show version'), false);
    assert.equal(quoteMatches('设置 3 区浇灌 15 分钟', '设置 3 区浇灌 15 分钟'), true);
  });
  it('the empty quote and a white-space-only quote never match, not even the empty fragment', () => {
    assert.equal(quoteMatches('abc', ''), false);
    assert.equal(quoteMatches('', ''), false);
    assert.equal(quoteMatches('abc', ' \n\t'), false);
    assert.equal(locateQuote('abc', ''), null);
  });
});

// The streaming matcher must agree with raw substring search and pin the exact original bytes.
describe('the matcher against the definition', () => {
  const ALPHABET = ['a', 'b', ' ', '  ', '\t', '\n', '\r\n', '　', ' ', '中', '文', '😀', '​', 'ab', 'a b'];
  const randomText = (r: ReturnType<typeof seeded>, max: number): string => Array.from({ length: r.int(max) }, () => r.pick(ALPHABET)).join('');
  it('agrees on 4000 random fragments and quotes, and locates each match exactly', () => {
    const r = seeded(331);
    for (let i = 0; i < 4000; i++) {
      const fragment = randomText(r, 24);
      const quote = r.chance(0.5) ? randomText(r, 6) : fragment.slice(r.int(fragment.length + 1), r.int(fragment.length + 1) + 1 + r.int(8));
      // A slice may cut a surrogate pair: such a quotation is not text and never matches.
      const expected = quote.isWellFormed() && /[^\p{White_Space}]/u.test(quote) && fragment.includes(quote);
      assert.equal(quoteMatches(fragment, quote), expected, JSON.stringify([fragment, quote]));
      const location = locateQuote(fragment, quote);
      assert.equal(location !== null, expected);
      if (location === null) continue;
      const slice = sliceUtf8(fragment, location.from, location.to);
      assert.equal(slice, quote, JSON.stringify([fragment, quote, slice]));
      let count = 0;
      for (let at = fragment.indexOf(quote); at >= 0; at = fragment.indexOf(quote, at + 1)) count++;
      assert.equal(location.occurrences, count);
    }
  });
});

describe('locateQuote', () => {
  it('maps the match back to UTF-8 byte offsets of the original text', () => {
    const location = locateQuote(FRAGMENT, '配置被拒绝。\r\n提示：参数');
    assert.ok(location);
    const slice = sliceUtf8(FRAGMENT, location.from, location.to);
    assert.equal(slice, '配置被拒绝。\r\n提示：参数');
    assert.equal(location.occurrences, 1);
  });

  it('counts occurrences and takes the first', () => {
    const text = 'a b a  b a\tb';
    const location = locateQuote(text, 'a b');
    assert.deepEqual(location, { from: 0, to: 3, occurrences: 1 });
  });

  it('returns null when absent or empty', () => {
    assert.equal(locateQuote(FRAGMENT, 'missing'), null);
    assert.equal(locateQuote(FRAGMENT, '   '), null);
  });

  it('handles astral characters', () => {
    const text = '前😀 后　😀';
    const location = locateQuote(text, '😀 后　😀');
    assert.ok(location);
    assert.equal(sliceUtf8(text, location.from, location.to), '😀 后　😀');
  });

  it('pins the exact submitted UTF-8 bytes and counts only identical occurrences', () => {
    const quote = '😀\t中\r\n\u00a0\u3000后';
    const text = `前${quote}；${quote}`;
    const from = utf8('前').length;
    const to = from + utf8(quote).length;
    assert.deepEqual(locateQuote(text, quote), { from, to, occurrences: 2 });
    assert.equal(locateQuote(text, quote.replace('\t', ' ')), null);
    assert.equal(Buffer.from(text).subarray(from, to).toString('utf8'), quote);
    assert.equal(sliceUtf8(text, from, to), quote);
    const found = findQuote([{ reference: `src:${'a'.repeat(64)}/text@1/l/1`, text }], quote);
    assert.equal(found.resolution, 'resolved');
    assert.deepEqual(found.matches[0].location, { from, to, occurrences: 2 });
    assert.ok(found.matches[0].ranged.endsWith(`:${from}-${to}`));
    assert.equal(sliceUtf8(text, from, to), quote);
  });
});

describe('findQuote', () => {
  const S = 'a'.repeat(64);
  const T = 'b'.repeat(64);
  const candidates: QuoteCandidate[] = [
    { reference: `src:${S}/markdown@1/h/超时`, text: '### 超时\n\n超时时间以秒计。设为 0 时配置被拒绝。', source: S, byteRange: [0, 80], role: 'expected' },
    { reference: `src:${S}/markdown@1/b/0/超时`, text: '超时时间以秒计。设为 0 时配置被拒绝。', source: S, byteRange: [12, 80], role: 'expected' },
    { reference: `src:${T}/kityminder@1/n/c1`, text: '超时时间设为 0 被拒绝', source: T, byteRange: null, role: 'subject' },
    { reference: `src:${T}/kityminder@1/n/c2`, text: '超时时间设为 3601 被拒绝', source: T, byteRange: null, role: 'subject' },
  ];

  it('resolves a quotation found in one place, preferring the innermost fragment', () => {
    const result = findQuote(candidates, '设为 0 时配置被拒绝');
    assert.equal(result.resolution, 'resolved');
    assert.equal(result.total, 1);
    assert.equal(result.matches[0].reference, `src:${S}/markdown@1/b/0/超时`);
    assert.equal(result.matches[0].role, 'expected');
    const ranged = result.matches[0].ranged;
    assert.match(ranged, /:\d+-\d+$/);
    const [from, to] = ranged.slice(ranged.lastIndexOf(':') + 1).split('-').map(Number);
    assert.equal(sliceUtf8(candidates[1].text, from, to), '设为 0 时配置被拒绝');
  });

  it('reports ambiguity when the quotation occurs in several places', () => {
    const result = findQuote(candidates, '被拒绝');
    assert.equal(result.resolution, 'ambiguous');
    assert.equal(result.total, 3);
    assert.match(result.diagnostics[0], /3 处/);
    const limited = findQuote(candidates, '被拒绝', { limit: 1 });
    assert.equal(limited.matches.length, 1);
    assert.equal(limited.total, 3);
  });

  it('reports unresolved quotations', () => {
    const result = findQuote(candidates, '设为 0 时配置被接受');
    assert.equal(result.resolution, 'unresolved');
    assert.equal(result.matches.length, 0);
    assert.equal(findQuote(candidates, ' ').resolution, 'unresolved');
  });

  it('resolves against every fragment of a parsed document', async () => {
    const bytes = fixture('spec.md');
    const document = markdownParser.parse(bytes);
    const found = findQuote((await candidatesFrom(document, sha256(bytes), { role: 'expected' })), '超时时间以秒计。设为 0 时配置被拒绝。');
    assert.equal(found.resolution, 'resolved');
    assert.equal(found.matches[0].reference, `src:${sha256(bytes)}/markdown@1/b/1/概述/功能说明/超时`);
    assert.equal(found.matches[0].role, 'expected');
    assert.equal(findQuote((await candidatesFrom(document, sha256(bytes))), '会话').resolution, 'ambiguous');
  });
});

/** findQuote over every candidate of a parsed source. */
async function search(parser: Parser, input: string | Uint8Array, quote: string, options: { properties?: boolean; mediaType?: string } = {}): Promise<QuoteSearch & { sha: string }> {
  const bytes = typeof input === 'string' ? utf8(input) : input;
  const document = parser.parse(bytes, options.mediaType ? { mediaType: options.mediaType } : {});
  const sha = sha256(bytes);
  return { ...findQuote((await candidatesFrom(document, sha, { properties: options.properties })), quote), sha };
}

/** The selector of a src reference (after `src:<sha256>/<parser>/`). */
function selectorIn(reference: string): string {
  return reference.slice(reference.indexOf('/', 69) + 1);
}

/** What each match's ranged reference pins, cut out of the match text. */
function pinned(result: QuoteSearch): string[] {
  return result.matches.map((match) => sliceUtf8(match.text, match.location.from, match.location.to) ?? '<not on character boundaries>');
}

describe('findQuote: every occurrence belongs to the innermost fragment around it', () => {
  it('counts a heading that holds the quotation as a place of its own, next to the paragraph', async () => {
    const result = (await search(markdownParser, '# 会话保持超时\n\n设置会话保持超时为 300 秒。\n', '会话保持超时'));
    assert.equal(result.resolution, 'ambiguous');
    assert.deepEqual(result.matches.map((m) => selectorIn(m.reference)), ['h/会话保持超时', 'b/0/会话保持超时']);
    assert.deepEqual(pinned(result), ['会话保持超时', '会话保持超时']);
    assert.equal(result.matches[0].location.from, 2, 'the section is pinned at its heading, not at the paragraph inside it');
    assert.deepEqual(result.matches.map((m) => m.location.occurrences), [1, 1]);
  });

  it('pins exact occurrences across two blocks and inside a block without equating their whitespace', async () => {
    const source = '# S\n\nalpha X Y beta X\n\nY gamma\n';
    const across = (await search(markdownParser, source, 'X\n\nY'));
    assert.equal(across.resolution, 'resolved');
    assert.deepEqual(across.matches.map((m) => selectorIn(m.reference)), ['h/S']);
    assert.deepEqual(pinned(across), ['X\n\nY']);
    const inside = (await search(markdownParser, source, 'X Y'));
    assert.equal(inside.resolution, 'resolved');
    assert.deepEqual(inside.matches.map((m) => selectorIn(m.reference)), ['b/0/S']);
    assert.deepEqual(pinned(inside), ['X Y']);
    assert.equal((await search(markdownParser, source, 'X\nY')).resolution, 'unresolved');
  });

  it('separates an element text from the same text in a child element', async () => {
    const result = (await search(xmlParser, '<a>port 80<b>port 80</b></a>', 'port 80'));
    assert.equal(result.resolution, 'ambiguous');
    assert.deepEqual(result.matches.map((m) => selectorIn(m.reference)), ['x/a', 'x/a/b']);
    assert.deepEqual(pinned(result), ['port 80', 'port 80']);
    assert.equal((await search(xmlParser, '<a>x<b>port 80</b>y</a>', 'port 80')).resolution, 'resolved');
    assert.equal(selectorIn((await search(xmlParser, '<a>x<b>port 80</b>y</a>', 'port 80')).matches[0].reference), 'x/a/b');
  });

  it('takes a link as the place of its text, whatever the white space around it in the block', async () => {
    for (const html of ['<p>see <a href=x.xml>command_tree-Rel_X_1_2.xml</a></p>', '<p><a href=x.xml>command_tree-Rel_X_1_2.xml</a> (12K)</p>', '<blockquote>\n<A href=a>command_tree-Rel_X_1_2.xml</A><BR>\n<A href=b>MIB</A></blockquote>']) {
      const result = (await search(htmlParser, html, 'command_tree-Rel_X_1_2.xml'));
      assert.equal(result.resolution, 'resolved', html);
      assert.equal(selectorIn(result.matches[0].reference), 'a/0', html);
    }
    const gbk = (await search(htmlParser, new Uint8Array([...utf8('<p>x <a href=y>'), 0xd6, 0xd0, 0xce, 0xc4, ...utf8('</a></p>')]), '中文', { mediaType: 'text/html; charset=gbk' }));
    assert.equal(gbk.resolution, 'resolved', 'without byte ranges (a legacy charset) the link still nests in its block');
    assert.equal(selectorIn(gbk.matches[0].reference), 'a/0');
    const twice = (await search(htmlParser, '<p>file.xml <a href=x>file.xml</a></p>', 'file.xml'));
    assert.equal(twice.resolution, 'ambiguous', 'the block holds the name once more outside the link');
    assert.deepEqual(twice.matches.map((m) => selectorIn(m.reference)), ['b/0', 'a/0']);
  });

  it('takes a mind-map node as its own text field, and other fields as places of their own', async () => {
    const map = fixture('mindmap.km.json');
    for (const properties of [false, true]) {
      const result = (await search(kityminderParser, map, '需求 4021-示例网关会话保持功能测试', { properties }));
      assert.equal(result.resolution, 'resolved', `properties: ${properties}`);
      assert.equal(selectorIn(result.matches[0].reference), 'n/i7vkfd4cdjok');
    }
    const noted = (await search(kityminderParser, JSON.stringify({ root: { data: { id: 'r', text: 'abc', note: 'abc' } } }), 'abc', { properties: true }));
    assert.deepEqual(noted.matches.map((m) => selectorIn(m.reference)), ['n/r', 'n/r/@note']);
  });

  it('quotes JSON values, not the JSON text of the objects around them', async () => {
    const json = '{"story":{"title":"会话保持在 3.2 引入","tags":["a","b"]}}';
    const result = (await search(jsonParser, json, '会话保持在 3.2 引入'));
    assert.equal(result.resolution, 'resolved');
    assert.equal(selectorIn(result.matches[0].reference), 'p/story/title');
    const document = jsonParser.parse(utf8(json));
    assert.deepEqual((await candidatesFrom(document, sha256(json))).map((c) => selectorIn(c.reference)), ['p/story/title', 'p/story/tags/0', 'p/story/tags/1']);
    assert.ok(document.listSelectors().includes('p/story'), 'listSelectors still lists the containers');
  });

  it('resolves an exact quotation across a line break or a block boundary to the range around it', async () => {
    const text = (await search(textParser, 'The session timeout is applied after the\nlast packet of the flow is seen.\n', 'applied after the\nlast packet'));
    assert.equal(text.resolution, 'resolved');
    assert.equal(selectorIn(text.matches[0].reference), 'l/1-2');
    assert.deepEqual(pinned(text), ['applied after the\nlast packet']);
    assert.equal(selectorIn((await search(textParser, 'one line\nlast packet here\n', 'last packet')).matches[0].reference), 'l/2', 'a quotation inside one line stays on it');
    const html = (await search(htmlParser, '<p>applied after the</p><p>last packet</p>', 'applied after the\nlast packet'));
    assert.equal(html.resolution, 'resolved');
    assert.equal(selectorIn(html.matches[0].reference), 'b/0-1');
    assert.equal((await htmlParser.parse(utf8('<p>applied after the</p><p>last packet</p>')).locate('b/0-1'))!.text, 'applied after the\nlast packet');
  });

  it('states the exact whitespace rule when nothing is found, and refuses half characters', async () => {
    const missing = (await search(markdownParser, 'set 10 0\n', 'set 100'));
    assert.equal(missing.resolution, 'unresolved');
    assert.match(missing.diagnostics[0], /空白.*完全相同/);
    assert.doesNotMatch(missing.diagnostics[0], /空白差异不影响核对/);
    assert.equal((await search(markdownParser, '会话保持超时\n时间默认为 300 秒。\n', '会话保持超时\n时间')).resolution, 'resolved');
    assert.equal((await search(markdownParser, '会话保持超时\n时间默认为 300 秒。\n', '会话保持超时 时间')).resolution, 'unresolved');
    const half = findQuote([{ reference: `src:${'a'.repeat(64)}/text@1/l/1`, text: 'ok 😀 ok' }], '\ude00');
    assert.equal(half.resolution, 'unresolved');
    assert.match(half.diagnostics[0], /代理字符/);
  });

  it('pins every match of the fixtures on the quotation itself', async () => {
    const sources: Array<[Parser, string, string[], boolean]> = [
      [markdownParser, 'spec.md', ['会话', '超时', '设为 0 时配置被拒绝', '全角空格：前　后', 'Cookie']],
      [xmlParser, 'command-tree.xml', ['pool', 'Name of the pool', 'fast', 'Seconds before'], true],
      [htmlParser, 'listing.html', ['image', 'Released on', 'SHA256', 'command tree']],
      [kityminderParser, 'mindmap.km.json', ['超时', '被拒绝', '会话保持'], true],
    ].map(([parser, name, quotes, properties]) => [parser as Parser, name as string, quotes as string[], properties === true]);
    for (const [parser, name, quotes, properties] of sources) {
      for (const quote of quotes) {
        const result = (await search(parser, fixture(name), quote, { properties }));
        assert.ok(result.total > 0, `${name}: ${quote}`);
        for (const text of pinned(result)) assert.equal(text, quote, `${name}: ${quote}`);
      }
    }
  });
});

describe('findQuote and candidatesFrom stay linear in the document', () => {
  const BOUND_MS = 2_500;
  const within = (label: string, run: () => unknown): void => {
    const outcome = timed(run);
    assert.equal(outcome.error, null, `${label}: ${String(outcome.error)}`);
    assert.ok(outcome.ms < BOUND_MS, `${label} took ${outcome.ms.toFixed(0)} ms`);
  };

  it('a common word over 40000 sections with a paragraph each', async () => {
    const bytes = utf8(Array.from({ length: 40_000 }, (_, i) => `# 标题${i}\n\n的段落\n`).join('\n'));
    const document = markdownParser.parse(bytes);
    const candidates = (await candidatesFrom(document, sha256(bytes)));
    assert.equal(candidates.length, 80_000);
    within('findQuote', () => assert.equal(findQuote(candidates, '的').total, 40_000));
  });

  it('4 MB of text at depth 60 in XML', () => {
    const leaf = `<t>${'x '.repeat(499)}xy</t>`;
    const bytes = utf8(`${'<a>'.repeat(60)}${leaf.repeat(4_000)}${'</a>'.repeat(60)}`);
    const document = xmlParser.parse(bytes);
    within('candidatesFrom and findQuote', async () => {
      const candidates = (await candidatesFrom(document, sha256(bytes)));
      assert.equal(findQuote(candidates, 'x xy').total, 4_000);
      assert.equal(findQuote(candidates, 'xyx').resolution, 'resolved', 'only the parent of two leaves holds it, across them');
      assert.equal(findQuote(candidates, 'y x y').resolution, 'unresolved');
    });
  });

  it('40000 sibling elements', () => {
    const bytes = utf8(`<r>${'<i/>'.repeat(40_000)}</r>`);
    const document = xmlParser.parse(bytes);
    within('candidatesFrom', async () => assert.equal((await candidatesFrom(document, sha256(bytes))).length, 40_001));
  });

  it('200000 JSON values nested 100 deep', () => {
    let value: unknown = Array.from({ length: 200_000 }, (_, i) => `v${i}`);
    for (let depth = 0; depth < 99; depth++) value = [value];
    const bytes = utf8(JSON.stringify(value));
    const document = jsonParser.parse(bytes);
    within('candidatesFrom and findQuote', async () => {
      const candidates = (await candidatesFrom(document, sha256(bytes)));
      assert.equal(candidates.length, 200_000, 'values only');
      assert.equal(findQuote(candidates, 'v199999').resolution, 'resolved');
    });
  });
});

describe('strict quotation whitespace', () => {
  it('never deletes or folds a run beside wide, fullwidth, or Latin characters', () => {
    for (const [text, quote] of [['页面\r\n跳转', '页面跳转'], ['中\nA', '中A'], ['A\n中', 'A中'], ['Ａ \n B', 'ＡB'], ['𠀀\nA', '𠀀A'], ['🙂\nA', '🙂A']]) {
      assert.equal(quoteMatches(text, quote), false);
      assert.equal(locateQuote(text, quote), null);
      assert.ok(quoteMatches(text, text));
    }
    for (const [text, quote] of [['set 10 0', 'set 100'], ['a b', 'ab'], ['a + b', 'a+b'], ['α β', 'αβ'], ['ｱ A', 'ｱA']]) assert.equal(quoteMatches(text, quote), false);
    const source = '前中\r\nA后';
    assert.equal(locateQuote(source, '中A'), null);
    const location = locateQuote(source, '中\r\nA')!;
    assert.equal(sliceUtf8(source, location.from, location.to), '中\r\nA');
    const failed = findQuote([{ reference: `src:${'a'.repeat(64)}/text@1/l/1`, text: 'set 10 0' }], 'set 100');
    assert.match(failed.diagnostics.join(''), /空白.*完全相同/);
  });
});
