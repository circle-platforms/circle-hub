// Tests of the independent literal answer (task gold-review step 2). Fixtures are synthetic; the code names are
// checked against contracts/codes.json, and literal.ts is checked to import nothing from hub/ or packs/.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { MindNode } from '../lib/inject.ts';
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
  const source = readFileSync(join(import.meta.dirname, 'literal.ts'), 'utf8');
  for (const line of source.split('\n')) {
    if (/^\s*import\b/.test(line)) assert.ok(!/['"](hub|packs)\//.test(line), `an import reaches the Hub: ${line.trim()}`);
  }
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
