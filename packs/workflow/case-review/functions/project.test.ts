import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ItemProjection } from '../../../../contracts/src/run.ts';
import { DUPLICATED_ID } from '../../../../tests/fixtures/mindmaps/documents.ts';
import { fixtureText } from '../../../../tests/fixtures/mindmaps/index.ts';
import projectDefault, { LIMITS, projectItems } from './project.ts';
import { assertJson, isFailure, parseFixture, parseLarge, parseText, project, reviewProjection } from '../testing/test-support.ts';
import type { CaseItem, KityMinderModel, ProjectionResult } from './types.ts';

const review = parseFixture('review-150.km.json');
const byTitle = (items: CaseItem[], title: string): CaseItem[] => items.filter((item) => item.fields.title === title);
const one = (items: CaseItem[], title: string): CaseItem => {
  const found = byTitle(items, title);
  assert.equal(found.length, 1, title);
  return found[0];
};
const codesOf = (out: ProjectionResult): string[] => out.warnings.map((warning) => warning.code);

/** A hand-written model in the parser's shape (or a broken one); children are node indexes. */
function model(nodes: unknown[]): KityMinderModel {
  return { doubleEncoded: false, meta: {}, nodes: nodes as unknown as KityMinderModel['nodes'], duplicateIds: [], missingIds: 0, nulRemoved: 0 };
}

/** A KityMinder document as JSON text: root with the given children. */
function mindMap(children: unknown[], rootData: object = { id: 'root', text: '根' }): string {
  return JSON.stringify({ root: { data: rootData, children }, template: 'right', theme: 'classic', version: '1.4.43' });
}

const caseNode = (id: unknown, text: string, resource: unknown = ['Functional'], children: unknown[] = [{ data: { id: `${String(id)}-e`, text: '成功' } }], extra: object = {}) => ({
  data: { id, text, priority: 2, resource, ...extra },
  children,
});

// The fixture as it was built (tests/fixtures/mindmaps/documents.ts), written out by hand.
const UNTAGGED = ['relay endpoint add 192.0.2.41 80 后 show endpoints', '删除端点后会话迁移到其他端点', '批量添加 16 个端点'];
const GROUPS: Array<[string, number]> = [
  ['拓扑：客户端-网关-两台后端（192.0.2.21、192.0.2.22）', 0],
  ['CLI', 13],
  ['WebUI', 5],
  ['基本功能', 21],
  ['探测结果', 12],
  ['权重联动', 6],
  ['日志', 3],
  ['异常处理', 5],
  ['端点操作', 2],
  ['会话保持', 2],
  ['端点批量操作', 3],
  ['兼容性', 3],
  ['压力', 3],
  ['配置保存与恢复', 4],
  ['no 与 clear', 2],
  ['最大配置', 1],
  ['安全', 1],
  ['数据库', 2],
  ['待补充', 0],
];

