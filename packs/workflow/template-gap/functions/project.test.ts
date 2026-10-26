import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ProjectionOutput } from '../../../../contracts/src/pack.ts';
import { TEST_TYPES, baseDocument, bytesOf, goldOf, nodeCount, outlineDocument, render, renamed, shuffled, withCase, withoutCategory, witnessCase, type DocumentSpec } from '../testing/mindmap.ts';
import { assertJson, bind, itemOf, parse, project, projectionInput, refuse, sha256, table } from '../testing/support.ts';
import projectDefault, { LIMITS, documentIdOf, projectDocuments } from './project.ts';
import { MAX_EVIDENCE } from './template.ts';
import type { DocumentFields, DocumentItem } from './types.ts';

const TEMPLATE = table('template-v3.json') as { categories: Array<{ id: string; label: string; required?: boolean }> };
const CATEGORIES = TEMPLATE.categories.map((category) => category.id);
const REQUIRED = TEMPLATE.categories.filter((category) => category.required !== false).map((category) => category.id);
const DOC = '900001';
const external = (id = DOC): string => `agile:mindmap:${id}`;

/** The item of a synthetic document read from the agile platform under document id DOC. */
const report = (doc: DocumentSpec, parameters: Record<string, unknown> = {}): DocumentItem => itemOf(doc, { external: external() }, parameters);

/** The fields the declared gold says the document has. */
function assertGold(fields: DocumentFields, doc: DocumentSpec, what: string): void {
  const gold = goldOf(doc, DOC);
  assert.equal(fields.caseCount, gold.caseCount, `${what}: case count`);
  assert.equal(fields.untagged, gold.untagged, `${what}: untagged`);
  assert.deepEqual(
    fields.categories.map((category) => category.id),
    CATEGORIES,
    `${what}: every category, in template order`,
  );
  for (const category of fields.categories) {
    const ids = gold.byCategory.get(category.id) ?? [];
    assert.equal(category.count, ids.length, `${what}: count of ${category.id}`);
    assert.equal(category.present, ids.length > 0, `${what}: presence of ${category.id}`);
    assert.deepEqual(category.evidence, ids.slice(0, MAX_EVIDENCE), `${what}: evidence of ${category.id}`);
  }
  const missing = REQUIRED.filter((id) => (gold.byCategory.get(id) ?? []).length === 0 && !fields.skipped.some((skip) => skip.category === id));
  assert.deepEqual(fields.missing, missing, `${what}: missing`);
}

/** The categories of an item without the document part of the evidence ids: what two names of one document share. */
const facts = (item: DocumentItem) => item.fields.categories.map((c) => ({ ...c, evidence: c.evidence.map((id) => id.slice(id.indexOf(':') + 1)) }));

describe('the synthetic document', () => {
  it('has about 180 nodes, shows every category, every test type with several cases, and lets each category go on its own', () => {
    const doc = baseDocument();
    const nodes = nodeCount(doc);
    assert.ok(nodes >= 170 && nodes <= 200, `${nodes} nodes`);
    const gold = goldOf(doc, DOC);
    for (const id of CATEGORIES) assert.ok((gold.byCategory.get(id) ?? []).length > 0, id);
    for (const id of TEST_TYPES) assert.ok((gold.byCategory.get(id) ?? []).length >= 3, id);
    assert.deepEqual(REQUIRED, CATEGORIES, 'every category of template v3 is required');
    assert.deepEqual(CATEGORIES.slice(0, 6), [...TEST_TYPES]);
    for (const id of CATEGORIES) {
      const left = goldOf(withoutCategory(doc, id), DOC);
      // 无标签的标记节点单独声明了 functional。删掉 functional 用例之后，这一类还在。
      const gone = id === 'functional' ? [] : [id];
      assert.deepEqual(CATEGORIES.filter((c) => (left.byCategory.get(c) ?? []).length === 0), gone, `removing every case of ${id} leaves the others shown`);
    }
  });
});

