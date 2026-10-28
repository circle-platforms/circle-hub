import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ParseEncodingError, ParseLimitError, ParseSyntaxError } from '../../../packs/skill/mindmap-format/functions/format.ts';
import { MAX_SELECTOR_LENGTH } from '../../../packs/skill/mindmap-format/functions/selectors.ts';
import { kityminderParser, type KityMinderModel, type MindMapNode } from '../../../packs/skill/mindmap-format/api.ts';
import { fixture, timed, utf8 } from '../test-support.ts';

const plain = kityminderParser.parse(fixture('mindmap.km.json'));
const double = kityminderParser.parse(fixture('mindmap.double.json'));
const model = plain.model;
const isCase = (node: MindMapNode): boolean => Array.isArray(node.data.resource) && node.data.resource.length > 0 && node.data.priority !== undefined;

describe('kityminder@1 on the fixture', () => {
  it('reads the plain and the double-encoded form to the same nodes', () => {
    assert.equal(model.nodes.length, 150);
    assert.equal(plain.model.doubleEncoded, false);
    assert.equal(double.model.doubleEncoded, true);
    assert.deepEqual(double.model.nodes, model.nodes);
    assert.deepEqual(double.model.meta, { template: 'default', theme: 'fresh-blue', version: '1.4.43' });
    assert.equal(plain.parser, 'kityminder@1');
  });

  it('keeps text, every data field, ordered children and the parent chain', () => {
    const root = model.nodes[0];
    assert.equal(root.parent, null);
    assert.equal(root.text, '需求 4021-示例网关会话保持功能测试');
    assert.equal(root.children.length, 4);
    assert.deepEqual(
      root.children.map((child) => model.nodes[child].text),
      ['基本功能', '超时控制', '异常处理', '兼容性'],
    );
    for (const [index, node] of model.nodes.entries()) {
      for (const child of node.children) {
        assert.equal(model.nodes[child].parent, index);
        assert.equal(model.nodes[child].depth, node.depth + 1);
      }
      assert.equal(typeof node.data.id, 'string');
      assert.equal(typeof node.data.created, 'number');
      assert.equal(node.text, node.data.text);
    }
  });

  it('exposes case nodes with tags, priority, expected results and autoid, and group nodes without tags', () => {
    const cases = model.nodes.filter(isCase);
    const groups = model.nodes.filter((node) => node.data.priority !== undefined && !isCase(node));
    assert.equal(cases.length, 66);
    assert.equal(groups.length, 17);
    assert.ok(cases.filter((node) => node.children.length === 1).length >= 60);
    assert.ok(cases.some((node) => node.children.length === 2), 'one case has two expected results');
    assert.ok(cases.some((node) => node.children.length === 0), 'one case has none');
    assert.equal(cases.filter((node) => typeof node.data.autoid === 'string').length, 7);
    assert.ok(cases.some((node) => (node.data.resource as string[]).includes('negative')));
    assert.ok(cases.every((node) => [1, 2, 3].includes(node.data.priority as number)));
  });

  it('locates nodes by data.id with the parent chain and children', () => {
    const target = model.nodes.find((node) => node.data.autoid === 'TC-SYN-0014')!;
    const fragment = plain.locate(`n/${target.id}`)!;
    assert.equal(fragment.selector, `n/${target.id}`);
    assert.equal(fragment.text, '权重设为 101 被拒绝');
    assert.equal(fragment.byteRange, null);
    const data = fragment.data as { ancestors: Array<{ text: string }>; children: string[]; data: { resource: string[] }; parent: string };
    assert.deepEqual(
      data.ancestors.map((a) => a.text),
      ['需求 4021-示例网关会话保持功能测试', '基本功能', '池配置'],
    );
    assert.equal(data.children.length, 1);
    assert.equal(plain.locate(data.children[0])!.text, '提示参数超出范围 1-100');
    assert.deepEqual(data.data.resource, ['negative']);
    assert.equal(plain.locate(data.parent)!.text, '池配置');
  });

  it('locates data fields and index paths', () => {
    const target = model.nodes.find((node) => node.data.autoid === 'TC-SYN-0014')!;
    const field = plain.locate(`n/${target.id}/@resource`)!;
    assert.equal(field.text, '["negative"]');
    assert.deepEqual((field.data as { value: string[] }).value, ['negative']);
    assert.equal(plain.locate(`n/${target.id}/@autoid`)!.text, 'TC-SYN-0014');
    assert.equal(plain.locate(`n/${target.id}/@missing`), null);
    assert.equal(plain.locate('i')!.selector, model.nodes[0].selector);
    assert.equal(plain.locate('i/0/2')!.text, '池配置');
    assert.equal(plain.locate('i/0/2/@priority')!.text, '1');
    assert.equal(plain.locate('i/9'), null);
    assert.equal(plain.locate('i/01'), null);
    assert.equal(plain.locate('n/unknown'), null);
    assert.equal(plain.locate('n'), null);
    assert.equal(plain.locate('x/1'), null);
    assert.equal(plain.locate('not a selector'), null);
  });

  it('lists canonical selectors in document order, with fields on request', () => {
    const selectors = plain.listSelectors();
    assert.equal(selectors.length, 150);
    assert.deepEqual(selectors, model.nodes.map((node) => node.selector));
    for (const selector of selectors) assert.equal(plain.locate(selector)!.selector, selector);
    const withFields = plain.listSelectors('', { properties: true });
    assert.ok(withFields.length > 600);
    for (const selector of withFields.filter((s) => s.includes('/@')).slice(0, 50)) assert.ok(plain.locate(selector), selector);
    assert.equal(plain.listSelectors('n/', { limit: 5 }).length, 5);
  });

  it('summarizes structure without any text', () => {
    const summary = plain.summary();
    assert.equal(summary.nodes, 150);
    assert.equal(summary.depth, 4);
    assert.equal(summary.missingIds, 0);
    assert.ok(!JSON.stringify(summary).includes('会话'));
  });
});

