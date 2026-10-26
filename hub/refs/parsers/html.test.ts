import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ParseEncodingError, ParseLimitError, htmlParser, type HtmlBlock, type HtmlModel } from '../api.ts';
import { fixture, latin1, timed, utf8 } from '../test-support.ts';

const bytes = fixture('listing.html');
const listing = htmlParser.parse(bytes);
const model: HtmlModel = listing.model;
const source = Buffer.from(bytes).toString('latin1');

describe('html@1 on the build listing fixture', () => {
  it('reads ordered blocks and the title', () => {
    assert.equal(model.charset, 'windows-1252');
    assert.equal(model.title, 'SYNTH 3.2 builds');
    assert.equal(model.blocks.length, 18);
    assert.equal(model.blocks[0].tag, 'h2');
    assert.equal(model.blocks[0].text, 'SYNTH3.x Builds');
    assert.equal(model.blocks[17].text, 'Notes: synthetic listing for parser tests © 2026 · contact 192.0.2.1');
  });

  it('flags released entries wrapped in a red font element', () => {
    const headers = model.blocks.filter((block) => /^(?:Rel|Beta)_/.test(block.text));
    assert.equal(headers.length, 8);
    const released = headers.filter((block) => block.flags.includes('font'));
    assert.deepEqual(
      released.map((block) => block.text),
      [
        'Rel_SYNTH_3_2_1_105 (build on 2026-03-02 10:11:12 ): Released on 2026-03-05',
        'Rel_SYNTH_3_2_0_090 (build on 2026-01-10 06:00:00 ): Released on 2026-01-12',
        'Rel_ALTSYN_3_2_1_105 (build on 2026-03-02 11:00:00 ): based on Rel_SYNTH_3_2_1_105 Released on 2026-03-06',
      ],
    );
    const font = released[0].runs.find((run) => run.wrappers.length > 0)!;
    assert.deepEqual(font.wrappers, [{ tag: 'font', attributes: { color: 'red' } }]);
    assert.ok(headers.filter((block) => !block.flags.includes('font')).every((block) => !block.text.includes('Released on')));
  });

  it('keeps an alias entry of the second name family: the base build sits between the build time and the release date', () => {
    const aliases = model.blocks.filter((block) => block.text.includes(': based on '));
    assert.deepEqual(
      aliases.map((block) => [block.text, block.flags]),
      [
        ['Rel_ALTSYN_3_2_1_105 (build on 2026-03-02 11:00:00 ): based on Rel_SYNTH_3_2_1_105 Released on 2026-03-06', ['font']],
        ['Rel_ALTSYN_3_2_1_101 (build on 2026-02-21 09:30:00 ): based on Beta_SYNTH_3_2_1_101', []],
      ],
    );
    // An alias has no command tree of its own: its links are the image, the MIB and the fixed list.
    const own = (block: HtmlBlock): string[] => model.blocks[model.blocks.indexOf(block) + 1].links.map((link) => model.links[link].href!);
    for (const alias of aliases) {
      assert.equal(own(alias).length, 3);
      assert.ok(own(alias).every((href) => href.includes('ALTSYN') && !href.startsWith('command_tree-')));
    }
  });

  it('keeps hrefs exactly as written, unquoted ones included', () => {
    assert.equal(model.links.length, 29);
    assert.deepEqual(
      model.links.slice(0, 4).map((link) => [link.href, link.text]),
      [
        ['Rel_SYNTH_3_2_1_105.array', 'image'],
        ['SYNTH-MIB-Rel_SYNTH_3_2_1_105.txt', 'MIB'],
        ['command_tree-Rel_SYNTH_3_2_1_105.xml', 'command tree'],
        ['Bugs_Fixed_with_Rel_SYNTH_3_2_1_105.html', 'fixed list'],
      ],
    );
    const platform = model.links.filter((link) => link.href!.includes('SYNTH-SY-K'));
    assert.equal(platform.length, 3, 'the platform build has no command tree link');
    for (const link of model.links) {
      const [from, to] = link.range!;
      assert.match(source.slice(from, to), new RegExp(`^<A href=${link.href!.replace(/[.]/g, '\\.')}>`));
    }
  });

  it('turns <br> into line breaks inside a block and keeps link blocks', () => {
    const quote = model.blocks[2];
    assert.equal(quote.tag, 'blockquote');
    assert.equal(quote.text.split('\n').length, 4);
    assert.match(quote.text.split('\n')[0], /^image \( 42M , SHA256: [0-9a-f]{64} \)$/);
    assert.deepEqual(quote.links, [0, 1, 2, 3]);
    assert.equal(model.links[0].block, 2);
  });

  it('locates blocks and links', () => {
    const block = listing.locate('b/1')!;
    assert.equal(block.selector, 'b/1');
    assert.deepEqual((block.data as { flags: string[] }).flags, ['font']);
    const [from, to] = block.byteRange!;
    assert.ok(source.slice(from, to).includes('Rel_SYNTH_3_2_1_105 (build on  2026-03-02'));
    const link = listing.locate('a/2')!;
    assert.equal(link.text, 'command tree');
    assert.equal((link.data as { href: string; block: string }).href, 'command_tree-Rel_SYNTH_3_2_1_105.xml');
    assert.equal((link.data as { block: string }).block, 'b/2');
    for (const selector of ['b/18', 'a/29', 'b/01', 'b', 'c/0', 'b/0/x', 'b/2-2', 'b/3-1', 'b/0-18', 'b/01-2', 'a/0-1']) assert.equal(listing.locate(selector), null, selector);
    assert.equal(listing.listSelectors().length, 47);
    const range = listing.locate('b/1-2')!;
    assert.equal(range.text, `${model.blocks[1].text}\n${model.blocks[2].text}`);
    assert.deepEqual(range.byteRange, [model.blocks[1].range![0], model.blocks[2].range![1]]);
    assert.deepEqual(listing.listSelectors('a/', { limit: 2 }), ['a/0', 'a/1']);
  });

  it('summarizes without text', () => {
    const summary = listing.summary();
    assert.equal(summary.blocks, 18);
    assert.equal(summary.links, 29);
    assert.ok(!JSON.stringify(summary).includes('SYNTH'));
  });
});