describe('projectDocuments', () => {
  it('gives one item per document in the projection-output@1 shape, with the fields the gold declares', () => {
    const doc = baseDocument();
    const bound = bind(doc, { external: `${external()}@4`, meta: { title: ' 小部件探测  测试用例 ', folders: ['示例产品', '030：示例测试项目', '101：2.1.0', '模块'], found: true } });
    const out = project([bound]);
    assert.ok(ProjectionOutput.safeParse(out).success, JSON.stringify(ProjectionOutput.safeParse(out).error?.issues.slice(0, 3)));
    assertJson(out);
    const [item] = out.items;
    assert.equal(item.id, DOC, 'the revision is not part of the document id');
    assert.equal(item.label, '小部件探测 测试用例', 'the label is the listed title with white space collapsed');
    assert.equal(item.fields.title, ' 小部件探测  测试用例 ', 'the title field keeps the title as listed');
    assert.deepEqual(item.fields.path, ['示例产品', '030：示例测试项目', '101：2.1.0', '模块']);
    // 分类状态、resource 原文和标签表是后来写进条目的，和类别计数分开。
    assert.deepEqual(Object.keys(item.fields), ['document', 'title', 'path', 'caseCount', 'untagged', 'case_rule', 'marked_only', 'data', 'categories', 'classifications', 'classification_status', 'unclassified', 'scope_complete', 'case_resources', 'tag_table', 'tag_undeclared_cases', 'command_coverage', 'missing', 'skipped']);
    assert.deepEqual(item.fields.skipped, []);
    assertGold(item.fields, doc, 'base');
    assert.deepEqual(out.warnings.map((warning) => warning.code), ['template-gap.tagged_group']);
    // The location is the root node, addressed as the parser addresses it.
    const parsed = parse(bytesOf(doc));
    assert.deepEqual(item.location, { parser: 'kityminder@1', selector: parsed.model.nodes[0].selector });
    assert.equal(parsed.locate(item.location.selector)?.text, doc.title);
    assert.match(item.summary, /用例 75 个/);
    assert.match(item.summary, /用例规则：标签或标记；其中 1 个只靠标记识别（没有标签）/);

    // With case_rule tagged
    const taggedOut = project([bound], { case_rule: 'tagged' });
    const [taggedItem] = taggedOut.items;
    assert.equal(taggedItem.fields.caseCount, 74);
    assert.equal(taggedItem.fields.untagged, 1);
    assert.equal(taggedItem.fields.case_rule, 'tagged');
    assert.equal(taggedItem.fields.marked_only, 0);
    assert.deepEqual(taggedOut.warnings.map((warning) => warning.code), ['template-gap.untagged_cases', 'template-gap.tagged_group']);
    assert.match(taggedItem.summary, /用例 74 个/);
    assert.match(taggedItem.summary, /用例规则：只认标签；其中 0 个只靠标记识别（没有标签）/);
    assert.match(taggedItem.summary, /另有 1 个没有标签、写法像用例的节点没有计入/);
  });

  it('reads the title from the mind-map root and the folders from `ancestors` when the reader gives no title or folders', () => {
    const doc = baseDocument();
    const item = itemOf(doc, { external: external(), meta: { ancestors: ['甲', '乙'] } });
    assert.equal(item.fields.title, doc.title);
    assert.deepEqual(item.fields.path, ['甲', '乙']);
    const upload = itemOf(bytesOf(doc));
    assert.equal(upload.id, `upload-${sha256(bytesOf(doc)).slice(0, 12)}`, 'an upload is named by its SHA-256');
    assert.deepEqual(upload.fields.path, []);
    assert.equal(itemOf(renamed(doc, 'r0blank00001', '   ')).label, '（无标题）');
  });

  describe('metamorphic relations (docs/hub-r4-architecture.md 6b)', () => {
    for (const category of CATEGORIES) {
      it(`removing every case of ${category} makes exactly it missing; adding one case of it makes it present again`, () => {
        const base = baseDocument();
        const without = withoutCategory(base, category);
        const gone = report(without);
        assertGold(gone.fields, without, `without ${category}`);
        const fact = gone.fields.categories.find((c) => c.id === category)!;
        if (category === 'functional') {
          // 无标签标记节点的 category_ids 仍是 functional，删光功能用例也不会让它消失。
          assert.deepEqual([fact.present, fact.count, fact.evidence], [true, 1, [`${DOC}:v99unez89wsx`]]);
          assert.ok(!gone.fields.missing.includes('functional'));
          assert.match(gone.summary, /24 个模板类别都已覆盖/);
        } else {
          assert.deepEqual([fact.present, fact.count, fact.evidence], [false, 0, []]);
          assert.deepEqual(gone.fields.missing, [category], 'exactly that category is missing, whatever its group');
          assert.match(gone.summary, new RegExp(`缺 1 个模板类别：${TEMPLATE.categories.find((c) => c.id === category)!.label}（${category}）`));
        }
        const witness = witnessCase(category);
        const restored = withCase(without, '其他', witness);
        const back = report(restored);
        assertGold(back.fields, restored, `${category} restored`);
        const again = back.fields.categories.find((c) => c.id === category)!;
        if (category === 'functional') {
          assert.equal(again.present, true);
          assert.ok(again.evidence.includes(`${DOC}:${witness.id}`));
          assert.ok(!back.fields.missing.includes('functional'));
        } else {
          assert.deepEqual([again.present, again.count, again.evidence], [true, 1, [`${DOC}:${witness.id}`]]);
          assert.deepEqual(back.fields.missing, []);
        }
      });
    }

    it('the report does not depend on the order of the cases', () => {
      const base = baseDocument();
      const expected = report(base);
      for (const seed of [1, 2, 3, 42, 2026]) {
        const order = shuffled(base, seed);
        assert.notDeepEqual(bytesOf(order), bytesOf(base), `seed ${seed} changes the order`);
        // 分类和 resource 按文档顺序走，visit 会变。类别计数、缺失和摘要不随顺序变。
        assert.equal(report(order).summary, expected.summary, `seed ${seed}`);
        assert.deepEqual(report(order).fields.categories, expected.fields.categories, `seed ${seed}`);
        assert.deepEqual(report(order).fields.missing, expected.fields.missing, `seed ${seed}`);
      }
      const gap = withoutCategory(withoutCategory(base, 'negative'), 'configuration_sync');
      const gapReport = report(gap);
      const gapShuffled = report(shuffled(gap, 9));
      assert.equal(gapShuffled.summary, gapReport.summary, 'a document with gaps too');
      assert.deepEqual(gapShuffled.fields.missing, gapReport.fields.missing);
    });

    it('limits (README deviations 6 and 7): numbered copies follow the document order and uploads their bytes; presence, counts and summaries do not', () => {
      const km = (...cases: unknown[]) => new TextEncoder().encode(JSON.stringify({ root: { data: { id: 'r', text: '根' }, children: cases }, template: 'right', theme: 'classic', version: '1.4.43' }));
      const kase = (id: string | null, text: string, category: string) => ({ data: { ...(id === null ? {} : { id }), text, priority: 2, category_ids: [category] }, children: [{ data: { id: `${id ?? text}e`, text: '期望' }, children: [] }] });
      // 类别只认 category_ids。两个同号用例按文档顺序编号，对调之后编号跟着走。
      const a = kase('dup', '老->新 升级', 'upgrade_old_to_new');
      const b = kase('dup', 'query pool', 'command_query');
      const first = itemOf(km(a, b), { external: external() });
      const second = itemOf(km(b, a), { external: external() });
      const evidence = (item: DocumentItem, id: string) => item.fields.categories.find((c) => c.id === id)!.evidence;
      assert.deepEqual([evidence(first, 'upgrade_old_to_new'), evidence(first, 'command_query')], [[`${DOC}:dup#1`], [`${DOC}:dup#2`]]);
      assert.deepEqual([evidence(second, 'upgrade_old_to_new'), evidence(second, 'command_query')], [[`${DOC}:dup#2`], [`${DOC}:dup#1`]]);
      // Without ids: numbered by node position.
      const third = itemOf(km(kase(null, '老->新 升级', 'compatibility'), kase('x1', '其他', 'functional')), { external: external() });
      const fourth = itemOf(km(kase('x1', '其他', 'functional'), kase(null, '老->新 升级', 'compatibility')), { external: external() });
      assert.notDeepEqual(evidence(third, 'compatibility'), evidence(fourth, 'compatibility'));
      for (const [x, y] of [[first, second], [third, fourth]]) {
        assert.deepEqual(x.fields.categories.map((c) => [c.id, c.present, c.count]), y.fields.categories.map((c) => [c.id, c.present, c.count]));
        assert.deepEqual([x.fields.missing, x.summary], [y.fields.missing, y.summary]);
      }
      // An upload is named by its bytes: the same map in another order is another upload, with the same facts.
      const base = baseDocument();
      const upload = itemOf(bytesOf(base));
      const reordered = itemOf(bytesOf(shuffled(base, 42)));
      assert.notEqual(upload.id, reordered.id);
      assert.deepEqual(facts(reordered), facts(upload));
      assert.deepEqual([reordered.fields.missing, reordered.summary, reordered.label], [upload.fields.missing, upload.summary, upload.label]);
    });

    it('a category skipped with a reason is listed apart and not missing, for a test type and for any other category', () => {
      for (const category of ['stress', 'audit_log']) {
        const gap = withoutCategory(baseDocument(), category);
        const reason = '用户说：本功能不涉及';
        const item = report(gap, { skipped: [{ category, reason }] });
        assert.deepEqual(item.fields.missing, []);
        assert.deepEqual(item.fields.skipped, [{ category, reason }]);
        assert.equal(item.fields.categories.find((c) => c.id === category)?.present, false, 'skipping never makes a category present');
        assert.match(item.summary, new RegExp(`模板类别没有缺失（1 个声明跳过）；参数 skipped 声明跳过 1 个：.+（${category}）`));
      }
    });
  });

  it('applies a skip that names a document to that document only, however the document is written', () => {
    const gap = withoutCategory(baseDocument(), 'stress');
    const a = bind(renamed(gap, 'r0docaaaaaa1'), { external: `${external('900011')}@3` });
    const b = bind(renamed(gap, 'r0docbbbbbb2'), { external: external('900012') });
    const c = bind(renamed(gap, 'r0docccccc03'));
    const uploadId = `upload-${c.sha256.slice(0, 12)}`;
    for (const name of ['900011', '900011@3', 'agile:mindmap:900011', 'agile:mindmap:900011@7']) {
      const out = project([a, b, c], { skipped: [{ category: 'stress', reason: '只有 900011 不涉及性能', document: name }] });
      assert.deepEqual(
        out.items.map((item) => [item.id, item.fields.missing, item.fields.skipped.map((s) => s.category)]),
        [
          ['900011', [], ['stress']],
          ['900012', ['stress'], []],
          [uploadId, ['stress'], []],
        ],
        name,
      );
    }
    for (const name of [uploadId, `src:${c.sha256}`]) {
      const out = project([a, b, c], { skipped: [{ category: 'stress', reason: '上传的这份不涉及性能', document: name }] });
      assert.deepEqual(out.items.map((item) => item.fields.missing), [['stress'], ['stress'], []], name);
    }
    const everywhere = project([a, b, c], { skipped: [{ category: 'stress', reason: '都不涉及性能' }, { category: 'database', reason: '只有 900012', document: '900012' }] });
    assert.deepEqual(everywhere.items.map((item) => item.fields.skipped.map((s) => s.category)), [['stress'], ['stress', 'database'], ['stress']]);
  });

  it('refuses the whole run when a skip cannot be applied, naming each problem and the documents of the run', () => {
    const gap = withoutCategory(baseDocument(), 'stress');
    const a = bind(renamed(gap, 'r0docaaaaaa1'), { external: external('900011') });
    const b = bind(renamed(gap, 'r0docbbbbbb2'), { external: external('900012') });
    const cases: Array<[unknown, RegExp]> = [
      ['stress', /^参数 skipped 不是数组$/],
      [['x'], /第 1 项不是对象/],
      [[{ category: 'performance', reason: 'x' }], /第 1 项的类别 performance 不是模板里的类别编号/],
      [[{ reason: 'x' }], /第 1 项的类别没有写/],
      [[{ category: 'stress', reason: '　 ' }], /第 1 项跳过类别 stress 却没有写理由/],
      [[{ category: 'stress' }], /第 1 项跳过类别 stress 却没有写理由/],
      [[{ category: 'stress', reason: 'x', document: 7 }], /第 1 项的 document 不是文字/],
      [[{ category: 'stress', reason: 'x', document: '910001' }], /第 1 项写的文档 910001 不在这次运行里/],
      [[{ category: 'stress', reason: 'x', document: 'agile:mindmap:910001' }], /第 1 项写的文档 agile:mindmap:910001 不在这次运行里/],
      [[{ category: 'stress', reason: 'x', document: `src:${'0'.repeat(64)}` }], /不在这次运行里/],
      [[{ category: 'stress', reason: 'x', document: '900011' }, { category: 'stress', reason: 'y', document: 'agile:mindmap:900011' }], /第 2 项和第 1 项都对文档 900011 跳过类别 stress/],
      [[{ category: 'stress', reason: 'x' }, { category: 'stress', reason: 'y', document: '900012' }], /第 2 项和第 1 项都对文档 900012 跳过类别 stress/],
    ];
    for (const [skipped, message] of cases) {
      const out = refuse([a, b], { skipped });
      assert.equal(out.error.code, 'template-gap.skip_invalid', JSON.stringify(skipped));
      assert.match(out.error.message, message);
      assert.match(out.error.fix, /900011、900012/, 'the fix lists the documents of the run');
      assert.match(out.error.fix, /用户给出的理由/);
    }
    const many = refuse([a], { skipped: Array.from({ length: 7 }, () => ({ category: 'nope', reason: 'x' })) });
    assert.match(many.error.message, /^参数 skipped 有 7 项不能用：(第 \d 项的类别 nope 不是模板里的类别编号；){4}第 5 项的类别 nope 不是模板里的类别编号 等$/);
  });

  it('a skip of a category that is present is listed and changes nothing else', () => {
    const item = report(baseDocument(), { skipped: [{ category: 'database', reason: '不涉及数据库' }] });
    assert.deepEqual(item.fields.missing, []);
    assert.deepEqual(item.fields.skipped, [{ category: 'database', reason: '不涉及数据库' }]);
    assert.equal(item.fields.categories.find((c) => c.id === 'database')?.present, true);
  });

  it('several documents: one item each, in input order, each located at its own root', () => {
    const docs = [renamed(baseDocument(), 'r0multi00001'), renamed(withoutCategory(baseDocument(), 'integration'), 'r0multi00002'), renamed(shuffled(baseDocument(), 5), 'r0multi00003')];
    const inputs = [bind(docs[0], { external: external('900021') }), bind(docs[1]), bind(docs[2], { external: external('900023') })];
    const out = project(inputs);
    assert.deepEqual(
      out.items.map((item) => [item.id, item.location.selector, item.fields.missing]),
      [
        ['900021', 'n/r0multi00001', []],
        [`upload-${inputs[1].sha256.slice(0, 12)}`, 'n/r0multi00002', ['integration']],
        ['900023', 'n/r0multi00003', []],
      ],
    );
  });

  it('summaries name every missing category, what is skipped and what was not counted', () => {
    let doc = baseDocument();
    for (const category of ['stress', 'compatibility', 'database', 'audit_log']) doc = withoutCategory(doc, category);
    const item = report(doc, { skipped: [{ category: 'compatibility', reason: '不涉及升级' }, { category: 'database', reason: '不涉及数据库' }] });
    assertGold(item.fields, doc, 'four categories removed');
    const present = item.fields.categories.filter((c) => c.present).length;
    // Without the Stress and the Compatibility cases no case shows the old-to-new upgrade either.
    assert.deepEqual(item.fields.missing, ['stress', 'audit_log', 'upgrade_old_to_new']);
    assert.equal(
      item.summary,
      `用例 ${item.fields.caseCount} 个；按命令：未计算，缺 case_index；缺 3 个模板类别：压力测试（stress）、审计日志（audit_log）、升级兼容：老版本到新版本（upgrade_old_to_new）；参数 skipped 声明跳过 2 个：兼容性测试（compatibility）、数据库（database）；模板类别出现 ${present}/24 个；用例规则：标签或标记；其中 1 个只靠标记识别（没有标签）`,
    );
  });

  it('names every missing category even when none is shown: by id when names and ids do not fit', () => {
    // Cases whose tags name no test type and whose texts show no category: all 24 categories are missing.
    const km = (cases: number, untagged: number) =>
      new TextEncoder().encode(
        JSON.stringify({
          root: {
            data: { id: 'r', text: '根' },
            children: [
              ...Array.from({ length: cases }, (_, i) => ({ data: { id: `c${i}`, text: `第 ${i} 条`, priority: 2, resource: ['R2'] }, children: [{ data: { id: `c${i}e`, text: '符合预期' }, children: [] }] })),
              ...Array.from({ length: untagged }, (_, i) => ({ data: { id: `u${i}`, text: `没有标签 ${i}`, priority: 2 }, children: [{ data: { id: `u${i}e`, text: '符合预期' }, children: [] }] })),
            ],
          },
          template: 'right',
          theme: 'classic',
          version: '1.4.43',
        }),
      );
    // 一万多条未分类用例的分类清单超过输出上限。缺类别的说法要等分类完成，不能靠把文档放大来列出。
    const huge = projectDocuments(projectionInput([bind(km(12_345, 6_789), { external: external() })]));
    assert.ok('error' in huge && huge.error.code === 'template-gap.too_large');
    const one = itemOf(km(1, 0), { external: external() });
    assert.equal(one.fields.classification_status, 'unclassified');
    assert.deepEqual(one.fields.missing, []);
    assert.match(one.summary, /未分类用例 1 个/);
    assert.ok(!one.summary.includes('缺 24 个模板类别'));
    const classified = new TextEncoder().encode(JSON.stringify({ root: { data: { id: 'r', text: '根' }, children: [{ data: { id: 'c0', text: '第 0 条', priority: 2, category_ids: ['functional'] }, children: [{ data: { id: 'c0e', text: '符合预期' }, children: [] }] }] }, template: 'right', theme: 'classic', version: '1.4.43' }));
    const named = itemOf(classified, { external: external() });
    const absent = CATEGORIES.filter((id) => id !== 'functional');
    assert.deepEqual(named.fields.missing, absent);
    assert.ok(named.summary.length <= LIMITS.maxSummary, `${named.summary.length} characters`);
    for (const id of absent) assert.ok(named.summary.includes(id), id);
    const skipped = CATEGORIES.slice(0, 9).map((category) => ({ category, reason: '用户说不适用' }));
    const mixed = itemOf(classified, { external: external() }, { skipped });
    assert.deepEqual(mixed.fields.missing, absent.filter((id) => !skipped.some((skip) => skip.category === id)));
    assert.match(mixed.summary, /参数 skipped 声明跳过 9 个：functional、configuration、integration、compatibility、negative、stress 等/);
  });
});

