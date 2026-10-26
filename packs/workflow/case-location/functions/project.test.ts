import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ProjectionInput, ProjectionOutput } from '../../../../contracts/src/pack.ts';
import { kityminderParser } from '../../../../hub/refs/api.ts';
import { locateInputOf, locateItem, summaryOf } from './locate.ts';
import project, { MAX_ITEMS, projectItems } from './project.ts';
import { BOUND, UNBOUND, assertTotal, boundDocument, hostileInputs, mindMapJson, sha256, smallMap, type Node } from './test-support.ts';
import type { BoundInput, ItemFields, ProjectedItem } from './types.ts';

const P0 = '030：FAMX/FAMY测试项目';
const TREE = { root: 'FAMY', ancestors: [P0, '060：10.6.1', '004：10.6.1-R2-2026/7', 'SSL'] };

type Items = { items: ProjectedItem[]; warnings: Array<{ code: string; document?: string }> };
type Refused = { error: { code: string; message: string; fix: string; documents?: string[] }; warnings: unknown[] };

function run(inputs: BoundInput[], parameters: Record<string, unknown> = {}, context: object = BOUND): Items | Refused {
  const input = { inputs, parameters, context: { ...context, parameters } };
  assert.ok(ProjectionInput.safeParse(input).success, 'the test input is projection-input@1');
  const out = projectItems(input);
  const parsed = ProjectionOutput.safeParse(out);
  assert.ok(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3)));
  return out as Items | Refused;
}

function items(out: Items | Refused): Items {
  if ('error' in out) assert.fail(`refused: ${JSON.stringify(out.error)}`);
  return out;
}

function refused(out: Items | Refused): Refused['error'] {
  if (!('error' in out)) assert.fail(`not refused: ${JSON.stringify(out.items.map((i) => i.id))}`);
  return out.error;
}

/** The selector resolves in the document it names and in no other bound document (what the engine requires). */
function assertLocated(item: ProjectedItem, inputs: BoundInput[]): void {
  const hits = inputs.filter((b) => kityminderParser.parse(new TextEncoder().encode(textOf(b))).locate(item.location.selector) !== null);
  assert.equal(hits.length, 1, `${item.id}: ${item.location.selector} resolves in ${hits.length} documents`);
  assert.equal(hits[0].sha256, item.location.source);
}

const texts = new Map<string, string>();
function doc(document: string, root: Node, meta: Parameters<typeof boundDocument>[2]): BoundInput {
  const bound = boundDocument(document, root, meta);
  texts.set(bound.sha256, mindMapJson(document, root));
  return bound;
}
const textOf = (b: BoundInput): string => texts.get(b.sha256)!;

