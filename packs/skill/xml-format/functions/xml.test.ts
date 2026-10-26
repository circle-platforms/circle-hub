import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ParseEncodingError, ParseError, ParseForbiddenError, ParseLimitError, ParseSyntaxError } from './format.ts';
import { MAX_SELECTOR_LENGTH } from './selectors.ts';
import { xmlParser, type XmlElement } from './xml.ts';
import { fixture, latin1, timed, utf8 } from '../../../../hub/refs/test-support.ts';

const bytes = fixture('command-tree.xml');
const tree = xmlParser.parse(bytes);
const source = Buffer.from(bytes).toString('latin1');

function attributeOf(selector: string, name: string): string | undefined {
  return tree.locate(`${selector}/@${name}`)?.text;
}

describe('xml@1 on the command-tree fixture', () => {
  it('reads ISO-8859-1 into an ordered element tree', () => {
    const model = tree.model;
    assert.equal(model.charset, 'iso-8859-1');
    assert.deepEqual(model.declaration, { version: '1.0', encoding: 'ISO-8859-1', standalone: null });
    assert.equal(model.root.name, 'commands');
    assert.equal(model.comments, 1);
    const scopes = model.root.children.filter((child): child is XmlElement => typeof child !== 'string');
    assert.deepEqual(scopes.map((scope) => scope.attributes.name), ['global', 'config']);
    const summary = tree.summary();
    assert.equal(summary.elements, 106);
    assert.equal(summary.irregular, 3);
    assert.equal(summary.depth, 7);
    assert.equal(attributeOf('x/commands/scope[1]/menu[1]/menu[1]/item[1]/arguments/arg[1]', 'help'), 'Name of the pool (café and naïve names are allowed)');
    assert.equal(attributeOf('x/commands/scope[1]/menu[1]/menu[1]/item[1]/arguments/arg[2]', 'help'), 'Relative weight ± 5 %');
  });

  it('keeps overloads apart: one menu path with several argument lists', () => {
    const items = tree.listSelectors('x/commands/scope[1]/menu[1]/menu[1]/item').filter((s) => /item\[\d+\]$/.test(s));
    const modes = items.filter((s) => attributeOf(s, 'name') === 'mode');
    assert.equal(modes.length, 2);
    const argCounts = modes.map((s) => (tree.locate(`${s}/arguments`)!.data as { elements: number }).elements);
    assert.deepEqual(argCounts, [2, 3]);
  });

  it('tolerates stray attributes, flags them and recovers the values', () => {
    const quoted = tree.locate('x/commands/scope[1]/menu[1]/menu[1]/item[2]/arguments/arg[2]')!;
    const data = quoted.data as { attributes: Record<string, string>; irregular: string[]; startTag: string };
    assert.equal(data.attributes.help, 'Use "fast" or "safe"');
    assert.equal(data.attributes.type, 'STRING');
    assert.equal(data.irregular.length, 1);
    assert.equal(data.startTag, '<arg name="mode" type="STRING" length="8" optional="0" help="Use "fast" or "safe""/>');
    const lt = tree.locate('x/commands/scope[1]/menu[2]/menu[1]/item[1]/arguments/arg[2]')!;
    assert.equal((lt.data as { attributes: Record<string, string> }).attributes.help, 'Port range <1-65535>');
    const duplicate = tree.locate('x/commands/scope[1]/menu[1]/menu[3]/item[3]/arguments/arg[2]')!;
    assert.match((duplicate.data as { irregular: string[] }).irregular[0], /duplicate attribute: optional/);
    assert.equal(tree.locate('x/commands/scope[1]/menu[1]/menu[1]/item[1]')!.data && (tree.locate('x/commands/scope[1]/menu[1]/menu[1]/item[1]')!.data as { irregular: null }).irregular, null);
  });

  it('agrees between name paths and index paths', () => {
    for (const selector of tree.listSelectors()) {
      const fragment = tree.locate(selector)!;
      assert.equal(fragment.selector, selector);
      const index = (fragment.data as { index: string }).index;
      assert.equal(tree.locate(index)!.selector, selector, index);
    }
    assert.equal(tree.locate('x/commands/scope[2]/menu[1]')!.selector, 'x/commands/scope[2]/menu[1]');
    assert.equal(tree.locate('x/commands[1]/scope[2]')!.selector, 'x/commands/scope[2]');
  });

  it('gives byte ranges that cut the element out of the source', () => {
    const fragment = tree.locate('x/commands/scope[2]/menu[1]/item[2]')!;
    const [from, to] = fragment.byteRange!;
    const raw = source.slice(from, to);
    assert.ok(raw.startsWith('<item name="clock"'));
    assert.ok(raw.endsWith('</item>'));
    assert.match(tree.locate('x/commands/scope[2]/menu[1]/item[2]/arguments/arg/@help')!.text, /°C/);
  });

  it('uses the XPath string value as element text', () => {
    const doc = xmlParser.parse(utf8('<doc><p>Hello <b>big</b> world</p><p>a &amp; b &#x4e2d; <![CDATA[<raw>]]></p></doc>'));
    assert.equal(doc.locate('x/doc/p[1]')!.text, 'Hello big world');
    assert.equal(doc.locate('x/doc/p[2]')!.text, 'a & b 中 <raw>');
    assert.equal(doc.locate('x/doc')!.text, 'Hello big worlda & b 中 <raw>');
    assert.deepEqual(doc.model.root.children.length, 2);
  });

  it('refuses selectors that do not locate exactly one element', () => {
    for (const selector of ['x/commands/scope', 'x/commands/scope[3]', 'x/other', 'x', 'i/9', 'i/0/99', 'x/commands/scope[1]/@nope', 'x/commands/@', 'y/commands', 'x/commands/scope[0]', 'bad selector']) {
      assert.equal(tree.locate(selector), null, selector);
    }
  });

  it('lists attributes on request and filters by prefix', () => {
    const all = tree.listSelectors('', { properties: true });
    assert.equal(all.filter((s) => s.includes('/@')).length, 264);
    assert.ok(tree.listSelectors('x/commands/scope[2]').every((s) => s.startsWith('x/commands/scope[2]')));
    assert.equal(tree.listSelectors('', { limit: 3 }).length, 3);
  });

  it('encodes namespaced names in selectors', () => {
    const doc = xmlParser.parse(utf8('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/spec/</d:href></d:response></d:multistatus>'));
    assert.deepEqual(doc.listSelectors(), ['x/d%3Amultistatus', 'x/d%3Amultistatus/d%3Aresponse', 'x/d%3Amultistatus/d%3Aresponse/d%3Ahref']);
    assert.equal(doc.locate('x/d%3Amultistatus/d%3Aresponse/d%3Ahref')!.text, '/spec/');
  });

  it('keeps byte ranges exact for UTF-8 and CRLF', () => {
    const text = '<?xml version="1.0"?>\r\n<根>\r\n  <项 名="一">文字</项>\r\n</根>\r\n';
    const doc = xmlParser.parse(utf8(text));
    const [from, to] = doc.locate('x/根/项')!.byteRange!;
    assert.equal(Buffer.from(utf8(text)).subarray(from, to).toString('utf8'), '<项 名="一">文字</项>');
  });
});