describe('projection of the review fixture (default: caseRule marked)', () => {
  const { items, groups, unnumbered, warnings } = reviewProjection();

  it('projects 67 cases: the 64 tagged cases and the three untagged cases; the tagged group node is not an item', () => {
    assert.equal(review.model.nodes.length, 172);
    assert.equal(items.length, 67);
    assert.deepEqual(byTitle(items, '会话保持'), []);
    for (const title of UNTAGGED) assert.equal(byTitle(items, title).length, 1, title);
    for (const title of ['开启会话保持后同一客户端落到同一后端', '会话保持超时后重新调度']) {
      assert.equal(one(items, title).fields.nested, false, title);
      assert.deepEqual(one(items, title).fields.path.slice(-1), ['会话保持']);
    }
    // A tagged node with priority 1 that holds no case is a case.
    assert.equal(one(items, '探测超时时间内无响应判定失败').fields.priority, 1);
  });

  it('counts the untagged nodes in the case form in a warning with projected: true', async () => {
    const warning = warnings.find((w) => w.code === 'case-review.untagged_cases');
    assert.ok(warning);
    assert.equal(warning.data?.count, 3);
    assert.equal(warning.data?.projected, true);
    const titles = await Promise.all((warning.data?.nodes as string[]).map(async (selector) => (await review.locate(selector))?.text));
    assert.deepEqual(titles, UNTAGGED);
  });

  it('locates every item at its node through the kityminder@1 selector, identical to the parser selector', async () => {
    for (const item of items) {
      assert.equal(item.location.parser, 'kityminder@1');
      const node = review.model.nodes.find((candidate) => candidate.selector === item.location.selector);
      assert.ok(node, item.location.selector);
      assert.equal(node.text, item.fields.title);
      assert.equal((await review.locate(item.location.selector))?.text, item.fields.title);
    }
    assert.equal(items.filter((item) => item.location.selector.startsWith('n/')).length, 65);
  });

  it('builds ids from the document id and data.id; every copy of a duplicated id gets a numbered pack identity', () => {
    const ids = items.map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const item of items) if (item.fields.nodeId !== DUPLICATED_ID) assert.equal(item.id, `880001:${item.fields.nodeId}`);
    const copies = items.filter((item) => item.fields.nodeId === DUPLICATED_ID);
    assert.deepEqual(
      copies.map((item) => item.id),
      [`880001:${DUPLICATED_ID}#1`, `880001:${DUPLICATED_ID}#2`],
    );
    assert.deepEqual(unnumbered, [`880001:${DUPLICATED_ID}#1`, `880001:${DUPLICATED_ID}#2`]);
    assert.ok(copies.every((item) => item.location.selector.startsWith('i/')), 'a duplicated id cannot address a node');
    const duplicate = warnings.filter((warning) => warning.code === 'case-review.node_id_duplicate');
    assert.equal(duplicate.length, 1, 'one summary per document');
    assert.deepEqual(duplicate[0].data, { cases: 2, ids: 1, examples: [DUPLICATED_ID] });
  });

  it('keeps titles as written and the ancestor path from the root', () => {
    const negative = one(items, 'relay endpoint weight 192.0.2.21 101');
    assert.deepEqual(negative.fields.path, ['31057-示例网关支持HTTP探活与权重联动', '基本功能', '权重联动']);
    assert.equal(negative.label, 'relay endpoint weight 192.0.2.21 101');
    assert.equal(negative.fields.document, '880001');
  });

  it('takes expected results from the children: none, one or several', () => {
    assert.deepEqual(one(items, '后端恢复后重新加入调度').fields.expected, []);
    assert.equal(one(items, '后端恢复后重新加入调度').fields.expectedCount, 0);
    assert.deepEqual(one(items, '连续失败达到重试次数后摘除后端').fields.expected, ['后端状态变为 down', '新连接不再转发到该后端']);
    assert.equal(one(items, '连续失败达到重试次数后摘除后端').fields.expectedCount, 2);
    assert.equal(items.filter((item) => item.fields.expectedCount === 1).length, 65);
  });

  it('reads steps (also a step with priority 20) and priority-3 preconditions, with the leaves below a step as its expected results', () => {
    const withPrecondition = one(items, '修改探测间隔后立即生效').fields;
    assert.deepEqual(withPrecondition.preconditions, ['已配置 pool1，探测间隔为 10 秒']);
    assert.deepEqual(withPrecondition.steps, [{ text: 'widget health interval pool1 2', expected: ['2 秒后按新间隔发出探测'] }]);
    assert.deepEqual(withPrecondition.expected, ['2 秒后按新间隔发出探测']);
    const none = one(items, '后端端口不可达时探测超时').fields;
    assert.deepEqual(none.preconditions, ['无']);
    assert.equal(none.steps[0].text, '1.relay endpoint add 192.0.2.23 81\n2.后端不监听 81 端口');
    assert.deepEqual(none.expected, ['探测失败，后端状态为 down']);
    assert.deepEqual(one(items, '删除池后健康检查配置一并删除').fields.steps, [{ text: '1.widget pool delete pool1\n2.show health', expected: ['不再显示 pool1 的健康检查配置'] }]);
    assert.deepEqual(
      byTitle(items, '添加 - 端点').map((item) => item.fields.steps[0].text),
      ['relay endpoint add 192.0.2.31 80', 'relay endpoint add 192.0.2.32 8080'],
    );
    assert.equal(items.filter((item) => item.fields.steps.length > 0).length, 9);
  });

  it('projects a case below a case as its own item, with a warning, and leaves it out of the outer expected results', () => {
    const outer = one(items, '后端全部不健康');
    const inner = one(items, '恢复一台后端后');
    assert.deepEqual(outer.fields.expected, ['新连接返回 503']);
    assert.equal(outer.fields.nested, false);
    assert.equal(inner.fields.nested, true);
    assert.deepEqual(inner.fields.path.slice(-1), ['后端全部不健康']);
    const nested = warnings.filter((w) => w.code === 'case-review.nested_case');
    assert.equal(nested.length, 1);
    assert.equal(nested[0].item, inner.id);
    assert.deepEqual(nested[0].data, { outer: outer.id });
  });

  it('names the tagged group node once, at its own node', async () => {
    const tagged = warnings.filter((w) => w.code === 'case-review.tagged_group');
    assert.equal(tagged.length, 1);
    assert.equal((await review.locate(tagged[0].node as string))?.text, '会话保持');
  });

  it('keeps repeated titles under different paths as separate items', () => {
    const repeated = byTitle(items, 'widget health interval pool1 5');
    assert.equal(repeated.length, 2);
    assert.deepEqual(
      repeated.map((item) => item.fields.path.at(-1)),
      ['IPv4', 'IPv6'],
    );
  });

  it('marks negative cases by the canonical tag and keeps the tags as written', () => {
    // 反向只认闭集精确原文 negative。Negative、负向不再折成反向，标签原文仍保留。
    assert.deepEqual(
      items.filter((item) => item.fields.negative).map((item) => item.fields.title),
      [
        'widget health retries pool1 0',
        'relay endpoint weight 192.0.2.22 abc',
        '删除不存在的池',
      ],
    );
    assert.ok(items.filter((item) => item.fields.negative === true).every((item) => item.fields.tags.includes('negative')));
    assert.deepEqual(one(items, '健康检查摘除后端后按剩余后端的权重分配').fields.tags, ['Integration', '20260301ADD']);
    assert.deepEqual(one(items, '探测间隔为 1 秒时每秒探测一次').fields.tagsNormalized, []);
  });

  it('keeps priority and degree as written: a typo stays visible, a missing priority is null, degree "null" is null', () => {
    assert.equal(one(items, '非管理员账号不能修改健康检查').fields.priority, 20);
    assert.equal(one(items, 'widget session clear pool1 后探测不受影响').fields.priority, null);
    assert.equal(one(items, 'http 探测路径可配置为根路径').fields.degree, null);
    assert.equal(one(items, '探测类型输入 udp 被拒绝').fields.degree, 3);
  });

  it('reads autoid, auto and notes', () => {
    assert.deepEqual(
      items.filter((item) => item.fields.automated).map((item) => item.fields.autoid),
      ['730000000000000101', '730000000000000102', '730000000000000103'],
    );
    assert.deepEqual(
      items.filter((item) => item.fields.hasNote).map((item) => item.fields.title),
      ['探测请求携带配置的 Host 头'],
    );
  });

  it('lists the group nodes with their case counts, the tagged group node among them', async () => {
    assert.deepEqual(
      groups.map((group) => [group.label, group.cases]),
      GROUPS,
    );
    assert.equal(groups.find((group) => group.label === '待补充')?.priority, null);
    for (const group of groups) assert.equal((await review.locate(group.location.selector))?.text, group.label);
    const groupIds = new Set(groups.map((group) => group.id));
    assert.equal(groupIds.size, groups.length);
    assert.ok(items.every((item) => !groupIds.has(item.id)));
  });

  it('gives items the run item shape and only JSON values', () => {
    for (const item of items) assert.ok(ItemProjection.safeParse({ ...item, location: `src:${'a'.repeat(64)}/kityminder@1/${item.location.selector}` }).success, item.id);
    assertJson(reviewProjection());
    assert.deepEqual(
      warnings.map((warning) => warning.code),
      ['case-review.untagged_cases', 'case-review.node_id_duplicate', 'case-review.nested_case', 'case-review.tagged_group'],
    );
  });

  it('projects the double-encoded form and the agile answer to the same items', () => {
    assert.deepEqual(project(parseFixture('review-150.double.json').model), reviewProjection());
    const response = JSON.parse(fixtureText('review-150.agile-response.json')) as { code: number; data: string };
    assert.equal(response.code, 1000);
    assert.equal(typeof response.data, 'string');
    assert.deepEqual(project(parseText(JSON.stringify(response.data)).model), reviewProjection());
  });

  it('is deterministic', () => {
    assert.deepEqual(project(parseFixture('review-150.km.json').model), reviewProjection());
  });
});