function blocks(html: string, mediaType?: string): HtmlBlock[] {
  return htmlParser.parse(utf8(html), mediaType ? { mediaType } : {}).model.blocks;
}

describe('html@1 behaviour', () => {
  it('nests formatting flags outermost first and records their attributes', () => {
    const [block] = blocks('<p><font color="#c00" size=2><b>red <i>bold italic</i></b></font> plain</p>');
    assert.deepEqual(block.flags, ['font', 'b', 'i']);
    assert.deepEqual(block.runs.map((run) => [run.text, run.wrappers.map((w) => w.tag)]), [
      ['red ', ['font', 'b']],
      ['bold italic', ['font', 'b', 'i']],
      [' plain', []],
    ]);
    assert.deepEqual(block.runs[0].wrappers[0].attributes, { color: '#c00', size: '2' });
  });

  it('never runs or shows scripts and styles', () => {
    const model = htmlParser.parse(utf8('<p>a</p><script>document.write("<p>evil</p>")</script><style>p{}</style><p>b</p>')).model;
    assert.deepEqual(model.blocks.map((b) => b.text), ['a', 'b']);
  });

  it('collapses HTML white space but keeps NBSP and preformatted text', () => {
    const [p, pre] = blocks('<p>  a \n\t b&nbsp;&nbsp;c  </p><pre>  x\n    y</pre>');
    assert.equal(p.text, 'a b  c');
    assert.equal(pre.text, '  x\n    y');
  });

  it('splits anonymous blocks around block elements and table cells', () => {
    const texts = blocks('<div>before<p>inside</p>after</div><table><tr><td>c1</td><td>c2</td></tr></table>').map((b) => [b.tag, b.text]);
    assert.deepEqual(texts, [
      ['div', 'before'],
      ['p', 'inside'],
      ['div', 'after'],
      ['td', 'c1'],
      ['td', 'c2'],
    ]);
  });

  it('decodes entities in hrefs and keeps links without href', () => {
    const model = htmlParser.parse(utf8('<a href="index.php?m=bug&amp;f=view&amp;id=51">bug</a> <a name=top>anchor</a> <A HREF=Rel_X.click>x</A>')).model;
    assert.deepEqual(model.links.map((link) => link.href), ['index.php?m=bug&f=view&id=51', null, 'Rel_X.click']);
  });

  it('chooses the charset from the media type, a meta element or the bytes', () => {
    const latin = latin1('<p>café ©</p>');
    assert.equal(htmlParser.parse(latin).model.blocks[0].text, 'café ©');
    assert.equal(htmlParser.parse(latin, { mediaType: 'text/html; charset=ISO-8859-1' }).model.charset, 'windows-1252');
    assert.equal(htmlParser.parse(latin1('<meta charset="iso-8859-1"><p>é</p>')).model.charset, 'windows-1252');
    assert.equal(htmlParser.parse(utf8('<p>中文</p>')).model.charset, 'utf-8');
    assert.throws(() => htmlParser.parse(latin, { mediaType: 'text/html; charset=utf-8' }), ParseEncodingError);
    assert.throws(() => htmlParser.parse(new Uint8Array([0xfe, 0xff, 0])), ParseEncodingError);
    assert.throws(() => htmlParser.parse(utf8('<p>x</p>'), { mediaType: 'text/html; charset=no-such-charset' }), ParseEncodingError);
    const gbk = htmlParser.parse(new Uint8Array([0x3c, 0x70, 0x3e, 0xd6, 0xd0, 0xce, 0xc4, 0x3c, 0x2f, 0x70, 0x3e]), { mediaType: 'text/html; charset=gbk' });
    assert.equal(gbk.model.blocks[0].text, '中文');
    assert.deepEqual(gbk.model.blocks[0].range, [3, 7], 'multi-byte legacy charsets retain source ranges');
  });

  it('enforces depth, node and attribute limits', () => {
    assert.throws(() => htmlParser.parse(utf8('<div>'.repeat(400))), (e: unknown) => e instanceof ParseLimitError && e.limit === 'maxDepth');
    assert.throws(() => htmlParser.parse(utf8('<p>x</p>'.repeat(100)), { maxNodes: 50 }), (e: unknown) => e instanceof ParseLimitError && e.limit === 'maxNodes');
    const tag = `<i ${Array.from({ length: 600 }, (_, i) => `a${i}`).join(' ')}>x</i>`;
    assert.throws(() => htmlParser.parse(utf8(tag)), (e: unknown) => e instanceof ParseLimitError && e.limit === 'maxAttributes');
    const endTag = `<i>x</i ${Array.from({ length: 600 }, (_, i) => `a${i}`).join(' ')}>`;
    assert.throws(() => htmlParser.parse(utf8(endTag)), (e: unknown) => e instanceof ParseLimitError && e.limit === 'maxAttributes');
    const commented = `<!--><i ${Array.from({ length: 600 }, (_, i) => `a${i}`).join(' ')}>x</i>`;
    assert.throws(() => htmlParser.parse(utf8(commented)), (e: unknown) => e instanceof ParseLimitError && e.limit === 'maxAttributes');
    const inScript = `<script>var a = "<i ${'x '.repeat(600)}";</script><p>ok</p>`;
    assert.deepEqual(htmlParser.parse(utf8(inScript)).model.blocks.map((b) => b.text), ['ok'], 'raw text is not counted');
    const foreign = `<svg><script><i ${Array.from({ length: 600 }, (_, i) => `a${i}`).join(' ')}></script></svg>`;
    assert.throws(() => htmlParser.parse(utf8(foreign)), (e: unknown) => e instanceof ParseLimitError && e.limit === 'maxAttributes');
  });
});

