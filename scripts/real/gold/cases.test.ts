// Tests of the gold case-count script (synthetic KityMinder documents): the case-node rule from
// packs/workflow/case-review/README.md re-implemented independently (a node whose resource is a non-empty
// array is a case; expected results are the case's leaf children; a leaf with the precondition priority is
// not; a child with children is a step whose leaves are its expected results), the vague-expected phrase
// list copied from the table source, and the defect ids of titles and ancestors. The gold script imports
// nothing from hub/ or packs/; the tests hand-compute the expected counts and compare item by item.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { bugIdsOf, caseGold, foldKey, main, parseMindMap } from './cases.ts';

const node = (text: string, data: Record<string, unknown>, children: unknown[] = []): unknown => ({ data: { text, ...data }, children });

// One synthetic document: root title holds a bug id; a tagged case with expected results; a tagged case with
// only a vague expected result; a tagged negative case without expected results; a step case; an untagged
// plain node that is not a case under the tagged rule; a case with a defect id in its title.
const document = {
  root: node('APV 10.6（缺陷 7300 修复回归）', { id: 'root-1' }, [
    node('SSL 模块', { id: 'f-1' }, [
      node('检查会话', { id: 'c-1', resource: ['Functional'], priority: 2 }, [
        node('配置后正常', { id: 'e-1', priority: 4 }),
        node('前置：已登录', { id: 'p-1', priority: 3 }),
      ]),
      node('查看证书', { id: 'c-2', resource: ['功能'], priority: 2 }, [
        node('页面正常', { id: 'e-2' }),
      ]),
      node('异常输入被拒绝', { id: 'c-3', resource: ['Negative'], priority: 2 }, []),
      node('压力场景', { id: 'c-4', resource: ['Stress'], priority: 2 }, [
        node('步骤：发起连接', { id: 's-1' }, [
          node('连接建立', { id: 'e-3' }),
        ]),
      ]),
      node('未打标签的普通节点', { id: 'x-1', priority: 2 }, [
        node('子节点', { id: 'x-2' }),
      ]),
      node('bug to case 7401 的回归', { id: 'c-5', resource: ['Functional'], priority: 2 }, [
        node('配置生效', { id: 'e-4' }),
      ]),
    ]),
  ]),
};