describe('caseRule marked: the team template marker', () => {
  const marked = project(review.model, '880001', { caseRule: 'marked' });

  it('also projects the untagged cases, with no tags and an unknown negative flag', () => {
    assert.equal(marked.items.length, 67);
    const untagged = marked.items.filter((item) => item.fields.tags.length === 0);
    assert.deepEqual(
      untagged.map((item) => [item.fields.title, item.fields.negative, item.fields.expected, item.fields.preconditions, item.fields.automated]),
      [
        ['relay endpoint add 192.0.2.41 80 后 show endpoints', null, ['show endpoints 显示 192.0.2.41 端口 80'], [], false],
        ['删除端点后会话迁移到其他端点', null, ['会话迁移到 192.0.2.42'], ['已有两个端点并建立会话'], false],
        ['批量添加 16 个端点', null, ['show endpoints 显示 16 个端点'], [], true],
      ],
    );
    assert.deepEqual(one(marked.items, '删除端点后会话迁移到其他端点').fields.steps, [{ text: 'relay endpoint delete 192.0.2.41', expected: ['会话迁移到 192.0.2.42'] }]);
    assert.equal(marked.groups.find((group) => group.label === '端点批量操作')?.cases, 3);
    const warning = marked.warnings.find((w) => w.code === 'case-review.untagged_cases');
    assert.equal(warning?.data?.projected, true);
    assert.equal(warning?.data?.count, 3);
  });

  it('caseRule tagged restricts items to tagged cases only', () => {
    const tagged = project(review.model, '880001', { caseRule: 'tagged' });
    assert.equal(tagged.items.length, 64);
    assert.deepEqual(tagged.items, marked.items.filter((item) => item.fields.tags.length > 0));
    const warning = tagged.warnings.find((w) => w.code === 'case-review.untagged_cases');
    assert.equal(warning?.data?.projected, false);
    assert.equal(warning?.data?.count, 3);
  });

  it('projects the untagged document under the default marked rule, and refuses it under tagged with the count and the fix', () => {
    const untagged = parseFixture('untagged.km.json').model;
    const out = projectItems({ documents: [{ documentId: '31200', model: untagged }] });
    assert.ok(!isFailure(out));
    assert.equal(out.items.length, 3);
    assert.deepEqual(
      out.items.map((item) => [item.fields.title, item.fields.priority, item.fields.degree]),
      [
        ['relay endpoint add 192.0.2.51 80', 2, 1],
        ['relay endpoint weight 192.0.2.51 0', 2, 2],
        ['端点不可达时自动摘除', 2, 2],
      ],
    );
    assert.deepEqual(out.items[2].fields.preconditions, ['无']);
    assert.deepEqual(out.items[2].fields.steps, [{ text: '1.relay endpoint add 192.0.2.52 81\n2.后端不监听 81 端口', expected: ['端点状态为 down'] }]);

    const refused = projectItems({ documents: [{ documentId: '31200', model: untagged }], parameters: { caseRule: 'tagged' } });
    assert.ok(isFailure(refused));
    assert.equal(refused.error.code, 'case-review.no_case');
    assert.match(refused.error.message, /3 个没有标签的节点像用例/);
    assert.match(refused.error.fix, /caseRule/);
  });

  it('takes only an untagged node with the case priority, children and no case below it', () => {
    const parsed = parseText(
      mindMap([
        { data: { id: 'leaf', text: '没有子节点', priority: 2 } },
        { data: { id: 'holder', text: '下面有用例', priority: 2 }, children: [caseNode('inner', '内层用例')] },
        { data: { id: 'p3', text: '优先级 3', priority: 3 }, children: [{ data: { id: 'p3e', text: '期望' } }] },
        { data: { id: 'ok', text: '像用例', priority: 2 }, children: [{ data: { id: 'oke', text: '期望' } }] },
      ]),
    );
    const out = project(parsed.model, 'doc', { caseRule: 'marked' });
    assert.deepEqual(
      out.items.map((item) => item.fields.title),
      ['内层用例', '像用例'],
    );
    assert.deepEqual(
      out.groups.map((group) => group.label),
      ['没有子节点', '下面有用例', '优先级 3'],
    );
    const custom = project(parsed.model, 'doc', { caseRule: 'marked', casePriority: 3 });
    assert.deepEqual(
      custom.items.map((item) => item.fields.title),
      ['内层用例', '优先级 3'],
    );
  });
});

