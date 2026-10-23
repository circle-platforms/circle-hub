// Tests of the independent literal answer (task gold-review step 2). Fixtures are synthetic; the code names are
// checked against contracts/codes.json, and literal.ts is checked to import nothing from hub/ or packs/.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import ts from 'typescript';
import { test } from 'node:test';
import type { MindNode } from '../lib/inject.ts';
import { parseMindMap } from './cases.ts';
import { CODE_DUPLICATE_KEY, CODE_REQUIRED_EMPTY, CODE_TYPE_MISMATCH, literalGold } from './literal.ts';

const leaf = (id: string, text: string): MindNode => ({ data: { id, text }, children: [] });
const kase = (id: string, text: string, expected: string, tag = 'configuration'): MindNode => ({ data: { id, text, resource: [tag], priority: 2 }, children: [leaf(`${id}e`, expected)] });
const group = (id: string, text: string, ...children: MindNode[]): MindNode => ({ data: { id, text }, children });
const doc = (root: MindNode): { root: MindNode } => ({ root });

const answerOf = (map: unknown, id: string): string[] => literalGold(map).cases.find((c) => c.id === id)?.codes ?? [];

test('the three code names exist in contracts/codes.json verbatim', () => {
  const codes = readFileSync(join(import.meta.dirname, '../../../contracts/codes.json'), 'utf8');
  for (const code of [CODE_REQUIRED_EMPTY, CODE_TYPE_MISMATCH, CODE_DUPLICATE_KEY]) {
    assert.ok(codes.includes(`"code": "${code}"`), `${code} is not a code of contracts/codes.json`);
  }
});

test('literal.ts imports nothing from hub/ or packs/', () => {
  assert.deepEqual(independentImports(join(import.meta.dirname, 'literal.ts'), resolve(import.meta.dirname, '../../..')), []);
});

test('a healthy case has no code; each required_empty problem has one', () => {
  const healthy = doc(group('r', '文档', group('g', '组', kase('ok', '正常用例', '老化时间为 3600 秒'))));
  assert.deepEqual(answerOf(healthy, 'ok'), []);

  const emptyTitle = doc(group('r', '文档', group('g', '组', kase('t', '', '成功'))));
  assert.deepEqual(answerOf(emptyTitle, 't'), [CODE_REQUIRED_EMPTY]);

  const noPriority = doc(group('r', '文档', group('g', '组', { data: { id: 'p', text: '没有优先级', resource: ['configuration'] }, children: [leaf('pe', '成功')] })));
  assert.deepEqual(answerOf(noPriority, 'p'), [CODE_REQUIRED_EMPTY]);

  const noTag = doc(group('r', '文档', group('g', '组', { data: { id: 'n', text: '只有一个空标签', priority: 2, resource: [' '] }, children: [leaf('ne', '成功')] })));
  assert.deepEqual(answerOf(noTag, 'n'), [CODE_REQUIRED_EMPTY]);

  const blankTag = doc(group('r', '文档', group('g', '组', { data: { id: 'b', text: '空标签', priority: 2, resource: ['configuration', '  '] }, children: [leaf('be', '成功')] })));
  assert.deepEqual(answerOf(blankTag, 'b'), [CODE_REQUIRED_EMPTY]);

  const noExpected = doc(group('r', '文档', group('g', '组', { data: { id: 'e', text: '没有期望', priority: 2, resource: ['configuration'] }, children: [] })));
  assert.deepEqual(answerOf(noExpected, 'e'), [CODE_REQUIRED_EMPTY]);

  const emptyExpected = doc(group('r', '文档', group('g', '组', kase('ee', '期望为空', '  '))));
  assert.deepEqual(answerOf(emptyExpected, 'ee'), [CODE_REQUIRED_EMPTY]);

  const preconditionOnly = doc(group('r', '文档', group('g', '组', { data: { id: 'po', text: '只有前置', priority: 2, resource: ['configuration'] }, children: [{ data: { id: 'pop', text: '先清空', priority: 3 }, children: [] }] })));
  assert.deepEqual(answerOf(preconditionOnly, 'po'), [CODE_REQUIRED_EMPTY], 'a priority-3 leaf is not an expected result');
});

test('a priority outside 1..3 or not an integer is a type mismatch; 1, 2 and 3 are not', () => {
  const withPriority = (priority: number): { root: MindNode } => doc(group('r', '文档', group('g', '组', { data: { id: 'c', text: '用例', priority, resource: ['configuration'] }, children: [leaf('ce', '成功')] })));
  assert.deepEqual(answerOf(withPriority(4), 'c'), [CODE_TYPE_MISMATCH]);
  assert.deepEqual(answerOf(withPriority(0), 'c'), [CODE_TYPE_MISMATCH]);
  assert.deepEqual(answerOf(withPriority(2.5), 'c'), [CODE_TYPE_MISMATCH]);
  for (const good of [1, 2, 3]) assert.deepEqual(answerOf(withPriority(good), 'c'), []);
});