describe('refusals (W01 R[3])', () => {
  it('a document without cases refuses the whole run with the fix, naming it and its untagged nodes', () => {
    const plain = refuse([bind(renamed({ ...outlineDocument(), children: [] }, 'r0empty00001'), { external: external('900031') })]);
    assert.equal(plain.error.code, 'template-gap.no_case');
    assert.match(plain.error.fix, /把没有用例的文档从输入里去掉/);
    assert.deepEqual(plain.error.documents, ['900031']);

    const taggedRefusal = refuse([bind(outlineDocument(), { external: external('900032') })], { case_rule: 'tagged' });
    assert.equal(taggedRefusal.error.code, 'template-gap.no_case');
    assert.match(taggedRefusal.error.message, /^文档 900032 里没有用例节点：用例是标签（resource）不为空的节点；其中有 1 个没有标签、写法像用例的节点/);
    assert.match(taggedRefusal.error.fix, /打上测试类型标签/);
    assert.deepEqual(taggedRefusal.error.documents, ['900032']);
  });

  it('one document without cases among several refuses the whole batch', () => {
    const emptyDoc = renamed({ ...outlineDocument(), children: [] }, 'r0empty00002');
    const out = refuse([bind(renamed(baseDocument(), 'r0batch00001'), { external: external('900041') }), bind(emptyDoc, { external: external('900042') })]);
    assert.equal(out.error.code, 'template-gap.no_case');
    assert.deepEqual(out.error.documents, ['900042']);
  });

  it('refuses inputs that are not parsed mind maps, documents given twice and unusable document ids', () => {
    const doc = baseDocument();
    const json = { ...bind(doc), parser: 'json@1' };
    assert.equal(refuse([json]).error.code, 'template-gap.invalid_input');
    assert.match(refuse([json]).error.message, /不是 KityMinder 脑图（解析器 json@1）/);
    assert.match(refuse([{ ...bind(doc), model: { nodes: [] } }]).error.message, /不是 KityMinder 脑图/);
    const twice = refuse([bind(doc, { external: external() }), bind(renamed(doc, 'r0twice00001'), { external: `${external()}@2` })]);
    assert.match(twice.error.message, /文档 900001 在输入里出现了两次/);
    assert.match(refuse([bind(doc, { external: 'agile:mindmap:a:b' })]).error.message, /含有冒号/);
    assert.match(refuse([bind(doc, { external: `agile:mindmap:${'9'.repeat(121)}` })]).error.message, /超过 120 个字符/);
    assert.equal(refuse([]).error.code, 'template-gap.invalid_input');
    assert.equal(refuse([bind(doc, { slot: 'other' })]).error.code, 'template-gap.invalid_input', 'only the documents slot is read');
  });

  it('documents whose roots cannot be told apart are refused; one document alone is located by position instead', () => {
    const doc = baseDocument();
    const same = refuse([bind(doc, { external: external('900051') }), bind(shuffled(doc, 3), { external: external('900052') })]);
    assert.equal(same.error.code, 'template-gap.root_ambiguous');
    assert.deepEqual(same.error.documents, ['900051', '900052']);
    // A root id that occurs twice inside its own document cannot address the root.
    const km = render(renamed(doc, 'r0clash00001'));
    km.root.children.push({ data: { id: 'r0clash00001', created: 0, text: '同号节点' }, children: [] });
    const clash = new TextEncoder().encode(JSON.stringify(km));
    assert.equal(refuse([bind(clash, { external: external('900053') }), bind(renamed(doc, 'r0other00001'), { external: external('900054') })]).error.code, 'template-gap.root_ambiguous');
    assert.equal(itemOf(clash, { external: external('900053') }).location.selector, 'i');
    assert.equal(parse(clash).locate('i')?.text, doc.title);
  });

  it('refuses a result above the output limit with a fix instead of failing in the sandbox', () => {
    const out = projectDocuments(projectionInput([bind(baseDocument())]), { outputBytes: 2048 });
    assert.ok('error' in out);
    assert.equal(out.error.code, 'template-gap.too_large');
    assert.match(out.error.fix, /分成几批/);
  });
});