describe('small and large documents', () => {
  it('projects the tiny document to one item', () => {
    const { items, groups, warnings } = project(parseFixture('tiny.km.json').model, 'tiny');
    assert.equal(items.length, 1);
    assert.equal(groups.length, 1);
    assert.deepEqual(warnings, []);
    assert.deepEqual(items[0].fields.expected, ['show pools 显示 pool1']);
    assert.deepEqual(items[0].fields.path, ['需求 4100-示例池管理', '基本功能']);
  });

  it('refuses a document without any case node, with a fix', () => {
    const out = projectItems({ documents: [{ slot: 'mindmap', documentId: 'outline', model: parseFixture('outline.km.json').model }] });
    assert.ok(isFailure(out));
    assert.equal(out.error.code, 'case-review.no_case');
    assert.deepEqual(out.error.documents, ['outline']);
    assert.match(out.error.message, /outline/);
    assert.doesNotMatch(out.error.message, /没有标签的节点像用例/);
    assert.ok(out.error.fix.length > 0);
    const marked = projectItems({ documents: [{ documentId: 'outline', model: parseFixture('outline.km.json').model }], parameters: { caseRule: 'marked' } });
    assert.ok(isFailure(marked));
    assert.equal(marked.error.code, 'case-review.no_case');
  });

  it('refuses when any of several documents has no case, and names it', () => {
    const out = projectItems({
      documents: [
        { slot: 'mindmap', documentId: 'a', model: parseFixture('tiny.km.json').model },
        { slot: 'mindmap', documentId: 'b', model: parseFixture('outline.km.json').model },
      ],
    });
    assert.ok(isFailure(out));
    assert.deepEqual(out.error.documents, ['b']);
  });

  it('projects several documents with ids under each document id', () => {
    const out = projectItems({
      documents: [
        { slot: 'mindmap', documentId: 'a', model: parseFixture('tiny.km.json').model },
        { slot: 'mindmap', documentId: 'b', model: parseFixture('tiny.km.json').model },
      ],
    });
    assert.ok(!isFailure(out));
    assert.deepEqual(
      out.items.map((item) => item.id.split(':')[0]),
      ['a', 'b'],
    );
    assert.equal(out.items[0].id.split(':')[1], out.items[1].id.split(':')[1]);
  });

  it('refuses a repeated document id', () => {
    const tiny = parseFixture('tiny.km.json').model;
    const out = projectItems({ documents: [{ documentId: 'a', model: tiny }, { documentId: 'a', model: tiny }] });
    assert.ok(isFailure(out));
    assert.equal(out.error.code, 'case-review.invalid_input');
  });

  it('projects the template document', () => {
    const { items } = project(parseFixture('template.km.json').model, 'template');
    assert.equal(items.length, 22);
    const upgrade = one(items, '旧版本升级到新版本').fields;
    assert.deepEqual(upgrade.preconditions, ['无']);
    assert.deepEqual(upgrade.expected, ['升级成功，命令改动后的配置自动转换']);
  });

  it('stays linear on the 3,000-node document', async () => {
    const parsed = parseLarge();
    assert.ok(parsed.model.nodes.length > 2900 && parsed.model.nodes.length < 3100, String(parsed.model.nodes.length));
    const start = performance.now();
    const { items, groups } = project(parsed.model, 'large');
    const ms = performance.now() - start;
    assert.ok(items.length > 1000, String(items.length));
    assert.equal(groups.length, 12 + 12 + 12 * 3 * 4);
    assert.ok(ms < 1000, `${ms} ms`);
    for (const item of items.slice(0, 200)) assert.equal((await parsed.locate(item.location.selector))?.text, item.fields.title);
  });

  it('handles 60,000 nodes and 950 children of one node in linear time', () => {
    const wide = Array.from({ length: 950 }, (_, i) => caseNode(`w${i}`, `用例 ${i}`));
    const big: unknown[] = [];
    for (let g = 0; g < 30; g++) big.push({ data: { id: `g${g}`, text: `组 ${g}`, priority: 1 }, children: Array.from({ length: 1000 }, (_, i) => caseNode(`c${g}-${i}`, `用例 ${i}`)) });
    for (const children of [wide, big]) {
      const parsed = parseText(mindMap(children));
      const start = performance.now();
      const { items } = project(parsed.model, 'doc', undefined, { outputBytes: 64 * 1024 * 1024 });
      const ms = performance.now() - start;
      assert.equal(items.length, children === wide ? 950 : 30_000);
      assert.ok(ms < 3000, `${ms} ms`);
    }
  });
});