test('duplicates compare everything folded; case, width and white space differences still duplicate; a different path, step or expectation breaks it; a shared title alone is not', () => {
  const sameTwice = doc(group('r', '文档', group('g', '组',
    kase('d1', 'Ｗｉｄｇｅｔ 池　创建', '成功', 'stress'),
    kase('d2', 'widget 池 创建', '成功', 'stress'),
  )));
  assert.deepEqual(answerOf(sameTwice, 'd1'), [CODE_DUPLICATE_KEY]);
  assert.deepEqual(answerOf(sameTwice, 'd2'), [CODE_DUPLICATE_KEY]);

  const differentPath = doc(group('r', '文档',
    group('g1', '组一', kase('p1', 'widget 池 创建', '成功', 'stress')),
    group('g2', '组二', kase('p2', 'widget 池 创建', '成功', 'stress')),
  ));
  assert.deepEqual(answerOf(differentPath, 'p1'), []);
  assert.deepEqual(answerOf(differentPath, 'p2'), []);

  const differentStep = doc(group('r', '文档', group('g', '组',
    kase('s1', 'widget 池 创建', '成功', 'stress'),
    { data: { id: 's2', text: 'widget 池 创建', priority: 2, resource: ['stress'] }, children: [group('s2t', '第一步', leaf('s2e', '成功'))] },
  )));
  assert.deepEqual(answerOf(differentStep, 's1'), [], 'one bare expectation and one step are not the same');
  assert.deepEqual(answerOf(differentStep, 's2'), []);

  const differentExpectation = doc(group('r', '文档', group('g', '组',
    kase('x1', 'widget 池 创建', '成功', 'stress'),
    kase('x2', 'widget 池 创建', '失败', 'stress'),
  )));
  assert.deepEqual(answerOf(differentExpectation, 'x1'), []);
  assert.deepEqual(answerOf(differentExpectation, 'x2'), []);

  const differentPrecondition = doc(group('r', '文档', group('g', '组',
    { data: { id: 'q1', text: 'widget 池 创建', priority: 2, resource: ['stress'] }, children: [leaf('q1p', '先清空', ), leaf('q1e', '成功')] },
    { data: { id: 'q2', text: 'widget 池 创建', priority: 2, resource: ['stress'] }, children: [{ data: { id: 'q2p', text: '先清空', priority: 3 }, children: [] }, leaf('q2e', '成功')] },
  )));
  assert.deepEqual(answerOf(differentPrecondition, 'q1'), [], 'a precondition is not an expectation');
  assert.deepEqual(answerOf(differentPrecondition, 'q2'), []);

  const titleOnly = doc(group('r', '文档', group('g', '组',
    kase('t1', 'widget 池 创建', '成功', 'stress'),
    kase('t2', 'widget 池 创建', '失败', 'stress'),
    { data: { id: 't3', text: 'widget 池 创建', priority: 2, resource: ['configuration'] }, children: [group('t3s', '步骤', leaf('t3e', '成功'))] },
  )));
  assert.deepEqual(answerOf(titleOnly, 't1'), [], 'a shared title alone is not a duplicate');
});

test('a marked case counts as missing its tag; under the tagged rule it is not a case at all', () => {
  const map = doc(group('r', '文档', group('g', '组', { data: { id: 'm', text: '标记用例', priority: 2 }, children: [leaf('me', '成功')] })));
  assert.deepEqual(literalGold(map).cases.find((c) => c.id === 'm')?.codes, [CODE_REQUIRED_EMPTY]);
  assert.deepEqual(literalGold(map, { caseRule: 'tagged' }).cases, []);
});

test('cases without a unique data.id are counted apart and never scored', () => {
  const map = doc(group('r', '文档', group('g', '组',
    kase('same', '第一份', '成功'),
    kase('same', '第二份', '失败'),
    { data: { text: '没有编号', priority: 2, resource: ['configuration'] }, children: [leaf('ne2', '成功')] },
  )));
  const answer = literalGold(map);
  assert.deepEqual(answer.noUniqueId.map((n) => n.id), ['@6', 'same', 'same']);
  assert.ok(!answer.cases.some((c) => c.id === 'same'), 'the shared id takes no part in scoring');
});


test('raw blank tags remain required-empty even when parseMindMap filters them out', () => {
  const tree = doc(group('root-raw', '合成文档', group('group-raw', '合成分组',
    { data: { id: 'raw-blank', text: '合成用例', priority: 2, resource: ['configuration', '', ' \t '] }, children: [leaf('raw-expected', '合成期望')] },
    kase('raw-healthy', '健康用例', '另一条合成期望'),
  )));
  const parsedCase = parseMindMap(tree).nodes.find(n => n.id === 'raw-blank')!;
  assert.deepEqual(parsedCase.resource, ['configuration']);
  assert.deepEqual(answerOf(tree, 'raw-blank'), [CODE_REQUIRED_EMPTY]);
  assert.deepEqual(answerOf(tree, 'raw-healthy'), []);
});