let dir: string | undefined;
const fileOf = (name: string, value: unknown): string => {
  dir ??= mkdtempSync(join(tmpdir(), 'gold-cases-'));
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(value)}\n`);
  return path;
};
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('parseMindMap', () => {
  test('walks the nodes in pre-order and keeps text, id, resource, priority and ancestors', () => {
    const { nodes } = parseMindMap(document);
    assert.equal(nodes.length, 15);
    assert.deepEqual(
      nodes.filter((n) => n.resource.length > 0).map((n) => n.id),
      ['c-1', 'c-2', 'c-3', 'c-4', 'c-5'],
    );
    const case5 = nodes.find((n) => n.id === 'c-5')!;
    assert.deepEqual(case5.ancestors.map((a) => a.slice(0, 3)), ['APV', 'SSL']);
  });
});

describe('foldKey', () => {
  test('folds full-width, case and edge punctuation away', () => {
    assert.equal(foldKey('　正常。'), '正常');
    assert.equal(foldKey('Ｏｋ'), 'ok');
    assert.equal(foldKey('AS EXPECTED'), 'asexpected');
  });
});

describe('caseGold', () => {
  test('counts cases, expected, vague, negative and per-group, and defects under default marked rule', () => {
    const gold = caseGold([{ document: '9001', map: document }]);
    // Hand-computed under marked: 6 cases (c-1, c-2, c-3, c-4, x-1, c-5).
    // x-1 is an untagged candidate node with priority 2, has child x-2, so it is a case under marked.
    // c-1 expected 1 (p-1 priority 3 is a precondition leaf, not expected result),
    // c-2 expected 1 (页面正常 is not vague in the table),
    // c-3 no expected result (hasExpected: false),
    // c-4 expected 1 through its step,
    // x-1 expected 1 (子节点),
    // c-5 expected 1 and vague (配置生效 is in vague table).
    // Total withExpected: 5.
    assert.equal(gold.documents.length, 1);
    const doc = gold.documents[0];
    assert.equal(doc.cases, 6);
    assert.equal(doc.withExpected, 5);
    assert.deepEqual(doc.vagueCases.sort(), ['c-5']);
    assert.deepEqual(doc.negativeCases, ['c-3']);
    assert.deepEqual(doc.groupCounts, { 'SSL 模块': 6 });
    assert.deepEqual(doc.defects.sort(), ['7300', '7401']);
    const byId = new Map(doc.items.map((item) => [item.id, item]));
    assert.deepEqual(byId.get('c-4')!.steps.map((s) => s.text), ['步骤：发起连接']);
    assert.deepEqual(byId.get('c-4')!.steps[0].expected, ['连接建立']);
    assert.deepEqual(byId.get('c-1')!.expected, ['配置后正常']);
    assert.deepEqual(byId.get('x-1')!.expected, ['子节点']);
    assert.equal(byId.get('x-1')!.negative, false);
  });

  test('recognizes "负面测试" as a negative tag', () => {
    const docWithNegative = {
      root: node('测试文档', { id: 'root-n' }, [
        node('负向用例', { id: 'c-neg', resource: ['负面测试'], priority: 2 }, [
          node('期望结果', { id: 'e-1' }),
        ]),
      ]),
    };
    const gold = caseGold([{ document: '9002', map: docWithNegative }]);
    const doc = gold.documents[0];
    assert.deepEqual(doc.negativeCases, ['c-neg']);
    assert.equal(doc.items[0].negative, true);
  });

  test('restricts to tagged cases when caseRule is tagged', () => {
    const gold = caseGold([{ document: '9001', map: document }], { caseRule: 'tagged' });
    // Hand-computed under tagged: 5 cases (x-1 is excluded).
    assert.equal(gold.documents.length, 1);
    const doc = gold.documents[0];
    assert.equal(doc.cases, 5);
    assert.equal(doc.withExpected, 4);
    assert.deepEqual(doc.vagueCases.sort(), ['c-5']);
    assert.deepEqual(doc.negativeCases, ['c-3']);
    assert.deepEqual(doc.groupCounts, { 'SSL 模块': 5 });
    assert.deepEqual(doc.defects.sort(), ['7300', '7401']);
    assert.equal(doc.items.some((i) => i.id === 'x-1'), false);
  });

  test('synthetic document covering tagged, marked-only, plain, nested, precondition and group nodes', () => {
    // Hand-computed synthetic test covering all required node forms:
    // - g-1: tagged node with priority 1 holding cases -> GROUP (not a case)
    // - c-tag: tagged case with priority 2, has expected leaf (e-1) and precondition leaf (p-1, priority 3)
    // - c-nested: nested tagged case below c-tag -> CASE
    // - c-marked: untagged node with priority 2, has child e-2, outside cases -> CASE under marked, CANDIDATE under tagged
    // - plain-1: untagged node with priority 2 but no children (leaf) -> not a case
    // - plain-2: untagged node with no priority -> not a case
    // - g-2: untagged node with priority 1 -> GROUP
    const synthetic = {
      root: node('合成测试根', { id: 'root-s' }, [
        node('带标签的分组', { id: 'g-1', resource: ['Group'], priority: 1 }, [
          node('带标签用例', { id: 'c-tag', resource: ['Functional'], priority: 2 }, [
            node('前置条件', { id: 'p-1', priority: 3 }),
            node('普通期望', { id: 'e-1' }),
            node('嵌套用例', { id: 'c-nested', resource: ['Integration'], priority: 2 }, [
              node('嵌套期望', { id: 'e-nested' }),
            ]),
          ]),
          node('只带标记用例', { id: 'c-marked', priority: 2 }, [
            node('标记期望', { id: 'e-2' }),
          ]),
          node('无子节点的优先级2节点', { id: 'plain-1', priority: 2 }),
          node('普通节点无优先级', { id: 'plain-2' }, [
            node('普通子节点', { id: 'plain-sub' }),
          ]),
        ]),
        node('普通分组', { id: 'g-2', priority: 1 }, [
          node('普通分组下用例', { id: 'c-g2', resource: ['Negative'], priority: 2 }, [
            node('通过', { id: 'e-vague' }),
          ]),
        ]),
      ]),
    };

    // Under marked:
    // Cases: c-tag, c-nested, c-marked, c-g2 -> 4 cases.
    // g-1 is not a case (priority 1 holding cases).
    // plain-1 (leaf) and plain-2 (no priority) are not cases.
    const markedGold = caseGold([{ document: 'synth', map: synthetic }], { caseRule: 'marked' });
    const mDoc = markedGold.documents[0];
    assert.equal(mDoc.cases, 4);
    assert.deepEqual(mDoc.items.map((c) => c.id), ['c-tag', 'c-nested', 'c-marked', 'c-g2']);
    const cTag = mDoc.items.find((c) => c.id === 'c-tag')!;
    assert.deepEqual(cTag.expected, ['普通期望']); // p-1 is precondition, c-nested is separate case
    const cNested = mDoc.items.find((c) => c.id === 'c-nested')!;
    assert.deepEqual(cNested.expected, ['嵌套期望']);
    const cMarked = mDoc.items.find((c) => c.id === 'c-marked')!;
    assert.deepEqual(cMarked.expected, ['标记期望']);
    assert.equal(cMarked.negative, false);
    const cG2 = mDoc.items.find((c) => c.id === 'c-g2')!;
    assert.equal(cG2.negative, true);
    assert.equal(cG2.vagueExpected, true); // 通过 is in VAGUE_EXPECTED

    // Under tagged:
    // Cases: c-tag, c-nested, c-g2 -> 3 cases (c-marked is excluded).
    const taggedGold = caseGold([{ document: 'synth', map: synthetic }], { caseRule: 'tagged' });
    const tDoc = taggedGold.documents[0];
    assert.equal(tDoc.cases, 3);
    assert.deepEqual(tDoc.items.map((c) => c.id), ['c-tag', 'c-nested', 'c-g2']);
  });

  test('a document with no case is refused with its id, never its content', () => {
    const empty = { root: node('只有分组', { id: 'r' }, [node('子', { id: 'a' })]) };
    assert.throws(() => caseGold([{ document: '9002', map: empty }]), /9002/);
  });
});

describe('bugIdsOf and defect markers', () => {
  test('recognizes "Bug 160001 - 标题" on root title and associates 160001 with all cases', () => {
    const docWithBugRoot = {
      root: node('Bug 160001 - 自定义格式日志支持', { id: 'root-bug' }, [
        node('配置分组', { id: 'g-1', priority: 1 }, [
          node('用例1', { id: 'c-1', resource: ['Functional'], priority: 2 }, [
            node('期望1', { id: 'e-1' }),
          ]),
          node('用例2', { id: 'c-2', resource: ['Functional'], priority: 2 }, [
            node('期望2', { id: 'e-2' }),
          ]),
        ]),
      ]),
    };
    const gold = caseGold([{ document: '9003', map: docWithBugRoot }]);
    const doc = gold.documents[0];
    assert.deepEqual(doc.defects, ['160001']);
    assert.equal(doc.cases, 2);
    for (const item of doc.items) {
      assert.ok(item.defects.includes('160001'), `${item.id} should include 160001`);
    }
  });

  test('keeps legacy "bug to case 61001" syntax and rejects glued letters like "debug 12345"', () => {
    assert.deepEqual(bugIdsOf('bug to case 61001'), ['61001']);
    assert.deepEqual(bugIdsOf('Bug-to-Case 61002'), ['61002']);
    assert.deepEqual(bugIdsOf('debug 12345'), []);
    assert.deepEqual(bugIdsOf('redebug 99999'), []);
  });
});

describe('main', () => {
  test('reads exported mind maps and writes the gold JSON; a missing file is an error', async () => {
    const out = join(dir ??= mkdtempSync(join(tmpdir(), 'gold-cases-')), 'gold.json');
    const code = await main(['--map', `${fileOf('9001.json', document)}:9001`, '--out', out]);
    assert.equal(code, 0);
    const written = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(out, 'utf8'))) as ReturnType<typeof caseGold>;
    assert.equal(written.documents[0].document, '9001');
    assert.equal(written.documents[0].cases, 6);

    const outTagged = join(dir, 'gold-tagged.json');
    const codeTagged = await main(['--map', `${fileOf('9001.json', document)}:9001`, '--case-rule', 'tagged', '--out', outTagged]);
    assert.equal(codeTagged, 0);
    const writtenTagged = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(outTagged, 'utf8'))) as ReturnType<typeof caseGold>;
    assert.equal(writtenTagged.documents[0].cases, 5);

    const missing = await main(['--map', `${join(dir, 'nope.json')}:9001`, '--out', out]);
    assert.equal(missing, 1);
    const badShape = await main(['--map', `${fileOf('bad.json', { nope: true })}:9003`, '--out', out]);
    assert.equal(badShape, 1);
  });
});

test('tags keep raw entries: blank strings, finite numbers and booleans as text (like the index)', () => {
  const map = { root: { data: { text: '合成' }, children: [
    { data: { id: 'c-blank', text: '空白标签用例', resource: [''], priority: 2 }, children: [] },
    { data: { id: 'c-num', text: '数字标签用例', resource: [3, 'Functional'], priority: 2 }, children: [] },
    { data: { id: 'c-bool', text: '布尔标签用例', resource: [true], priority: 2 }, children: [] },
    { data: { id: 'c-null', text: '空值标签用例', resource: [null, 'Functional'], priority: 2 }, children: [] },
  ] } };
  const byId = new Map(caseGold([{ document: "synthetic-doc", map }], {}).documents[0]!.items.map((c) => [c.id, c.tags]));
  assert.deepEqual(byId.get('c-blank'), [''], 'a blank string is a tag');
  assert.deepEqual(byId.get('c-num'), ['3', 'Functional'], 'a finite number is a tag as text');
  assert.deepEqual(byId.get('c-bool'), ['true'], 'a boolean is a tag as text');
  assert.deepEqual(byId.get('c-null'), ['Functional'], 'null is no tag at all');
  // A case whose only entry is a blank string is still tagged (the index keeps a non-null facet row).
  assert.ok(byId.get('c-blank') !== undefined && byId.get('c-blank')!.length > 0);
});