describe('the output limit', () => {
  it('refuses a result above limits.outputBytes with a fix, and accepts one of exactly that size', () => {
    const exact = Buffer.byteLength(JSON.stringify(reviewProjection()));
    assert.deepEqual(project(review.model, '880001', undefined, { outputBytes: exact }), reviewProjection());
    const out = projectItems({ documents: [{ documentId: '880001', model: review.model }], limits: { outputBytes: exact - 1 } });
    assert.ok(isFailure(out));
    assert.equal(out.error.code, 'case-review.too_large');
    assert.match(out.error.message, new RegExp(`${exact} 字节`));
    assert.match(out.error.fix, /拆成几份/);
    assert.deepEqual(out.error.documents, ['880001']);
    assert.ok(Buffer.byteLength(JSON.stringify(out)) <= exact - 1);
  });

  it('keeps a tiny limit total: the refusal itself stays within it', () => {
    const out = projectItems({ documents: [{ documentId: '880001', model: review.model }], limits: { outputBytes: 1024 } });
    assert.ok(isFailure(out));
    assert.equal(out.error.code, 'case-review.too_large');
    assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 1024);
  });

  it('uses the sandbox default of 8 MiB and ignores an invalid limit with a warning', () => {
    assert.equal(LIMITS.outputBytes, 8 * 1024 * 1024);
    for (const outputBytes of [0, 1023, 1.5, '9', null]) {
      const out = projectItems({ documents: [{ documentId: 't', model: parseFixture('tiny.km.json').model }], limits: { outputBytes } });
      assert.ok(!isFailure(out));
      assert.deepEqual(codesOf(out), ['case-review.parameter_ignored']);
    }
  });
});