describe('one item per document (default)', () => {
  it('projects the document with its tree facts and the answer as the summary', () => {
    const d = doc('24001', smallMap('24001', '需求20931 证书链校验'), { title: '需求20931 证书链校验', ...TREE });
    const out = items(run([d]));
    assert.equal(out.items.length, 1);
    const [item] = out.items;
    const fields: ItemFields = { kind: 'document', document: '24001', node: null, source: 'agile:mindmap:24001@1', root: 'FAMY', ancestors: TREE.ancestors, title: '需求20931 证书链校验', path: [], case_title: null };
    assert.deepEqual(item, {
      id: '24001',
      label: '需求20931 证书链校验',
      // famx-id-fields@1: no identifier is read out of a title, so the summary names the located layers only.
      summary: '产品线 famx（FAMY）；版本 10.6.1（目录，置信度高）；发布火车 10.6.1-R2-2026/7；模块 SSL',
      location: { slot: 'documents', source: d.sha256, parser: 'kityminder@1', selector: 'n/24001n0' },
      fields,
    });
    const { answer, judgment } = locateItem(locateInputOf(item.id, item.fields, BOUND));
    assert.equal(item.summary, summaryOf(answer, judgment));
    assert.deepEqual(out.warnings, []);
    assertLocated(item, [d]);
  });

  it('projects several documents, each answered as if alone, at selectors no other document resolves', () => {
    const a = doc('24001', smallMap('24001', 'bug 61001 会话'), { title: 'bug 61001 会话', ...TREE });
    const b = doc('24002', smallMap('24002', 'FAMX 通用'), { title: 'FAMX 通用', root: 'FAMX', ancestors: ['通用用例'] });
    const c = doc('24003', smallMap('24003', 'x'), { title: 'FAMY 10.6.2.31 升级', root: 'FAMY', ancestors: [P0, '专项'] });
    const together = items(run([a, b, c]));
    assert.deepEqual(
      together.items.map((i) => i.id),
      ['24001', '24002', '24003'],
    );
    for (const [k, single] of [a, b, c].entries()) {
      const alone = items(run([single])).items[0];
      assert.deepEqual(together.items[k], alone);
      assertLocated(together.items[k], [a, b, c]);
    }
    assert.match(together.items[1].summary!, /^不确定（没有版本层，发布火车层未知，模块层未知）：产品线 famx（FAMX）；版本未知/);
    assert.equal(together.items[2].label, 'FAMY 10.6.2.31 升级', 'the label is the title the tree lists');
  });

  it('chooses another node when a document root id is not unique among the bound documents, and refuses when none is', () => {
    const shared: Node = { text: '同一个根', id: 'r00000000001', children: [{ text: '分组', id: null, data: { priority: 1 } }] };
    const a = doc('24011', { ...shared, children: [{ text: '分组', id: 'a1aaaaaaaaaa' }] }, { title: '甲', ...TREE });
    const b = doc('24012', shared, { title: '乙', ...TREE });
    const out = run([a, b]);
    const error = refused(out);
    assert.equal(error.code, 'case-location.ambiguous_location');
    assert.deepEqual(error.documents, ['24012']);
    const c = doc('24013', { ...shared, children: [{ text: '分组', id: 'c1cccccccccc' }] }, { title: '丙', ...TREE });
    const ok = items(run([a, c]));
    assert.deepEqual(
      ok.items.map((i) => i.location.selector),
      ['n/a1aaaaaaaaaa', 'n/c1cccccccccc'],
    );
    for (const item of ok.items) assertLocated(item, [a, c]);
    // Alone, a document is located at its root whatever its ids.
    assert.equal(items(run([b])).items[0].location.selector, 'n/r00000000001');
    const noIds = doc('24014', { text: '没有编号', id: null, children: [{ text: '子', id: null }] }, { title: '丁', ...TREE });
    assert.equal(items(run([noIds])).items[0].location.selector, 'i');
  });

  it('warns when the tree facts or the product line are missing, and still locates', () => {
    const d = doc('24021', smallMap('24021', 'FAMY 10.6.1.57 回归'), null);
    const out = items(run([d], {}, UNBOUND));
    assert.deepEqual(
      out.warnings.map((w) => w.code),
      ['case-location.unbound_product', 'case-location.no_tree_meta'],
    );
    assert.equal(out.items[0].label, 'FAMY 10.6.1.57 回归', 'without meta the title is the map root text');
    assert.deepEqual([out.items[0].fields.root, out.items[0].fields.ancestors], [null, []]);
    // A title is prose: no version is read out of it, so an unbound run has neither a product line nor a version.
    assert.match(out.items[0].summary!, /^不确定（运行没有绑定产品线，没有版本层，发布火车层未知，模块层未知）：产品线未定；版本未知/);
    const rootless = doc('24022', smallMap('24022', 'x'), { title: 'x', ancestors: ['060：10.6.1'] });
    assert.deepEqual(
      items(run([rootless])).warnings.map((w) => w.code),
      ['case-location.no_tree_meta'],
    );
    const objectRoot = doc('24023', smallMap('24023', 'x'), { title: 'x', ancestors: TREE.ancestors, root: { id: '7714', name: 'FAMY' } });
    assert.equal(items(run([objectRoot])).items[0].fields.root, 'FAMY');
  });

  it('reads the meta shape of the agile platform system pack: the root as {id, title}, the folders from the root title down', () => {
    // packs/system/agile-platform: meta {id, title, ancestors, root}, ancestors starting with the root's title.
    const meta = { id: '24024', title: '需求20931 证书链校验', ancestors: ['FAMY', ...TREE.ancestors], root: { id: '7714', title: 'FAMY' } };
    const d = doc('24024', smallMap('24024', 'x'), meta);
    const [item] = items(run([d])).items;
    assert.deepEqual([item.fields.root, item.fields.title], ['FAMY', '需求20931 证书链校验']);
    const { answer } = locateItem(locateInputOf(item.id, item.fields, BOUND));
    assert.deepEqual(answer.ancestor_path, ['FAMY', ...TREE.ancestors]);
    assert.deepEqual([answer.product_line, answer.version, answer.train, answer.module], ['famx', '10.6.1', '10.6.1-R2-2026/7', 'SSL']);
    // A document the configured roots do not hold: no title, no folders, no root.
    const unknown = doc('24025', smallMap('24025', '地图里的标题'), { id: '24025', title: null, ancestors: [], root: null });
    const out = items(run([unknown]));
    assert.deepEqual(
      out.warnings.map((w) => w.code),
      ['case-location.no_tree_meta'],
    );
    assert.equal(out.items[0].label, '地图里的标题');
  });

  it('passes the declarations and refuses parameters it cannot read, with the rule', () => {
    const d = doc('24031', smallMap('24031', 'x'), { title: 'x', ...TREE });
    const out = items(run([d], { line: '10.7.3' }));
    assert.match(out.items[0].summary!, /^与声明矛盾（声明的版本线 10\.7\.3 与目录的 10\.6\.1 矛盾）：/);
    assert.match(items(run([d], { line: 'V10.6' })).items[0].summary!, /^产品线 famx（FAMY）；版本 10\.6\.1/);
    // What the parameter schemas let through (no patterns there) but the scheme cannot use.
    for (const [parameters, named] of [
      [{ line: '10.6.x' }, 'line'],
      [{ line: '2026' }, 'line'],
      [{ product: '   ' }, 'product'],
      [{ id_ranges: { story: { min: 9, max: 1 } } }, 'id_ranges'],
    ] as const) {
      const error = refused(run([d], parameters));
      assert.equal(error.code, 'case-location.invalid_parameter', JSON.stringify(parameters));
      assert.match(error.message, new RegExp(`参数 ${named} `));
      assert.match(error.fix, new RegExp(`${named} `));
    }
    const several = refused(projectItems({ inputs: [d], parameters: { line: 'abc', granularity: 'every' }, context: { ...BOUND, parameters: {} } }) as Refused);
    assert.equal(several.message, '参数 line、granularity 的取值无效');
  });
});