function map(root: unknown, extra: object = {}): Uint8Array {
  return utf8(JSON.stringify({ root, ...extra }));
}

describe('kityminder@1 edge cases', () => {
  it('addresses nodes without a unique id by position', () => {
    const document = kityminderParser.parse(
      map({ data: { id: 'r', text: 'root' }, children: [{ data: { id: 'd', text: 'one' } }, { data: { id: 'd', text: 'two' } }, { data: { text: 'none' } }, { data: { id: '@x', text: 'at' } }] }),
    );
    const model: KityMinderModel = document.model;
    assert.deepEqual(model.duplicateIds, ['d']);
    assert.equal(model.missingIds, 1);
    assert.deepEqual(document.listSelectors(), ['n/r', 'i/0', 'i/1', 'i/2', 'i/3']);
    assert.equal(document.locate('n/d'), null);
    assert.equal(document.locate('i/1')!.text, 'two');
    assert.equal(document.locate('i/2/@text')!.text, 'none');
    assert.equal(document.locate('i/3')!.text, 'at');
  });

  it('keeps numeric ids and texts, extra node members and wrapper members', () => {
    const document = kityminderParser.parse(map({ data: { id: 7, text: 12 }, children: [], layout: 'right' }, { theme: 'x', custom: { a: 1 } }));
    assert.equal(document.model.nodes[0].id, '7');
    assert.equal(document.model.nodes[0].text, '12');
    assert.deepEqual(document.model.nodes[0].extra, { layout: 'right' });
    assert.deepEqual(document.model.meta, { theme: 'x', custom: { a: 1 } });
    assert.equal(document.locate('n/7')!.text, '12');
  });

  it('removes NUL from strings and counts it', () => {
    const document = kityminderParser.parse(map({ data: { id: 'r', text: 'a\u0000b', note: '\u0000' } }));
    assert.equal(document.model.nodes[0].text, 'ab');
    assert.equal(document.model.nodes[0].data.note, '');
    assert.equal(document.model.nulRemoved, 2);
  });

  it('accepts a leading byte order mark', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...map({ data: { id: 'r', text: 'x' } })]);
    assert.equal(kityminderParser.parse(bytes).model.nodes.length, 1);
  });

  it('refuses documents that are not mind maps', () => {
    const bad: Array<[string, Uint8Array]> = [
      ['not JSON', utf8('{root:')],
      ['an array', utf8('[1,2]')],
      ['no root', utf8('{"template":"default"}')],
      ['root not an object', utf8('{"root":[]}')],
      ['data not an object', map({ data: 'x' })],
      ['children not an array', map({ data: {}, children: {} })],
      ['a child that is not an object', map({ data: {}, children: [1] })],
      ['double-encoded garbage', utf8(JSON.stringify('{not json'))],
      ['a NUL in a member name', utf8('{"root":{"data":{"a\\u0000":1}}}')],
    ];
    for (const [name, bytes] of bad) assert.throws(() => kityminderParser.parse(bytes), ParseSyntaxError, name);
    assert.throws(() => kityminderParser.parse(new Uint8Array([0x7b, 0xff, 0x7d])), ParseEncodingError);
  });

  it('enforces its limits', () => {
    let deep: unknown = { data: { id: 'leaf' } };
    for (let i = 0; i < 30; i++) deep = { data: { id: `n${i}` }, children: [deep] };
    assert.throws(() => kityminderParser.parse(map(deep), { maxDepth: 10 }), (error: unknown) => error instanceof ParseLimitError && error.limit === 'maxDepth' && error.max === 10);
    const wide = { data: { id: 'r' }, children: Array.from({ length: 50 }, (_, i) => ({ data: { id: `c${i}` } })) };
    assert.throws(() => kityminderParser.parse(map(wide), { maxNodes: 20 }), (error: unknown) => error instanceof ParseLimitError && error.limit === 'maxNodes');
    assert.throws(() => kityminderParser.parse(map(wide), { maxBytes: 100 }), (error: unknown) => error instanceof ParseLimitError && error.limit === 'maxBytes');
    assert.equal(kityminderParser.parse(map(deep)).model.nodes.length, 31);
  });
});