describe('identity, location and hostile structure', () => {
  it('addresses missing, duplicated, long, "@" and special-character ids like the parser and lists the pack identities', () => {
    const long = 'x'.repeat(300);
    const parsed = parseText(
      mindMap([
        caseNode(undefined, '没有编号'),
        caseNode('dup', '重复一'),
        caseNode('dup', '重复二'),
        caseNode(long, '编号很长'),
        caseNode('@5', '以 @ 开头'),
        caseNode('a/b:c d%', '特殊字符'),
        caseNode(42, '数字编号'),
      ]),
    );
    const out = project(parsed.model, 'doc');
    for (const item of out.items) {
      const node = parsed.model.nodes.find((candidate) => candidate.selector === item.location.selector);
      assert.ok(node, item.location.selector);
      assert.equal(node.text, item.fields.title);
    }
    const ids = out.items.map((item) => item.id);
    assert.deepEqual(ids, ['doc:@1', 'doc:dup#1', 'doc:dup#2', 'doc:@7', 'doc:@5', 'doc:a/b:c d%', 'doc:42']);
    assert.deepEqual(out.unnumbered, ['doc:@1', 'doc:dup#1', 'doc:dup#2', 'doc:@7']);
    assert.ok(ids.every((id) => id.length <= LIMITS.maxItemId));
    // "@5" is a real id here, so the position identity of node 5 would collide: positions never take a real id.
    assert.equal(out.items.find((item) => item.fields.title === '以 @ 开头')?.location.selector.startsWith('i/'), true);
    assert.equal(out.items.find((item) => item.fields.title === '特殊字符')?.location.selector, 'n/a%2Fb%3Ac%20d%25');
    assert.equal(out.items.find((item) => item.fields.title === '数字编号')?.location.selector, 'n/42');
    assert.deepEqual(codesOf(out), ['case-review.node_id_duplicate', 'case-review.node_id_missing', 'case-review.node_id_unusable']);
    assert.deepEqual(out.warnings[0].data, { cases: 2, ids: 1, examples: ['dup'] });
  });

  it('never lets a pack identity take the id of another node', () => {
    // Node 1 has no id, so its position identity would be doc:@1, which node 2 uses as its real id.
    const { items, unnumbered } = project(model([{ data: { id: 'r', text: 'root' }, children: [1, 2] }, { data: { text: 'a', resource: ['x'] } }, { data: { id: '@1', text: 'b', resource: ['x'] } }]), 'doc');
    assert.deepEqual(
      items.map((item) => item.id),
      ['doc:@1#2', 'doc:@1'],
    );
    assert.deepEqual(unnumbered, ['doc:@1#2']);
  });

  it('does not let a pasted copy take the identity of the case it was copied from', () => {
    const original = caseNode('a1', '原用例');
    const before = project(parseText(mindMap([{ data: { id: 'g1', text: '组一', priority: 1 }, children: [] }, { data: { id: 'g2', text: '组二', priority: 1 }, children: [original] }])).model, 'd');
    assert.deepEqual(before.items.map((item) => item.id), ['d:a1']);
    assert.deepEqual(before.unnumbered, []);
    // The author pastes an edited copy that keeps data.id a1 into the earlier group.
    const copy = caseNode('a1', '复制后改过的用例');
    const after = project(parseText(mindMap([{ data: { id: 'g1', text: '组一', priority: 1 }, children: [copy] }, { data: { id: 'g2', text: '组二', priority: 1 }, children: [original] }])).model, 'd');
    assert.deepEqual(
      after.items.map((item) => [item.fields.title, item.id]),
      [
        ['复制后改过的用例', 'd:a1#1'],
        ['原用例', 'd:a1#2'],
      ],
    );
    assert.deepEqual(after.unnumbered, ['d:a1#1', 'd:a1#2'], 'neither copy keeps the plain identity, so none is carried over');
  });

  it('numbers items among cases only: an id shared with a group leaves the case its plain identity', () => {
    const parsed = parseText(mindMap([{ data: { id: 'same', text: '组', priority: 1 }, children: [caseNode('same', '用例')] }]));
    const out = project(parsed.model, 'd');
    assert.deepEqual(out.items.map((item) => item.id), ['d:same']);
    assert.deepEqual(out.unnumbered, []);
    assert.ok(out.items[0].location.selector.startsWith('i/'), 'the id is not unique among all nodes, so the selector is positional');
    assert.equal(out.groups[0].id, 'd:@1');
    assert.deepEqual(codesOf(out), [], 'no numbering warning for a group');
  });

  it('keeps every item id within 200 characters, also with a copy suffix', () => {
    const id = 'y'.repeat(198);
    const out = project(parseText(mindMap([caseNode(id, '副本一'), caseNode(id, '副本二')])).model, 'd');
    assert.ok(out.items.every((item) => item.id.length <= LIMITS.maxItemId), JSON.stringify(out.items.map((item) => item.id.length)));
    assert.deepEqual(out.items.map((item) => item.id), ['d:@1', 'd:@3']);
    assert.deepEqual(out.unnumbered, ['d:@1', 'd:@3']);
    for (const item of out.items) assert.ok(ItemProjection.safeParse({ ...item, location: `src:${'a'.repeat(64)}/kityminder@1/${item.location.selector}` }).success);
  });

  it('refuses a document id with a colon, white space or a control character, so ids of two documents cannot collide', () => {
    const tiny = parseFixture('tiny.km.json').model;
    for (const documentId of ['a:b', 'a b', ' a', 'a　b', 'a\u0007', 'a\u0085']) {
      const out = projectItems({ documents: [{ documentId, model: tiny }] });
      assert.ok(isFailure(out), JSON.stringify(documentId));
      assert.equal(out.error.code, 'case-review.invalid_input');
      assert.match(out.error.message, /冒号、空白或控制字符/);
    }
    const colliding = projectItems({
      documents: [
        { documentId: 'a', model: parseText(mindMap([caseNode('b:c', '甲')])).model },
        { documentId: 'a:b', model: parseText(mindMap([caseNode('c', '乙')])).model },
      ],
    });
    assert.ok(isFailure(colliding));
    assert.equal(colliding.error.code, 'case-review.invalid_input');
  });

  it('survives malformed models: bad child indexes, cycles, shared children, nodes that are not objects', () => {
    const nodes = [
      { data: { id: 'r', text: 'root' }, children: [1, 1, 0, -1, 2.5, 'x', 99, 2, 3] },
      { data: { id: 'c1', text: '用例', priority: 2, resource: ['Function'] }, children: [4] },
      null,
      { data: 'not an object', children: {} },
      { data: { id: 'e', text: '期望' }, children: [1] },
    ];
    const out = projectItems({ documents: [{ documentId: 'm', model: model(nodes) }] });
    assert.ok(!isFailure(out), JSON.stringify(out));
    assert.equal(out.items.length, 1);
    assert.deepEqual(out.items[0].fields.expected, []);
    assert.deepEqual(out.items[0].fields.steps, [{ text: '期望', expected: [] }]);
    const malformed = out.warnings.find((warning) => warning.code === 'case-review.model_malformed');
    assert.ok(malformed);
    assertJson(out);
  });

  it('stops at the depth limit with a warning on a 500-level chain', () => {
    const nodes: Array<{ data: object; children: number[] }> = [];
    for (let i = 0; i < 500; i++) nodes.push({ data: { id: `n${i}`, text: `第 ${i} 层`, ...(i === 10 || i === 400 ? { priority: 2, resource: ['Function'] } : {}) }, children: i < 499 ? [i + 1] : [] });
    const out = projectItems({ documents: [{ documentId: 'deep', model: model(nodes) }] });
    assert.ok(!isFailure(out));
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0].fields.path.length, 10);
    assert.ok(out.warnings.some((warning) => warning.code === 'case-review.depth_limit'));
    // Everything below the case at level 10 down to the limit is one step without an expected result.
    assert.deepEqual(out.items[0].fields.expected, []);
  });

  it('clips huge texts and lists, keeps counts complete and stays JSON', () => {
    const huge = '长'.repeat(1_000_000);
    const many = Array.from({ length: 300 }, (_, i) => ({ data: { id: `e${i}`, text: `期望 ${i}` } }));
    const tags = [...Array.from({ length: 150 }, (_, i) => `T${i}`), null, { x: 1 }, 7];
    const parsed = parseText(mindMap([caseNode('big', huge, tags, many)]));
    const out = projectItems({ documents: [{ documentId: 'big', model: parsed.model }] });
    assert.ok(!isFailure(out));
    const fields = out.items[0].fields;
    assert.equal([...fields.title].length, LIMITS.maxText);
    assert.ok(fields.title.endsWith('…'));
    assert.equal(fields.expected.length, LIMITS.maxList);
    assert.equal(fields.expectedCount, 300);
    assert.equal(fields.tags.length, LIMITS.maxList);
    // T0 这类标签不在闭集里，负向未声明，是 null，不是 false。
    assert.equal(fields.negative, null);
    assert.ok(out.items[0].label.length <= LIMITS.maxLabel);
    const codes = out.warnings.map((warning) => warning.code);
    for (const code of ['case-review.text_clipped', 'case-review.list_clipped', 'case-review.tag_not_text']) assert.ok(codes.includes(code), code);
    assertJson(out);
  });

  it('treats only a non-empty tag list as tagged; the untagged nodes in the case form are counted, not listed as groups', async () => {
    const parsed = parseText(
      mindMap([
        caseNode('a', '空标签', []),
        { data: { id: 'b', text: '没有标签', priority: 2 }, children: [{ data: { id: 'b1', text: '子' } }] },
        caseNode('c', '空白标签', ['  ']),
        caseNode('d', '标签不是数组', 'Function'),
      ]),
    );
    const { items, groups, warnings } = project(parsed.model, '880001', { caseRule: 'tagged' });
    assert.deepEqual(
      items.map((item) => item.fields.title),
      ['空白标签'],
    );
    assert.deepEqual(items[0].fields.tags, ['  ']);
    assert.deepEqual(items[0].fields.tagsNormalized, []);
    assert.equal(items[0].fields.negative, null, 'a blank tag says nothing about the case');
    assert.deepEqual(groups, []);
    const untagged = warnings.find((warning) => warning.code === 'case-review.untagged_cases');
    assert.deepEqual(
      await Promise.all((untagged?.data?.nodes as string[]).map(async (selector) => (await parsed.locate(selector))?.text)),
      ['空标签', '没有标签', '标签不是数组'],
    );

    // Under default marked: all 4 are cases
    const markedOut = project(parsed.model);
    assert.deepEqual(
      markedOut.items.map((item) => item.fields.title),
      ['空标签', '没有标签', '空白标签', '标签不是数组'],
    );
  });

  it('treats a tagged node with the group priority that holds cases as a group; groupPriority null turns that off', () => {
    const parsed = parseText(mindMap([{ data: { id: 'g', text: '带标签的分组', priority: 1, resource: ['Function'] }, children: [caseNode('c1', '用例一'), caseNode('c2', '用例二')] }]));
    const grouped = project(parsed.model, 'doc');
    assert.deepEqual(grouped.items.map((item) => [item.fields.title, item.fields.nested]), [
      ['用例一', false],
      ['用例二', false],
    ]);
    assert.deepEqual(grouped.groups.map((group) => [group.label, group.cases]), [['带标签的分组', 2]]);
    assert.deepEqual(codesOf(grouped), ['case-review.tagged_group']);
    const off = project(parsed.model, 'doc', { groupPriority: null });
    assert.deepEqual(off.items.map((item) => [item.fields.title, item.fields.nested]), [
      ['带标签的分组', false],
      ['用例一', true],
      ['用例二', true],
    ]);
  });

  it('keeps the summaries of every document when the per-node warnings run over the budget, and counts what was dropped per code', () => {
    const nestedCases = Array.from({ length: 120 }, (_, i) => caseNode(`n${i}`, `内层 ${i}`));
    const first = parseText(mindMap([caseNode('outer', '外层', ['Function'], nestedCases)])).model;
    const chain: Array<{ data: object; children: number[] }> = [];
    for (let i = 0; i < 260; i++) chain.push({ data: { id: `k${i}`, text: i === 3 ? 'x'.repeat(5000) : `第 ${i} 层`, ...(i === 2 ? { priority: 2, resource: ['Function'] } : {}) }, children: i < 259 ? [i + 1] : [] });
    const out = projectItems({ documents: [{ documentId: 'one', model: first }, { documentId: 'two', model: model(chain) }] });
    assert.ok(!isFailure(out));
    const codes = out.warnings.map((warning) => `${warning.document ?? ''} ${warning.code}`);
    assert.ok(codes.includes('two case-review.depth_limit'), 'the summary of the second document is kept');
    assert.ok(codes.includes('two case-review.text_clipped'));
    assert.equal(out.warnings.filter((warning) => warning.code === 'case-review.nested_case').length, 100);
    const clipped = out.warnings.at(-1);
    assert.equal(clipped?.code, 'case-review.warnings_clipped');
    assert.deepEqual(clipped?.data, { dropped: 20, codes: { 'case-review.nested_case': 20 } });
  });
});