test('raw decimal and string priorities are malformed rather than missing and keep traversal alignment', () => {
  const priorities: unknown[] = [2.5, '2', '2.5', '', 2, null, undefined];
  const children = priorities.map((priority, at) => ({ data: { id: `raw-priority-${at}`, text: `合成用例 ${at}`, priority, resource: ['configuration'] }, children: [leaf(`raw-result-${at}`, `合成期望 ${at}`)] }));
  const tree = { root: group('root-raw', '合成文档', group('group-raw', '合成分组', ...children as MindNode[])) };
  const parsed = parseMindMap(tree);
  for (let at = 0; at < 4; at++) {
    assert.equal(parsed.nodes.find(n => n.id === `raw-priority-${at}`)?.priority, null);
    assert.deepEqual(answerOf(tree, `raw-priority-${at}`), [CODE_TYPE_MISMATCH]);
  }
  assert.deepEqual(answerOf(tree, 'raw-priority-4'), []);
  assert.deepEqual(answerOf(tree, 'raw-priority-5'), [CODE_REQUIRED_EMPTY]);
  assert.deepEqual(answerOf(tree, 'raw-priority-6'), [CODE_REQUIRED_EMPTY]);
});

test('review 7: same folded ancestor labels mean the same duplicate path even across distinct group nodes', () => {
  const map = doc(group('r', '合成文档', group('g1', 'ＳＡＭＥ  PATH', kase('a', 'same case', 'same expected')), group('g2', 'same path', kase('b', 'same case', 'same expected'))));
  assert.ok(answerOf(map, 'a').includes(CODE_DUPLICATE_KEY)); assert.ok(answerOf(map, 'b').includes(CODE_DUPLICATE_KEY));
});

test('review 12: blank-only raw tags still identify a tagged case without priority', () => {
  const map = doc(group('r', 'synthetic', { data: { id: 'blank-tag', text: 'synthetic', resource: [' '] }, children: [leaf('e', 'expected')] }));
  const answer = literalGold(map, { caseRule: 'tagged' });
  assert.ok(answer.cases.find(c => c.id === 'blank-tag')?.codes.includes(CODE_REQUIRED_EMPTY));
});

function independentImports(entry: string, root: string, read: (file: string) => string = file => readFileSync(file, 'utf8')): string[] {
  const violations: string[] = [], seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return; seen.add(file);
    const syntax = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const check = (specifier: string): void => {
      if (specifier.startsWith('node:')) return;
      const target = /^(hub|packs)\//.test(specifier) ? resolve(root, specifier) : specifier.startsWith('.') || isAbsolute(specifier) ? resolve(dirname(file), specifier) : null;
      if (target === null) return;
      if (['hub','packs'].some(dir => target === join(root, dir) || target.startsWith(join(root, dir) + sep))) { violations.push(file + ' -> ' + target); return; }
      if (target.endsWith('.ts')) visit(target);
    };
    const walk = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) check(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
        if (node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) check(node.arguments[0].text); else violations.push(file + ': unresolved dynamic import');
      }
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) check(node.argument.literal.text);
      ts.forEachChild(node, walk);
    };
    walk(syntax);
  };
  visit(resolve(entry)); return violations;
}
test('review 13: independence guards relative dynamic and transitive target imports', () => {
  const root = resolve(import.meta.dirname, '../../..'), entry = join(root, 'scripts/real/gold/fake.ts');
  for (const code of ["import { x } from '../../../hub/fake.ts';", "export * from '../../../packs/fake.ts';", "import('../../../hub/fake.ts');"]) assert.ok(independentImports(entry, root, () => code).length);
  assert.ok(independentImports(entry, root, file => file === entry ? "import './cases.ts';" : "export * from '../../../hub/fake.ts';").length);
});

test('review 20: absent and null titles are empty while scalar titles are text', () => {
  for (const value of [undefined, null]) {
    const node = kase('c1', 'temporary', 'expected'); if (value === undefined) delete node.data.text; else (node.data as Record<string, unknown>).text = value;
    assert.ok(answerOf(doc(group('r', 'synthetic', node)), 'c1').includes(CODE_REQUIRED_EMPTY));
  }
});

test('closure raw text: all nodes use scalar text and absent expected leaves stay empty', () => {
 for(const value of [123,456,false]) {const node=kase('c1','temporary','expected');(node.data as Record<string,unknown>).text=value; assert.ok(!answerOf(doc(group('r','synthetic',node)),'c1').includes(CODE_REQUIRED_EMPTY));}
 const missing=kase('c1','title','expected');delete missing.children![0].data.text;assert.ok(answerOf(doc(group('r','synthetic',missing)),'c1').includes(CODE_REQUIRED_EMPTY));
 const a=kase('a','temporary','expected'), b=kase('b','temporary','expected');(a.data as Record<string,unknown>).text=123;(b.data as Record<string,unknown>).text=456;
 const answer=literalGold(doc(group('r','synthetic',a,b)));assert.ok(answer.cases.every(c=>!c.codes.includes(CODE_DUPLICATE_KEY)));
});