describe('kityminder@1 text that can be stored, and selectors that can be cited', () => {
  it('replaces unpaired surrogates from escapes and counts them', () => {
    const document = kityminderParser.parse(utf8('{"root":{"data":{"id":"r","text":"case title \\ud83d"},"children":[{"data":{"id":"c","text":"\\ude00 ok 😀"}}]}}'));
    assert.deepEqual(document.model.nodes.map((node) => node.text), ['case title �', '� ok 😀']);
    assert.equal(document.model.surrogatesReplaced, 2);
    assert.equal(document.summary().surrogatesReplaced, 2);
    assert.ok(document.model.nodes.every((node) => node.text.isWellFormed()));
  });

  it('addresses a node by position when its id selector would be too long, and lists only citable fields', () => {
    const long = 'k'.repeat(MAX_SELECTOR_LENGTH);
    const document = kityminderParser.parse(map({ data: { id: 'r', text: 'root' }, children: [{ data: { id: long, text: 'long' } }, { data: { id: 'ok', text: 'fine', [long]: 1 } }] }));
    assert.deepEqual(document.listSelectors(), ['n/r', 'i/0', 'n/ok']);
    assert.equal(document.locate('i/0')!.text, 'long');
    assert.equal(document.locate(`n/${long.slice(0, 4000)}`), null);
    const withFields = document.listSelectors('', { properties: true });
    assert.ok(withFields.every((selector) => selector.length <= MAX_SELECTOR_LENGTH));
    assert.ok(withFields.includes('n/ok/@text') && !withFields.some((selector) => selector.startsWith('n/ok/@k')));
  });

  it('refuses deep position paths repeated over many fields', () => {
    let deep: unknown = { data: { id: 'leaf' } };
    for (let i = 0; i < 150; i++) deep = { data: { text: 'x' }, children: [deep, ...(i === 0 ? Array.from({ length: 20_000 }, () => ({ data: Object.fromEntries(Array.from({ length: 10 }, (_, f) => [`f${f}`, f])) })) : [])] };
    const outcome = timed(() => kityminderParser.parse(map(deep)));
    assert.ok(outcome.ms < 2_000, `took ${outcome.ms.toFixed(0)} ms`);
    assert.ok(outcome.error instanceof ParseLimitError && outcome.error.limit === 'maxSelectorChars', String(outcome.error));
  });
});