describe('one item per case (granularity case)', () => {
  const map: Node = {
    text: 'SSL 卸载',
    children: [
      {
        text: '基本功能',
        data: { priority: 1 },
        children: [
          { text: 'bug 61500 证书链加载', data: { priority: 2, resource: ['Function'] }, children: [{ text: '加载成功' }] },
          { text: '证书过期时报错', id: 'dupdupdupdup', data: { priority: 2, resource: ['Negative'] }, children: [{ text: '提示过期' }] },
          { text: '证书过期时报错（副本）', id: 'dupdupdupdup', data: { priority: 2, resource: ['Negative'] }, children: [{ text: '提示过期' }] },
          { text: '没有标签的节点', data: { priority: 2 }, children: [{ text: '结果' }] },
        ],
      },
    ],
  };

  it('projects every case node (tagged or marked) with the map path above it', () => {
    const d = doc('24041', map, { title: 'SSL 卸载', ...TREE });
    const out = items(run([d], { granularity: 'case' }));
    assert.deepEqual(
      out.items.map((i) => [i.id, i.label, i.location.selector]),
      [
        ['24041:24041n2', 'bug 61500 证书链加载', 'n/24041n2'],
        ['24041:@4', '证书过期时报错', 'i/0/1'],
        ['24041:@6', '证书过期时报错（副本）', 'i/0/2'],
        ['24041:24041n8', '没有标签的节点', 'n/24041n8'],
      ],
    );
    const first = out.items[0];
    assert.deepEqual(first.fields, {
      kind: 'case',
      document: '24041',
      node: '24041n2',
      source: 'agile:mindmap:24041@1',
      root: 'FAMY',
      ancestors: TREE.ancestors,
      title: 'SSL 卸载',
      path: ['基本功能'],
      case_title: 'bug 61500 证书链加载',
    });
    // The defect is named in the case text, not in the title: the summary says where it was read.
    assert.match(first.summary!, /模块 SSL$/);
    for (const item of out.items) assertLocated(item, [d]);
  });

  it('locates a document without cases as a whole, and refuses positional cases among several documents', () => {
    const plain = doc('24042', { text: '提纲', children: [{ text: '没有用例' }] }, { title: '提纲', ...TREE });
    const out = items(run([plain], { granularity: 'case' }));
    assert.deepEqual(
      out.items.map((i) => i.id),
      ['24042'],
    );
    assert.deepEqual(
      out.warnings.map((w) => w.code),
      ['case-location.no_case_nodes'],
    );
    const d = doc('24043', map, { title: 'SSL 卸载', ...TREE });
    const error = refused(run([d, plain], { granularity: 'case' }));
    assert.equal(error.code, 'case-location.ambiguous_location');
    assert.deepEqual(error.documents, ['24043']);
    assert.match(error.fix, /每次只绑定一份文档/);
  });
});