describe('parameters and input checks', () => {
  it('reads the precondition priority, and turns the rule off with null', () => {
    const parsed = parseText(mindMap([caseNode('c', '用例', ['Function'], [{ data: { id: 'p', text: '前置', priority: 3 } }, { data: { id: 'e', text: '期望' } }])]));
    assert.deepEqual(project(parsed.model).items[0].fields.preconditions, ['前置']);
    const off = project(parsed.model, 'doc', { preconditionPriority: null }).items[0].fields;
    assert.deepEqual(off.preconditions, []);
    assert.deepEqual(off.expected, ['前置', '期望']);
    const other = project(parsed.model, 'doc', { preconditionPriority: 1 }).items[0].fields;
    assert.deepEqual(other.preconditions, []);
    const bad = projectItems({ documents: [{ documentId: 'd', model: parsed.model }], parameters: { preconditionPriority: 'three' } });
    assert.ok(!isFailure(bad));
    assert.equal(bad.warnings[0].code, 'case-review.parameter_ignored');
    assert.deepEqual(bad.items[0].fields.preconditions, ['前置']);
  });

  it('ignores invalid case parameters with a warning each and keeps the defaults', () => {
    const out = projectItems({ documents: [{ documentId: '880001', model: review.model }], parameters: { caseRule: 'all', casePriority: 0, groupPriority: 'one', preconditionPriority: 2.5 } });
    assert.ok(!isFailure(out));
    assert.deepEqual(
      out.warnings.filter((warning) => warning.code === 'case-review.parameter_ignored').map((warning) => warning.data?.parameter),
      ['caseRule', 'casePriority', 'groupPriority', 'preconditionPriority'],
    );
    assert.deepEqual(out.items, reviewProjection().items);
  });

  it('refuses malformed input without throwing', () => {
    const tiny = parseFixture('tiny.km.json').model;
    const inputs: unknown[] = [
      null,
      undefined,
      42,
      'documents',
      [],
      {},
      { documents: 'x' },
      { documents: [] },
      { documents: [null] },
      { documents: [{ model: tiny }] },
      { documents: [{ documentId: '', model: tiny }] },
      { documents: [{ documentId: '   ', model: tiny }] },
      { documents: [{ documentId: 'x'.repeat(121), model: tiny }] },
      { documents: [{ documentId: 'a' }] },
      { documents: [{ documentId: 'a', model: { nodes: [] } }] },
      { documents: [{ documentId: 'a', model: { nodes: 'x' } }] },
      { documents: [{ documentId: 'a', model: [] }] },
    ];
    for (const input of inputs) {
      const out = projectDefault(input);
      assert.ok(isFailure(out), JSON.stringify(input)?.slice(0, 80));
      assert.equal(out.error.code, 'case-review.invalid_input');
      assert.ok(out.error.message.length > 0 && out.error.fix.length > 0);
    }
  });

  it('turns an unexpected exception into a refusal', () => {
    const trap = { documents: [{ documentId: 'a', get model(): never { throw new Error('boom'); } }] };
    const out = projectDefault(trap);
    assert.ok(isFailure(out));
    assert.equal(out.error.code, 'case-review.internal_error');
    assert.match(out.error.message, /boom/);
  });

  it('accepts a numeric document id and gives the same result through the default export', () => {
    const tiny = parseFixture('tiny.km.json').model;
    const named = projectItems({ documents: [{ documentId: 7, model: tiny }] });
    assert.ok(!isFailure(named));
    assert.equal(named.items[0].id.startsWith('7:'), true);
    assert.deepEqual(projectDefault({ documents: [{ documentId: 7, model: tiny }] }), named);
  });
});
