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
import { caseGold, foldKey, main, parseMindMap } from './cases.ts';

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
  test('counts cases, expected, vague, negative and per-group, and defects from title and ancestors', () => {
    const gold = caseGold([{ document: '9001', map: document }]);
    // Hand-computed: 5 cases; c-1 expected 1 (the precondition leaf is not an expected result), c-2 expected 1
    // (页面正常 is not a vague phrase of the table), c-3 no expected result, c-4 expected 1 through its step,
    // c-5 expected 1 and vague (配置生效 is in the phrase table). Defects: 7300 from the root title (every case
    // sees its ancestors), 7401 from c-5's own title.
    assert.equal(gold.documents.length, 1);
    const doc = gold.documents[0];
    assert.equal(doc.cases, 5);
    assert.equal(doc.withExpected, 4);
    assert.deepEqual(doc.vagueCases.sort(), ['c-5']);
    assert.deepEqual(doc.negativeCases, ['c-3']);
    assert.deepEqual(doc.groupCounts, { 'SSL 模块': 5 });
    assert.deepEqual(doc.defects.sort(), ['7300', '7401']);
    const byId = new Map(doc.items.map((item) => [item.id, item]));
    assert.deepEqual(byId.get('c-4')!.steps.map((s) => s.text), ['步骤：发起连接']);
    assert.deepEqual(byId.get('c-4')!.steps[0].expected, ['连接建立']);
    assert.deepEqual(byId.get('c-1')!.expected, ['配置后正常']);
  });
  test('a document with no case is refused with its id, never its content', () => {
    const empty = { root: node('只有分组', { id: 'r' }, [node('子', { id: 'a' })]) };
    assert.throws(() => caseGold([{ document: '9002', map: empty }]), /9002/);
  });
});

describe('main', () => {
  test('reads exported mind maps and writes the gold JSON; a missing file is an error', async () => {
    const out = join(dir ??= mkdtempSync(join(tmpdir(), 'gold-cases-')), 'gold.json');
    const code = await main(['--map', `${fileOf('9001.json', document)}:9001`, '--out', out]);
    assert.equal(code, 0);
    const written = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(out, 'utf8'))) as ReturnType<typeof caseGold>;
    assert.equal(written.documents[0].document, '9001');
    assert.equal(written.documents[0].cases, 5);
    const missing = await main(['--map', `${join(dir, 'nope.json')}:9001`, '--out', out]);
    assert.equal(missing, 1);
    const badShape = await main(['--map', `${fileOf('bad.json', { nope: true })}:9003`, '--out', out]);
    assert.equal(badShape, 1);
  });
});