describe('refusals and bad input', () => {
  it('refuses what is not a mind map of the slot, bad and repeated document ids, and an empty slot', () => {
    const d = doc('24051', smallMap('24051', 'x'), { title: 'x', ...TREE });
    assert.equal(refused(run([{ ...d, parser: 'json@1' }])).code, 'case-location.not_a_mindmap');
    assert.equal(refused(run([{ ...d, external: 'agile:mindmap:a:b' }])).code, 'case-location.invalid_document_id');
    assert.equal(refused(run([{ ...d, external: `agile:mindmap:${'1'.repeat(121)}` }])).code, 'case-location.invalid_document_id');
    assert.equal(refused(run([d, { ...d }])).code, 'case-location.duplicate_document');
    assert.equal(refused(run([{ ...d, slot: 'other' }])).code, 'case-location.no_document');
    const upload = items(run([{ ...d, external: null }]));
    assert.deepEqual([upload.items[0].id, upload.items[0].fields.source], [`src-${d.sha256.slice(0, 16)}`, `src:${d.sha256}`]);
  });

  it('refuses more items or a larger result than the check can answer in one sandbox call, with a fix', () => {
    const many = (n: number, text: string) => Array.from({ length: n }, (_, k) => ({ text: `用例 ${k} ${text}`, data: { priority: 2, resource: ['Function'] }, children: [{ text: '结果' }] }));
    const counted = doc('24061', { text: '大文档', children: [{ text: '分组', children: many(MAX_ITEMS + 1, '') }] }, { title: '大文档', ...TREE });
    const error = refused(run([counted], { granularity: 'case' }));
    assert.equal(error.code, 'case-location.too_large');
    assert.match(error.message, new RegExp(`最多 ${MAX_ITEMS} 个`));
    assert.match(error.fix, /granularity document/);
    assert.equal(items(run([counted])).items.length, 1);
    const fits = doc('24062', { text: '大文档', children: [{ text: '分组', children: many(MAX_ITEMS, '') }] }, { title: '大文档', ...TREE });
    assert.equal(items(run([fits], { granularity: 'case' })).items.length, MAX_ITEMS);
    // Long texts: the byte budget of the projection's own output refuses first.
    const long = doc('24063', { text: '大文档', children: [{ text: '分组', children: many(2500, '说明'.repeat(600)) }] }, { title: '大文档', ...TREE });
    assert.match(refused(run([long], { granularity: 'case' })).message, /字节/);
  });

  it('is total and deterministic on hostile input', () => {
    for (const [k, input] of hostileInputs().entries()) {
      const out = assertTotal(project, input, `hostile ${k}`);
      assert.ok(ProjectionOutput.safeParse(out).success, `hostile ${k}: ${JSON.stringify(out).slice(0, 200)}`);
    }
    assert.equal(sha256('x').length, 64);
  });
});