describe('xml@1 safeguards', () => {
  it('refuses entity declarations while external DOCTYPE identifiers are never fetched', () => {
    const attempts = [
      '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;">]><lolz>&lol2;</lolz>',
      '<!DOCTYPE x [<!ENTITY ext SYSTEM "file:///etc/passwd">]><x>&ext;</x>',
    ];
    for (const xml of attempts) assert.throws(() => xmlParser.parse(utf8(xml)), ParseForbiddenError);
    assert.throws(() => xmlParser.parse(utf8('<x>&undefined;</x>')), ParseSyntaxError);
  });

  it('enforces nesting, element and attribute limits', () => {
    assert.throws(() => xmlParser.parse(utf8('<a>'.repeat(200) + '</a>'.repeat(200))), (e: unknown) => e instanceof ParseLimitError && e.limit === 'maxDepth' && e.max === 100);
    assert.throws(() => xmlParser.parse(utf8(`<r>${'<x/>'.repeat(50)}</r>`), { maxNodes: 10 }), (e: unknown) => e instanceof ParseLimitError && e.limit === 'maxNodes');
    const many = Array.from({ length: 30 }, (_, i) => `a${i}="v"`).join(' ');
    assert.throws(() => xmlParser.parse(utf8(`<r ${many}/>`), { maxAttributes: 20 }), (e: unknown) => e instanceof ParseLimitError && e.limit === 'maxAttributes');
    assert.throws(() => xmlParser.parse(utf8('<r/>'), { maxBytes: 3 }), (e: unknown) => e instanceof ParseLimitError && e.limit === 'maxBytes');
  });

  it('refuses malformed documents outside start tags', () => {
    const bad = ['<a><b></a>', '<a>', '<a/><b/>', 'text<a/>', '<a/>text', '', '<a>\u0001</a>', '<a>\u0000</a>', '<a b="1"></a ', '<a$b/>'];
    for (const xml of bad) assert.throws(() => xmlParser.parse(utf8(xml)), ParseSyntaxError, JSON.stringify(xml));
  });

  it('checks encodings', () => {
    assert.throws(() => xmlParser.parse(new Uint8Array([0xff, 0xfe, 0x3c])), ParseEncodingError);
    assert.throws(() => xmlParser.parse(utf8('<?xml version="1.0" encoding="Shift_JIS"?><a/>')), ParseEncodingError);
    assert.throws(() => xmlParser.parse(new Uint8Array([0x3c, 0x61, 0x3e, 0xc3, 0x28, 0x3c, 0x2f, 0x61, 0x3e])), (e: unknown) => e instanceof ParseEncodingError && e.offset === 3);
    assert.throws(() => xmlParser.parse(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('<?xml version="1.0" encoding="ISO-8859-1"?><a/>')])), ParseEncodingError);
    assert.throws(() => xmlParser.parse(latin1('<?xml version="1.0" encoding="US-ASCII"?><a>é</a>')), ParseEncodingError);
    assert.equal(xmlParser.parse(latin1("<?xml version='1.0' encoding='latin1'?><a>é</a>")).locate('x/a')!.text, 'é');
    assert.equal(xmlParser.parse(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('<a>中</a>')])).locate('x/a')!.text, '中');
  });

  it('tolerates attribute irregularities but keeps the structure', () => {
    const doc = xmlParser.parse(utf8('<r><a x="1"y="2"/><b flag z="3"/><c v=unquoted w="ok"/></r>'));
    assert.deepEqual(doc.listSelectors(), ['x/r', 'x/r/a', 'x/r/b', 'x/r/c']);
    for (const selector of ['x/r/a', 'x/r/b', 'x/r/c']) assert.ok((doc.locate(selector)!.data as { irregular: string[] | null }).irregular, selector);
    assert.equal(doc.locate('x/r/a/@y')!.text, '2');
    assert.equal(doc.locate('x/r/c/@w')!.text, 'ok');
  });
});