describe('html@1 on hostile input', () => {
  const BOUND_MS = 2_000;
  const attributes = (count: number): string => Array.from({ length: count }, (_, i) => `a${i}`).join(' ');
  function outcomeOf(html: string, options = {}): ReturnType<typeof timed> {
    const outcome = timed(() => htmlParser.parse(utf8(html), options));
    assert.ok(outcome.ms < BOUND_MS, `${html.slice(0, 40)}... took ${outcome.ms.toFixed(0)} ms`);
    return outcome;
  }
  const limited = (limit: string) => (error: unknown): boolean => error instanceof ParseLimitError && error.limit === limit;

  it('counts the attributes of tags that select mode reads as markup', () => {
    // Inside <select>, parse5 ignores these start tags, so their content is markup, not raw text.
    for (const tag of ['plaintext', 'xmp', 'title', 'iframe', 'style', 'noembed', 'noframes']) {
      const outcome = outcomeOf(`<select><${tag}><p ${attributes(64_000)}>x</p>`);
      assert.ok(limited('maxAttributes')(outcome.error), `${tag}: ${String(outcome.error)}`);
    }
    assert.deepEqual(htmlParser.parse(utf8(`<script>var a = "<i ${'x '.repeat(600)}";</script><p>ok</p>`)).model.blocks.map((b) => b.text), ['ok'], 'raw text outside select still skips');
  });

  it('keeps counting depth through nested templates', () => {
    const outcome = outcomeOf('<template>'.repeat(160_000));
    assert.ok(limited('maxDepth')(outcome.error), String(outcome.error));
    assert.ok(limited('maxDepth')(outcomeOf('<template><div>'.repeat(200)).error));
    assert.equal(htmlParser.parse(utf8('<template><p>hidden</p></template><p>shown</p>')).model.blocks.map((b) => b.text).join('|'), 'shown');
  });

  it('caps the attributes repeated <body> and <html> tags merge into one element', () => {
    const tags = Array.from({ length: 600 }, (_, t) => `<body ${Array.from({ length: 500 }, (_, i) => `b${t}_${i}`).join(' ')}>`).join('');
    assert.ok(limited('maxAttributes')(outcomeOf(tags).error));
    const html = Array.from({ length: 200 }, () => `<html ${attributes(500)}>`).join('');
    const same = outcomeOf(html);
    assert.equal(same.error, null, 'the same names again add nothing');
  });

  it('moves foster-parented and misnested content without quadratic work, and counts text nodes', () => {
    const fostered = outcomeOf(`<table>${'x<b>y</b>'.repeat(200_000)}`);
    assert.equal(fostered.error, null, String(fostered.error));
    assert.equal(outcomeOf('<a><table><a>'.repeat(80_000)).error, null);
    assert.ok(limited('maxNodes')(outcomeOf(`<table>${'x<b>y</b>'.repeat(100)}`, { maxNodes: 150 }).error), 'text nodes count');
    const text = outcomeOf(`<div>${'x<br>'.repeat(100)}</div>`, { maxNodes: 150 });
    assert.ok(limited('maxNodes')(text.error), 'text appended in body counts too');
  });

  it('collects many links in one block in linear time', () => {
    const outcome = outcomeOf(`<p>${'<a href=x>y</a>'.repeat(240_000)}`);
    assert.equal(outcome.error, null, String(outcome.error));
    const model = (outcome.value as { model: HtmlModel }).model;
    assert.equal(model.blocks[0].links.length, 240_000);
    assert.equal(model.links[239_999].block, 0);
  });

  it('bounds the wrapper lists of text deep inside formatting elements', () => {
    const outcome = outcomeOf(`<p>${'<b>'.repeat(250)}${'<i>x</i>'.repeat(100_000)}`);
    assert.ok(limited('maxNodes')(outcome.error), String(outcome.error));
    const [block] = htmlParser.parse(utf8(`<p>${'<b>'.repeat(3)}${'<i>x</i>'.repeat(10)}`)).model.blocks;
    assert.equal(block.runs.length, 10);
    assert.deepEqual(block.runs[0].wrappers.map((w) => w.tag), ['b', 'b', 'b', 'i']);
    assert.deepEqual(block.flags, ['b', 'i']);
  });
});