describe('totality', () => {
  it('never throws: malformed calls are refused with a pack code', () => {
    for (const input of [null, 1, 'x', [], {}, { inputs: 'x' }, { inputs: [null] }, { inputs: [{ slot: 'documents' }] }, { inputs: [{ slot: 'documents', external: 'agile:mindmap:1', parser: 'kityminder@1', model: { nodes: 'x' } }] }]) {
      const out = projectDefault(input) as { error?: { code: string } };
      assert.ok(out.error !== undefined, JSON.stringify(input));
      assert.match(out.error.code, /^template-gap\./);
    }
    const hostile = { get inputs(): never { throw new Error('boom'); } };
    assert.equal((projectDefault(hostile) as { error: { code: string } }).error.code, 'template-gap.internal_error');
  });

  it('survives hostile models: cycles, shared children, invalid indexes, deep nesting and non-text tags', () => {
    const nodes: unknown[] = [
      { data: { id: 'r', text: '根' }, children: [1, 1, 2, 99, -1, 'x', 0] },
      { data: { id: 'c1', text: 'widget pool add pool2', priority: 2, resource: ['Function', null, { x: 1 }] }, children: [3] },
      'not a node',
      { data: { id: 'e1', text: 'pool2 出现' }, children: [1] },
    ];
    const deep: unknown[] = Array.from({ length: 230 }, (_, i) => ({ data: { id: `d${i}`, text: `第 ${i} 层`, ...(i === 5 ? { priority: 2, resource: ['Stress'] } : {}) }, children: i < 229 ? [i + 1] : [] }));
    for (const model of [{ nodes }, { nodes: deep }]) {
      const out = projectDocuments(projectionInput([{ ...bind(baseDocument(), { external: external() }), model }]));
      assert.ok(!('error' in out), JSON.stringify(out).slice(0, 300));
      const codes = out.warnings.map((w) => w.code);
      assert.ok(codes.includes(model.nodes === nodes ? 'template-gap.model_malformed' : 'template-gap.depth_limit'), codes.join());
    }
    const shared = projectDocuments(projectionInput([{ ...bind(baseDocument(), { external: external() }), model: { nodes } }]));
    assert.ok(!('error' in shared));
    assert.equal(shared.items[0].fields.caseCount, 1);
    assert.ok(shared.warnings.some((w) => w.code === 'template-gap.tag_not_text'));
    // 标题里的命令文字不再当成类别。这条用例没有 category_ids，command_add 计数是 0。
    assert.equal(shared.items[0].fields.categories.find((c) => c.id === 'command_add')?.count, 0);
  });

  it('is deterministic', () => {
    const inputs = [bind(baseDocument(), { external: external() })];
    assert.deepEqual(projectDefault(projectionInput(inputs)), projectDefault(projectionInput(structuredClone(inputs))));
  });

  it('reads document ids from external objects and uploads', () => {
    assert.equal(documentIdOf({ external: 'agile:mindmap:90001' }), '90001');
    assert.equal(documentIdOf({ external: 'agile:mindmap:90001@2026-10-01' }), '90001');
    assert.equal(documentIdOf({ external: 'agile:mindmap' }), null);
    assert.equal(documentIdOf({ external: null, sha256: 'a'.repeat(64) }), `upload-${'a'.repeat(12)}`);
    assert.equal(documentIdOf({ external: null, sha256: 'not a digest' }), null);
  });
});