describe('xml@1 on hostile and unusual input', () => {
  const BOUND_MS = 1_500;
  function bounded<T>(label: string, run: () => T): T {
    const outcome = timed(run);
    assert.ok(outcome.ms < BOUND_MS, `${label} took ${outcome.ms.toFixed(0)} ms`);
    if (outcome.error !== null) throw outcome.error;
    return outcome.value as T;
  }

  it('repairs start tags in linear time, also when many values never close', () => {
    for (const unit of ['<a b="', '<c d="', "<e f='"]) {
      const input = utf8(`<r>${unit.repeat(80_000)}</r>`);
      const outcome = timed(() => xmlParser.parse(input));
      assert.ok(outcome.ms < BOUND_MS, `${unit} x 80000 took ${outcome.ms.toFixed(0)} ms`);
      assert.ok(outcome.error instanceof ParseError, String(outcome.error));
    }
    // A value longer than the repair window is left to saxes as written; the tags after it are still repaired.
    const doc = xmlParser.parse(utf8(`<r><a x="${'y'.repeat(70_000)}"/><b help="say "hi""/></r>`));
    assert.equal(doc.locate('x/r/a/@x')!.text.length, 70_000);
    assert.equal(doc.locate('x/r/b/@help')!.text, 'say "hi"');
  });

  it('removes U+0000 from attribute names and values, counts it and flags the element', () => {
    const doc = xmlParser.parse(utf8('<r><a b="x\u0000y" c="\u0000"/><d e="ok"/></r>'));
    assert.deepEqual(doc.model.root.children.filter((child) => typeof child !== 'string').map((child) => (child as XmlElement).attributes), [{ b: 'xy', c: '' }, { e: 'ok' }]);
    assert.equal(doc.locate('x/r/a/@b')!.text, 'xy');
    assert.equal(doc.model.nulRemoved, 2);
    assert.equal(doc.summary().nulRemoved, 2);
    assert.ok((doc.locate('x/r/a')!.data as { irregular: string[] }).irregular.some((note) => note.includes('U+0000')));
    assert.equal((doc.locate('x/r/d')!.data as { irregular: unknown }).irregular, null);
    assert.ok(!JSON.stringify(doc.model).includes('\\u0000'));
  });

  it('takes the charset from the media type before the declaration (RFC 7303)', () => {
    const latin = latin1('<item help="café ± 5 °C"/>');
    for (const mediaType of ['application/xml; charset=iso-8859-1', 'text/xml; charset=ISO-8859-1', 'application/xml; charset="latin1"']) {
      assert.equal(xmlParser.parse(latin, { mediaType }).locate('x/item/@help')!.text, 'café ± 5 °C', mediaType);
    }
    assert.throws(() => xmlParser.parse(latin, { mediaType: 'application/xml' }), ParseEncodingError, 'without a declaration or parameter it is UTF-8');
    const declaredLatin = utf8('<?xml version="1.0" encoding="ISO-8859-1"?><a>中</a>');
    assert.equal(xmlParser.parse(declaredLatin, { mediaType: 'application/xml; charset=utf-8' }).locate('x/a')!.text, '中', 'the parameter wins');
    assert.equal(xmlParser.parse(declaredLatin, { mediaType: 'application/xml; charset=utf-8' }).model.charset, 'utf-8');
    assert.throws(() => xmlParser.parse(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('<a/>')]), { mediaType: 'application/xml; charset=iso-8859-1' }), ParseEncodingError, 'a BOM and a parameter that disagree');
    assert.throws(() => xmlParser.parse(utf8('<a/>'), { mediaType: 'application/xml; charset=shift_jis' }), ParseEncodingError);
    assert.equal(xmlParser.parse(fixture('command-tree.xml'), { mediaType: 'application/xml; charset=iso-8859-1' }).summary().elements, 106);
  });

  it('falls back to position paths when a name path would be too long to cite', () => {
    const names = Array.from({ length: 30 }, (_, i) => `n${i}${'q'.repeat(400)}`);
    const bytes = utf8(`${names.map((name) => `<${name}>`).join('')}${'<leaf>t</leaf>'.repeat(50)}${[...names].reverse().map((name) => `</${name}>`).join('')}`);
    const doc = xmlParser.parse(bytes);
    const selectors = doc.listSelectors();
    assert.equal(selectors.length, 80);
    assert.ok(selectors.every((selector) => selector.length <= MAX_SELECTOR_LENGTH));
    assert.ok(selectors[0].startsWith('x/n0'), 'short name paths stay');
    assert.match(selectors[79], /^i(?:\/0){29}\/49$/, 'the deepest elements are cited by position');
    for (const selector of selectors) assert.equal(doc.locate(selector)!.selector, selector);
    const longName = `x/${names.slice(0, 12).join('/')}`;
    assert.ok(longName.length > MAX_SELECTOR_LENGTH && longName.length < 8192);
    assert.equal(doc.locate(longName)!.selector, 'i/0/0/0/0/0/0/0/0/0/0/0', 'a name path over the budget answers with the position path');
    assert.equal(doc.locate(`${selectors[79]}/@x`), null);
  });

  it('bounds the selector text of long names over many elements', () => {
    const names = Array.from({ length: 30 }, (_, i) => `n${i}${'q'.repeat(400)}`);
    const nested = (levels: number, leaves: number): Uint8Array =>
      utf8(`${names.slice(0, levels).map((name) => `<${name}>`).join('')}${'<l/>'.repeat(leaves)}${names.slice(0, levels).reverse().map((name) => `</${name}>`).join('')}`);
    // Paths just under the length budget, repeated for 20000 leaves: 73 M characters of selectors, refused at once.
    const outcome = timed(() => xmlParser.parse(nested(9, 20_000)));
    assert.ok(outcome.ms < BOUND_MS, `took ${outcome.ms.toFixed(0)} ms`);
    assert.ok(outcome.error instanceof ParseLimitError && outcome.error.limit === 'maxSelectorChars', String(outcome.error));
    // Half as long: parsed, and listing every selector stays cheap.
    const bytes = nested(5, 20_000);
    const doc = bounded('parse', () => xmlParser.parse(bytes));
    const listed = bounded('listSelectors', () => doc.listSelectors('x/'));
    assert.equal(listed.length, 20_005);
    assert.throws(() => xmlParser.parse(bytes, { maxSelectorChars: 10_000_000 }), (e: unknown) => e instanceof ParseLimitError && e.limit === 'maxSelectorChars');
  });

  it('steps through name paths without scanning all siblings', () => {
    const bytes = utf8(`<r>${'<i/>'.repeat(20_000)}${'<j/>'.repeat(20_000)}</r>`);
    const doc = xmlParser.parse(bytes);
    const selectors = doc.listSelectors();
    bounded('locate every element', () => {
      for (const selector of selectors) assert.ok(doc.locate(selector));
    });
    assert.equal(doc.locate('x/r/j[20000]')!.selector, 'x/r/j[20000]');
    assert.equal(doc.locate('x/r/j[20001]'), null);
  });
});

it('native XML syntax failures have a source-assigned public reason without classifying error prose', () => {
  for (const text of ['<private-synthetic><other></private-synthetic>', '<a>\u0001</a>']) {
    assert.throws(() => xmlParser.parse(utf8(text)), (error: unknown) => error instanceof ParseSyntaxError && error.message === 'XML 格式不对：不符合 XML 语法' && typeof error.detail === 'string');
  }
});
