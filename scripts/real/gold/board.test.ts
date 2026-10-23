import assert from 'node:assert/strict';
import { boardLocate } from './board-locate.ts';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { boardGold } from './board.ts';
import scenario from '../accept/quality-board.ts';
import type { LoggedTurn } from '../lib/accept.ts';

const map = { root: { data: { text: '合成文档标题' }, children: [{ data: { id: 'c', text: '合成用例', resource: ['Negative'] } }] } };
const branch = (line: string, module: string, doc: string) => ({ id: line, label: `100：${line}`, children: [{ id: 'train', label: `101：${line}-R1`, children: [{ id: module, label: module, children: [{ id: doc, label: '合成标题' }] }] }] });
test('board independently groups two lines, invalid directories and absent tree documents', () => {
  const gold = boardGold({ product: 'synthetic', build: 'Synthetic_10_7', tree: [branch('10.7.0', '甲', 'a'), branch('10.8', '乙', 'b'), { id: 'x', label: '异常目录', children: [{ id: 'c', label: '文档' }] }], maps: ['a', 'b', 'c', 'd'].map((document) => ({ document, map })) });
  assert.deepEqual(gold.groups?.map((g) => [g.label, g.cases]), [['10.7/甲', 1], ['10.8/乙', 1], ['unplaced/unplaced', 2]]);
  assert.equal(gold.documents.not_in_tree, 1);
});
const gold = { product: 'synthetic', build: 'Synthetic_10_7', groups: [{ label: '10.7/甲', cases: 2, missing: 1, vague: 0, negative: 0 }, { label: '10.8/乙', cases: 1, missing: 0, vague: 0, negative: 1 }] };
const text = ['运行 run_1 完成', '- 10.7/甲 | 10.7/甲 | 用例 2 个；无期望结果 50.0%；含糊期望 0.0%；负面用例 0.0%', '- 10.8/乙 | 10.8/乙 | 用例 1 个；无期望结果 0.0%；含糊期望 0.0%；负面用例 100.0%', '合计：用例 3 个；无期望结果 1 个（33.3%）；含糊期望 0 个（0.0%）；负面用例 1 个（33.3%）。已索引的用例'].join('\n');
const turns = (text: string): LoggedTurn[] => [{ index: 1, tools: [], toolResults: [{ id: 'r', text, isError: false }] }];
test('scenario detects redistributed counts despite unchanged total, missing and extra groups, and hides labels', () => {
  const check = (s: string) => scenario(gold).check(turns(s));
  assert.ok(check(text).every((c) => c.ok), JSON.stringify(check(text)));
  assert.ok(check(text.replace('用例 2 个', '用例 1 个').replace('用例 1 个；无期望结果 0.0%', '用例 2 个；无期望结果 0.0%')).some((c) => !c.ok));
  assert.ok(check(text.replace(/^- 10.8[^\n]+\n/m, '')).some((c) => !c.ok));
  assert.ok(check(text + '\n- 10.9/额外 | 用例 1 个；无期望结果 0.0%；含糊期望 0.0%；负面用例 0.0%').some((c) => !c.ok));
  assert.doesNotMatch(JSON.stringify(check(text)), /甲|乙|合成文档/);
  assert.ok(check(text).filter((c) => c.name.includes('分组指标')).every((c) => /^#\d+ 分组指标一致$/.test(c.name)));
});

test('group count summaries compare counts as well as ratios', () => {
  const counted = text.replace('无期望结果 50.0%', '无期望结果 1 个（50.0%）').replace('含糊期望 0.0%', '含糊期望 0 个（0.0%）').replace('负面用例 0.0%', '负面用例 0 个（0.0%）');
  assert.ok(scenario(gold).check(turns(counted)).every((c) => c.ok));
  assert.ok(scenario(gold).check(turns(counted.replace('无期望结果 1 个（50.0%）', '无期望结果 2 个（50.0%）'))).some((c) => !c.ok));
});

test('raw tags remain intact and independent type coverage drives scenario comparisons', () => {
  const typedMap = { root: { data: { text: '合成文档标题' }, children: [
    { data: { id: 'c1', text: '合成用例一', resource: ['function', '[Functional]', '未知标签'] } },
    { data: { id: 'c2', text: '合成用例二', priority: 2 }, children: [{ data: { text: '期望' } }] },
  ] } };
  const typed = boardGold({ product: 'synthetic', build: 'Synthetic_10_7', tree: [branch('10.7', '甲', 'a')], maps: [{ document: 'a', map: typedMap }], types: true });
  assert.deepEqual(typed.groups![0].coverage, { present: ['功能测试'], missing: ['配置测试', '集成测试', '兼容性测试', '反向测试', '压力测试'], untagged: 1 });
  const group = typed.groups![0];
  const line = `运行 run_1 完成\n- ${group.label} | 用例 2 个；无期望结果 1 个（50.0%）；含糊期望 0 个（0.0%）；负面用例 0 个（0.0%）；未打标签 1 个；没有用例带这些类型的标签：配置测试、集成测试、兼容性测试、反向测试、压力测试\n合计：用例 2 个；无期望结果 1 个（50.0%）；含糊期望 0 个（0.0%）；负面用例 0 个（0.0%）。已索引的用例；1 个用例没有解析出命令`;
  const s = scenario({ ...typed, unplaced: 1 });
  assert.ok(s.check(turns(line)).every((c) => c.ok), JSON.stringify(s.check(turns(line))));
  assert.ok(s.check(turns(line.replace('未打标签 1', '未打标签 0'))).some((c) => !c.ok));
  assert.ok(s.check(turns(line.replace('压力测试', '功能测试'))).some((c) => !c.ok));
  assert.ok(s.check(turns(line.replace('1 个用例没有解析出命令', '0 个用例没有解析出命令'))).some((c) => !c.ok));
});

test('board CLI discloses document gaps and only counts and hashes on screen', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'board-gold-'));
  try {
    mkdirSync(join(dir, 'cases'));
    writeFileSync(join(dir, 'tree.json'), JSON.stringify([branch('10.7', '合成模块', 'a')]));
    writeFileSync(join(dir, 'docs.json'), JSON.stringify(['a', 'b', 'c']));
    writeFileSync(join(dir, 'cases/a.json'), JSON.stringify(map));
    writeFileSync(join(dir, 'cases/b.json'), JSON.stringify(map));
    writeFileSync(join(dir, 'cases/c.json'), JSON.stringify({ root: { data: { text: '没有用例的合成文档' } } }));
    const args = ['scripts/real/gold/board.ts', '--tree', join(dir, 'tree.json'), '--cases-dir', join(dir, 'cases'), '--docs', join(dir, 'docs.json'), '--product', 'synthetic', '--build', 'Synthetic_10_7', '--types', '--out', join(dir, 'gold.json')];
    const run = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stdout, /合成|Synthetic|Negative|10\.7/);
    assert.match(run.stdout, /清单 3 份，导出的脑图 3 份，其中不在树里 2 份，没有用例 1 份/);
    const result = JSON.parse(readFileSync(join(dir, 'gold.json'), 'utf8'));
    assert.equal(result.types, true);
    assert.equal(result.totals.cases, 2);
    writeFileSync(join(dir, 'tree.json'), JSON.stringify([branch('10.8', '另一个合成模块', 'a')]));
    assert.equal(spawnSync(process.execPath, args, { encoding: 'utf8' }).stdout, run.stdout, 'renaming line/module must not change the screen digest');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("board grouping follows the product pack's locator, not the case-location rule (four probes)", () => {
  const probe = (labels: string[]): { line: string | null; module: string | null } => { const { line, module } = boardLocate(labels); return { line, module }; };
  // A train under its line with a plain module: line 10.6, module kept even though the versions differ in kind.
  assert.deepEqual(probe(['10.6', '10.6.1-R2', '合成模块']), { line: '10.6', module: '合成模块' });
  // Words the case-location rule rejects still name modules here (the pack keeps them).
  assert.deepEqual(probe(['10.6', '10.6.1-R2', 'Build工具']), { line: '10.6', module: 'Build工具' });
  assert.deepEqual(probe(['10.6', '10.6.1-R2', '缺陷管理']), { line: '10.6', module: '缺陷管理' });
  // The scan stops at the first train: a later line label never replaces the line.
  assert.deepEqual(probe(['10.7', '10.7-R1', '合成模块', '10.8']), { line: '10.7', module: '合成模块' });
  // White space inside a module name is squeezed.
  assert.deepEqual(probe(['Web  UI']), { line: null, module: null }); // no train: no module either
  assert.deepEqual(probe(['10.7', '10.7-R1', 'Web  UI']), { line: '10.7', module: 'Web UI' });
});

test('a docs list naming documents with no exported map refuses to start and says what to supply', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gold-board-missing-'));
  try {
    mkdirSync(join(dir, 'cases'));
    writeFileSync(join(dir, 'cases/doc-a.json'), JSON.stringify({ root: { data: { text: '合成' }, children: [] } }));
    writeFileSync(join(dir, 'docs.json'), JSON.stringify(['doc-a', 'doc-b', 'doc-c']));
    writeFileSync(join(dir, 'tree.json'), JSON.stringify([]));
    const run = spawnSync(process.execPath, ['scripts/real/gold/board.ts', '--tree', join(dir, 'tree.json'), '--cases-dir', join(dir, 'cases'), '--docs', join(dir, 'docs.json'), '--product', 'apv', '--build', 'Synthetic_10_7_E', '--out', join(dir, 'out.json')], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /清单 3 份，导出的脑图缺 2 份：用 circle-hub original export 导出后重跑/);
    assert.doesNotMatch(run.stderr, /doc-[abc]|Synthetic/);
    const empty = spawnSync(process.execPath, ['scripts/real/gold/board.ts', '--tree', join(dir, 'tree.json'), '--cases-dir', join(dir, 'cases'), '--docs', join(dir, 'empty.json'), '--product', 'apv', '--build', 'Synthetic_10_7_E', '--out', join(dir, 'out.json')], { encoding: 'utf8' });
    writeFileSync(join(dir, 'empty.json'), '[]');
    const emptyRun = spawnSync(process.execPath, ['scripts/real/gold/board.ts', '--tree', join(dir, 'tree.json'), '--cases-dir', join(dir, 'cases'), '--docs', join(dir, 'empty.json'), '--product', 'apv', '--build', 'Synthetic_10_7_E', '--out', join(dir, 'out.json')], { encoding: 'utf8' });
    assert.equal(empty.status, 1);
    assert.equal(emptyRun.status, 1);
    assert.match(emptyRun.stderr, /文档清单是空的：补上这个构建的文档清单/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