for (const granularity of ['document', 'case']) it(`a directory identifier belongs to both sibling documents at ${granularity} granularity`, () => {
  // The folder declares the identifier as a whole field; a prose folder name declares nothing (famx-id-fields@1).
  const tree = { ...TREE, ancestors: [...TREE.ancestors, 'story:20931'] };
  const a = doc('synthetic-a', smallMap('synthetic-a', '合成文档甲'), { title: '合成文档甲', ...tree });
  const b = doc('synthetic-b', smallMap('synthetic-b', '合成文档乙'), { title: '合成文档乙', ...tree });
  const projected = items(run([a, b], { granularity })).items;
  assert.deepEqual(new Set(projected.map(item => (item.fields as ItemFields).document)), new Set(['synthetic-a', 'synthetic-b']));
  for (const item of projected) {
    const { answer } = locateItem(locateInputOf(item.id, item.fields, BOUND));
    assert.deepEqual(answer.requirements, ['20931']);
    assert.deepEqual(answer.id_sources.find(id => id.id === '20931')?.from, ['folders']);
  }
});

describe('the case rule: tagged or marked (decision 18)', () => {
  const projectedIds = (model: Node): string[] => {
    const inputs = [boundDocument('2430', model, { title: '合成标题', root: 'FAMY', ancestors: ['030：FAMX/FAMY测试项目', '060：10.6.1'] })];
    const out = projectItems({ inputs, parameters: { granularity: 'case' }, context: { ...BOUND, parameters: { granularity: 'case' } } }) as { items: ProjectedItem[] };
    return out.items.map((item) => item.id);
  };
  const model = (children: Node[]): Node => ({ text: '合成文档', children: [{ text: '基本功能', data: { priority: 1 }, children }] });

  it('a node with the case priority and no tag is a case by the default marked rule', () => {
    const ids = projectedIds(model([
      { text: '查看部件状态', data: { priority: 2 }, children: [{ text: '结果符合预期' }] },
      { text: '带标签的用例', data: { priority: 2, resource: ['Function'] }, children: [{ text: '结果符合预期' }] },
    ]));
    assert.equal(ids.length, 2, JSON.stringify(ids));
    assert.ok(ids.every((id) => id.startsWith('2430:')), JSON.stringify(ids));
  });

  it('a node without a tag and without the case priority is not a case, so its document falls back to whole-document', () => {
    const ids = projectedIds(model([
      { text: '普通节点', data: { priority: 3 }, children: [{ text: '结果' }] },
    ]));
    assert.deepEqual(ids, ['2430'], JSON.stringify(ids));
  });

  it('a marked case inside another case is a case of its own', () => {
    const ids = projectedIds(model([
      { text: '外层用例', data: { priority: 2, resource: ['Function'] }, children: [
        { text: '操作步骤', children: [{ text: '结果符合预期' }] },
        { text: '嵌套用例', data: { priority: 2 }, children: [{ text: '嵌套结果' }] },
      ] },
    ]));
    assert.equal(ids.length, 2, JSON.stringify(ids));
  });

  it('the warning for a document without case nodes names the rule', () => {
    const inputs = [boundDocument('2431', model([{ text: '普通', data: { priority: 3 }, children: [] }]), { title: '无用例', root: 'FAMY', ancestors: ['030：FAMX/FAMY测试项目', '060：10.6.1'] })];
    const out = projectItems({ inputs, parameters: { granularity: 'case' }, context: { ...BOUND, parameters: { granularity: 'case' } } }) as { warnings: Array<{ code: string; message: string }> };
    const warning = out.warnings.find((w) => w.code === 'case-location.no_case_nodes');
    assert.ok(warning, JSON.stringify(out.warnings));
    assert.match(warning.message, /带标签或带标记/);
  });
});
