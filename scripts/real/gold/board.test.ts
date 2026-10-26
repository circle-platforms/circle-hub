import assert from 'node:assert/strict';
import { boardLocate } from './board-locate.ts';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { boardGold, measuredUnplaced } from './board.ts';
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

test('full board CLI reports deferred semantic rules without inventing quality counts', async () => {
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
    const args = ['scripts/real/gold/board.ts','--tree',join(dir,'tree.json'),'--cases-dir',join(dir,'cases'),'--docs',join(dir,'docs.json'),'--product','synthetic','--build','Synthetic_10_7','--types','--out',join(dir,'gold.json')];
    const run=spawnSync(process.execPath,args,{encoding:'utf8'});
    assert.equal(run.status,1);assert.match(run.stderr,/非命令看板指标缺口/);
    assert.doesNotMatch(run.stdout+run.stderr,/合成文档|Synthetic_10_7|Negative/);
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
    const run = spawnSync(process.execPath, ['scripts/real/gold/board.ts', '--tree', join(dir, 'tree.json'), '--cases-dir', join(dir, 'cases'), '--docs', join(dir, 'docs.json'), '--product', 'famx', '--build', 'Synthetic_10_7_E', '--out', join(dir, 'out.json')], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /清单 3 份，导出的脑图缺 2 份：用 circle-hub original export 导出后重跑/);
    assert.doesNotMatch(run.stderr, /doc-[abc]|Synthetic/);
    const empty = spawnSync(process.execPath, ['scripts/real/gold/board.ts', '--tree', join(dir, 'tree.json'), '--cases-dir', join(dir, 'cases'), '--docs', join(dir, 'empty.json'), '--product', 'famx', '--build', 'Synthetic_10_7_E', '--out', join(dir, 'out.json')], { encoding: 'utf8' });
    writeFileSync(join(dir, 'empty.json'), '[]');
    const emptyRun = spawnSync(process.execPath, ['scripts/real/gold/board.ts', '--tree', join(dir, 'tree.json'), '--cases-dir', join(dir, 'cases'), '--docs', join(dir, 'empty.json'), '--product', 'famx', '--build', 'Synthetic_10_7_E', '--out', join(dir, 'out.json')], { encoding: 'utf8' });
    assert.equal(empty.status, 1);
    assert.equal(emptyRun.status, 1);
    assert.match(emptyRun.stderr, /文档清单是空的：补上这个构建的文档清单/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--case-commands writes the independent unplaced count into the gold', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gold-board-cc-'));
  try {
    mkdirSync(join(dir, 'cases'));
    writeFileSync(join(dir, 'cases/doc-a.json'), JSON.stringify({ root: { data: { text: '合成' }, children: [{ data: { id: 'c1', text: 'widget pool add p1', resource: ['Functional'], priority: 2 }, children: [] }] } }));
    writeFileSync(join(dir, 'docs.json'), JSON.stringify(['doc-a']));
    writeFileSync(join(dir, 'tree.json'), JSON.stringify([{ id: 'n', label: '10.7', children: [{ id: 'm', label: '10.7-R1 合成', children: [{ id: 'g', label: '合成模块', children: [{ id: 'doc-a', label: '文档甲', children: [] }] }] }] }]));
    writeFileSync(join(dir, 'cc.json'), JSON.stringify({ schema: 'case-commands-gold@1', tree_sha256: '0'.repeat(64), documents: ['doc-a','doc-b'], document_cases: {'doc-a':2,'doc-b':1}, totals: { cases: 3, comparable: 3, excluded: 0, unplaced: 2, step_placed: 0 }, cases: [
      { key: 'doc-a#c1', document: 'doc-a', node: 'c1', comparable: true, paths: [], steps: [] },
      { key: 'doc-a#c2', document: 'doc-a', node: 'c2', comparable: true, paths: [{ path: '/commands/widget/pool/add', abbreviated: false, via_no: false, words: 3 }], steps: [] },
      { key: 'doc-b#c3', document: 'doc-b', node: 'c3', comparable: true, paths: [], steps: [] },
    ] }));
    const run = spawnSync(process.execPath, ['scripts/real/gold/board.ts', '--placement-only', '--tree', join(dir, 'tree.json'), '--cases-dir', join(dir, 'cases'), '--docs', join(dir, 'docs.json'), '--product', 'famx', '--build', 'Synthetic_10_7_F', '--case-commands', join(dir, 'cc.json'), '--out', join(dir, 'out.json')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'));
    assert.equal(report.unplaced, 1, 'doc-a has one comparable case with no parsed path; doc-b is not in this build');
    assert.equal(report.placement, true, 'the gold asks the scenario to bind placement');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--case-commands counts the Hub definition: every case of the listed documents with no parsed path, and the input is validated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gold-board-cc2-'));
  try {
    mkdirSync(join(dir, 'cases'));
    writeFileSync(join(dir, 'cases/doc-a.json'), JSON.stringify({ root: { data: { text: '合成' }, children: [{ data: { id: 'c1', text: 'widget pool add p1', resource: ['Functional'], priority: 2 }, children: [] }] } }));
    writeFileSync(join(dir, 'docs.json'), JSON.stringify(['doc-a']));
    writeFileSync(join(dir, 'tree.json'), JSON.stringify([{ id: 'n', label: '10.7', children: [{ id: 'm', label: '10.7-R1 合成', children: [{ id: 'g', label: '合成模块', children: [{ id: 'doc-a', label: '文档甲', children: [] }] }] }] }]));
    const base = ['scripts/real/gold/board.ts', '--placement-only', '--tree', join(dir, 'tree.json'), '--cases-dir', join(dir, 'cases'), '--docs', join(dir, 'docs.json'), '--product', 'famx', '--build', 'Synthetic_10_7_F'];
    // A plain unplaced case, a step-placed case and an id-less unplaced case: the Hub's null row counts all three
    // (legacy rows lack placement_paths, so they retain the historical title/ancestor scope).
    const cases = [
      { key: 'doc-a#c1', document: 'doc-a', node: 'c1', comparable: true, paths: [], steps: [] },
      { key: 'doc-a#c2', document: 'doc-a', node: 'c2', comparable: true, paths: [], steps: [{ path: '/commands/widget/pool/add', abbreviated: false, via_no: false, words: 3 }] },
      { key: 'doc-a#c3', document: 'doc-a', node: 'c3', comparable: false, paths: [], steps: [] },
    ];
    writeFileSync(join(dir, 'cc.json'), JSON.stringify({ schema: 'case-commands-gold@1', tree_sha256: '0'.repeat(64), documents: ['doc-a'], document_cases: {'doc-a':3}, cases }));
    const run = spawnSync(process.execPath, [...base, '--case-commands', join(dir, 'cc.json'), '--out', join(dir, 'out.json')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')).unplaced, 3);
    // A {} file (cases not an array) is refused, not counted as 0.
    writeFileSync(join(dir, 'empty.json'), '{}');
    const notArray = spawnSync(process.execPath, [...base, '--case-commands', join(dir, 'empty.json'), '--out', join(dir, 'out.json')], { encoding: 'utf8' });
    assert.equal(notArray.status, 1);
    assert.match(notArray.stderr, /case-commands 独立答案里 cases 不是数组：按这个构建的清单重跑 case-commands\.ts/);
    // A file that covers none of the listed documents is refused with the missing count.
    writeFileSync(join(dir, 'other.json'), JSON.stringify({ schema:'case-commands-gold@1',tree_sha256:'0'.repeat(64),documents:['doc-b'],document_cases:{'doc-b':1},cases: [{ key: 'doc-b#c9', document: 'doc-b', node: 'c9', comparable: true, paths: [], steps: [] }] }));
    const none = spawnSync(process.execPath, [...base, '--case-commands', join(dir, 'other.json'), '--out', join(dir, 'out.json')], { encoding: 'utf8' });
    assert.equal(none.status, 1);
    assert.match(none.stderr, /case-commands 独立答案缺 1 份文档：按这个构建的清单重跑 case-commands\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unmeasured placement binding does not invent a count or enable deferred quality gold',()=>{
 const dir=mkdtempSync(join(tmpdir(),'gold-board-binding-'));
 try{
  mkdirSync(join(dir,'cases'));writeFileSync(join(dir,'cases/doc-a.json'),JSON.stringify(map));
  writeFileSync(join(dir,'docs.json'),'["doc-a"]');writeFileSync(join(dir,'tree.json'),'[]');
  const r=spawnSync(process.execPath,['scripts/real/gold/board.ts','--tree',join(dir,'tree.json'),'--cases-dir',join(dir,'cases'),'--docs',join(dir,'docs.json'),'--product','synthetic','--build','Synthetic_10_7','--placement','--out',join(dir,'out.json')],{encoding:'utf8'});
  assert.equal(r.status,1);assert.match(r.stderr,/非命令看板指标缺口/);
  const report={product:'synthetic',build:'Synthetic_10_7',placement:true};
  assert.equal(scenario(report).check(turns('运行 run_synthetic\n1 个用例没有解析出命令')).find(c=>c.name==='Hub 写出未归位用例数')?.ok,true);
  assert.equal(scenario(report).check(turns('运行 run_synthetic')).find(c=>c.name==='Hub 写出未归位用例数')?.ok,false);
  assert.equal(scenario({...report,unplaced:0}).check(turns('运行 run_synthetic\n1 个用例没有解析出命令')).find(c=>c.name==='未归位用例数与独立依据一致')?.ok,false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('the board locator keeps the pack label limits and the pack no-ids rule (closure item 7 probes)', () => {
  const probe = (labels: string[]): { line: string | null; module: string | null } => { const { line, module } = boardLocate(labels); return { line, module }; };
  // Input labels may be 1000 characters, but the public module-name limit remains 40.
  const longModule = '合'.repeat(45);
  assert.deepEqual(probe(['10.7', '10.7-R1', longModule]), { line: '10.7', module: null });
  // Prefix removal does not bypass the module limit.
  assert.deepEqual(probe(['10.7', '10.7-R1', `A1B-CD2: ${longModule}`]), { line: '10.7', module: null });
  // A bare version-like number is a name for the pack (idsFromTitle finds no id under 4 digits): accepted.
  assert.deepEqual(probe(['10.7', '10.7-R1', '12']), { line: '10.7', module: '12' });
  assert.deepEqual(probe(['10.7', '10.7-R1', '1.2.3.4.5']), { line: '10.7', module: '1.2.3.4.5' });
  // The no-ids rule is ids.ts, not a digit-run: a bug marker with a short id leaves it unplaced.
  assert.deepEqual(probe(['10.7', '10.7-R1', '缺陷12']), { line: '10.7', module: null });
  // Story and PLM markers with ids are ids too.
  assert.deepEqual(probe(['10.7', '10.7-R1', 'story 9001']), { line: '10.7', module: null });
  assert.deepEqual(probe(['10.7', '10.7-R1', 'PLM 910012']), { line: '10.7', module: null });
  // A leading 4-7 digit number is an id (a leading year is not).
  assert.deepEqual(probe(['10.7', '10.7-R1', '1234 合成']), { line: '10.7', module: null });
  assert.deepEqual(probe(['10.7', '10.7-R1', '2025 计划']), { line: '10.7', module: null });
});

test('the published module limit is independent of input truncation and id normalization',()=>{
 const at=(label:string)=>boardLocate(['10.7','10.7-R1',label]).module;
 for(const label of ['合'.repeat(40),'A1B-CD2: '+'合'.repeat(40)])assert.equal(at(label),'合'.repeat(40));
 for(const label of ['合'.repeat(41),'A1B-CD2: '+'合'.repeat(41),'模块x1234','2025 计划'])assert.equal(at(label),null,label);
 assert.equal(at('模块123'),'模块123');assert.equal(at('缺陷10.7'),'缺陷10.7');
 assert.equal(at('合'.repeat(40)+' '.repeat(1000)+'尾部'),'合'.repeat(40));
});


test('placement-only count prefers complete paths without invoking legacy text metrics',()=>{
 const command={path:'/commands/show/pools',abbreviated:false,via_no:false,words:2};
 const input={schema:'case-commands-gold@1',tree_sha256:'a'.repeat(64),documents:['synthetic-doc'],document_cases:{'synthetic-doc':2},cases:[
  {document:'synthetic-doc',comparable:true,paths:[],steps:[command],placement_paths:[command]},
  {document:'synthetic-doc',comparable:false,paths:[],steps:[],placement_paths:[]},
 ]};
 assert.equal(measuredUnplaced(input,new Set(['synthetic-doc'])),1);
 assert.equal(measuredUnplaced({...input,cases:input.cases.map(({placement_paths,...row})=>row)},new Set(['synthetic-doc'])),2,'legacy input retains only its declared scope');
 for(const invalid of [null,{},[{path:'/commands/show/pools'}]])assert.throws(()=>measuredUnplaced({...input,cases:[{...input.cases[0],placement_paths:invalid},input.cases[1]]},new Set(['synthetic-doc'])));
});


test('placement-only CLI emits no invented quality metrics and requires no free-text source',()=>{
 const dir=mkdtempSync(join(tmpdir(),'board-placement-only-'));
 try{
  const command={path:'/commands/show/pools',abbreviated:false,via_no:false,words:2};
  writeFileSync(join(dir,'docs.json'),'["synthetic-doc"]');
  writeFileSync(join(dir,'commands.json'),JSON.stringify({schema:'case-commands-gold@1',tree_sha256:'a'.repeat(64),documents:['synthetic-doc'],document_cases:{'synthetic-doc':1},cases:[{document:'synthetic-doc',comparable:true,paths:[],steps:[command],placement_paths:[command]}]}));
  const child=spawnSync(process.execPath,['scripts/real/gold/board.ts','--placement-only','--docs',join(dir,'docs.json'),'--case-commands',join(dir,'commands.json'),'--out',join(dir,'out.json')],{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);const answer=JSON.parse(readFileSync(join(dir,'out.json'),'utf8'));
  assert.equal(answer.unplaced,0);assert.equal(answer.placement,true);assert.equal(answer.totals,undefined);assert.equal(answer.groups,undefined);assert.ok(answer.omitted.length);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
