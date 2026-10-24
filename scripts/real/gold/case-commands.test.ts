import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { caseCommandsGold, commandScanner, sha256 } from './case-commands.ts';
import { CATALOG_A, commandTreeXml } from '../../../tests/fixtures/case-index/catalog.ts';
import { CASE_COMMAND_TABLE } from '../../../tests/fixtures/case-index/table.ts';
const xml = commandTreeXml(CATALOG_A);
const scan = commandScanner(xml);
const paths = (text: string) => scan(text).map((m) => m.path.slice(10).replaceAll('/', ' ')).sort();
// Retain every legacy hand-written row; explicitly identify differences superseded by the strict owner rule.
const fullGrammarRows = new Set(['plain-interval','plain-pool-add','plain-endpoint-v4','plain-endpoint-v6','plain-beacon','plain-show','plain-show-detail','plain-reboot','plain-ping','short-off','short-on','short-three-words','no-own','path-show-profile','fold-line-end']);
const differences: Record<string, { actual: string[]; reason: string }> = Object.fromEntries(CASE_COMMAND_TABLE.filter(row => row.commands.length && !fullGrammarRows.has(row.key)).map(row => [row.key,{actual:[],reason:'Owner 2026-10-24: legacy prose/prefix/shorthand truth is superseded by complete tree grammar'}]));
for (const row of CASE_COMMAND_TABLE) test(`hand truth: ${row.key}`, () => {
  const difference = differences[row.key];
  assert.deepEqual(paths(row.text), difference?.actual ?? [...row.commands].sort(), difference?.reason ?? row.note);
  if (difference) assert.notDeepEqual(difference.actual, row.commands);
});
test('exact tree paths only: no abbreviation, inferred no form, case folding or numbering', () => {
  for (const text of ['sh health','widget hea int p1 5','SH health','no widget pool mode p1 rr','2）show pools','WIDGET POOL ADD p1']) assert.deepEqual(scan(text), [],text);
  assert.equal(scan('no widget health probe pool1')[0].via_no,false);
  assert.equal(scan('widget health interval pool1 5')[0].abbreviated,false);
  assert.deepEqual(paths('show\u2028health'),[]);
  assert.deepEqual(paths('show\rhealth'),[]);
  assert.deepEqual(paths('show pools\r\nshow endpoints'),['show endpoints','show pools']);
});
const node = (id: string | undefined, text: string, children: unknown[] = [], tagged = true) => ({ data: { id, text, ...(tagged ? { resource: ['Functional'] } : {}) }, children });
test('unique ids only; nested cases inherit outer command; steps are measurements', () => {
  const map = { root: node('root', 'show pools', [node('same', 'plain'), node('same', 'plain'), node(undefined, 'plain'), node('@4', 'plain'), node('id#2', 'plain'), node('outer', 'widget pool add p1', [node('inner', 'plain'), node('step', 'relay endpoint add 192.0.2.1 80', [node('expected', 'done', [], false)], false)])], false) };
  const gold = caseCommandsGold(xml, [{ document: 'agile:mindmap:synthetic-doc', map }]);
  assert.equal(gold.totals.excluded, 5);
  assert.deepEqual(gold.cases.find((c) => c.node === 'inner')?.paths.map((p) => p.path), ['/commands/show/pools', '/commands/widget/pool/add']);
  assert.deepEqual(gold.cases.find((c) => c.node === 'outer')?.steps.map((p) => p.path), ['/commands/relay/endpoint/add']);
  assert.equal(gold.tree_sha256.length, 64);
});
test('bad XML and unreadable CLI inputs fail without revealing paths', () => {
  for (const value of ['', '<commands><item></commands>', '<commands>', '<commands/><commands/>']) assert.throws(() => commandScanner(value));
  const dir = mkdtempSync(join(tmpdir(), 'case-command-'));
  try {
    const tree = join(dir, 'tree.xml'); const map = join(dir, 'map.json');
    writeFileSync(tree, '<commands>'); writeFileSync(map, JSON.stringify({ root: node('root', 'plain') }));
    for (const file of [map, join(dir, 'missing.json')]) {
      const result = spawnSync(process.execPath, ['scripts/real/gold/case-commands.ts', '--tree', tree, '--map', `${file}:synthetic-doc`, '--out', join(dir, 'gold.json')], { encoding: 'utf8' });
      assert.equal(result.status, 1); assert.ok(!result.stderr.includes(dir));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('4000 commands and 20000 cases complete within seconds', () => {
  const start = performance.now();
  const tree = `<commands><scope><menu name="widget">${Array.from({ length: 4000 }, (_, i) => `<item name="action${i}"/>`).join('')}</menu></scope></commands>`;
  const maps = Array.from({ length: 20 }, (_, i) => ({ document: `doc${i}`, map: { root: node('root', 'plain', Array.from({ length: 1000 }, (_, k) => node(`case${k}`, `widget action${k}`)), false) } }));
  const gold = caseCommandsGold(tree, maps);
  assert.equal(gold.totals.cases, 20000); assert.equal(gold.totals.unplaced, 0);
  assert.ok(performance.now() - start < 8000);
});

test('CLI accepts prefixed document ids in manifests and hashes original tree bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'case-command-cli-'));
  try {
    const tree = join(dir, 'tree.xml'); const map = join(dir, 'map.json'); const list = join(dir, 'maps.txt'); const out = join(dir, 'gold.json');
    const bytes = Buffer.concat([Buffer.from('<commands><!--'), Buffer.from([0xe9]), Buffer.from('--><item name="ping"/></commands>')]);
    writeFileSync(tree, bytes); writeFileSync(map, JSON.stringify({ root: node('case', 'ping') }));
    writeFileSync(list, `${map}:agile:mindmap:synthetic-doc\n`);
    const result = spawnSync(process.execPath, ['scripts/real/gold/case-commands.ts', '--tree', tree, '--maps', list, '--out', out], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(readFileSync(out, 'utf8')); assert.equal(value.tree_sha256, sha256(bytes)); assert.equal(value.cases[0].key, 'synthetic-doc:case');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('step measurement reads direct operation children and excludes nested case steps', () => {
  const map = { root: node('root', 'root', [node('case', 'plain', [node('step', 'show pools', [node('nonstep', 'widget pool add p1', [node('expected', 'done', [], false)], false)], false), node('nested', 'plain', [node('nested-step', 'relay endpoint add 192.0.2.1 80', [node('expected', 'done', [], false)], false)])])], false) };
  const result = caseCommandsGold(xml, [{ document: 'synthetic-doc', map }]);
  assert.deepEqual(result.cases.find((c) => c.node === 'case')!.steps.map((p) => p.path), ['/commands/show/pools']);
  assert.deepEqual(result.cases.find((c) => c.node === 'nested')!.steps.map((p) => p.path), ['/commands/relay/endpoint/add']);
});

test('whole statements use literal grammar and declared quoted argument syntax', () => {
  for(const text of ['"ping"','"show" pools',"'show' pools",'执行ping查看','执行 ping xxx','Then run widget pool add pool1','widget pool add p1 show pools']) assert.deepEqual(paths(text),[],text);
  assert.deepEqual(paths('ping gateway'),['ping']);
  assert.deepEqual(paths('ping xxx'),['ping'],'STRING is a declared argument type, not a placeholder dictionary');
  assert.deepEqual(paths('widget pool add "pool one" 80'),['widget pool add']);
  assert.deepEqual(paths('show pools\nwidget pool add p1'),['show pools','widget pool add']);
});
test('case-only command definitions retain all original paths', () => {
  const scan = commandScanner('<commands><menu name="widget"><item name="SSL"/><item name="ssl"/></menu></commands>');
  assert.deepEqual(scan('widget ssl').map(v=>v.path),['/commands/widget/ssl']);
  assert.deepEqual(scan('widget SSL').map(v=>v.path),['/commands/widget/SSL']);
});
test('apostrophes inside English contractions cannot quote an intervening lone command', () => {
  assert.deepEqual(paths("don't ping it's fine"), []); assert.deepEqual(paths("we'll ping you've asked"), []);
  assert.deepEqual(paths("执行 'ping'"), []);
});
test('CLI missing flags return usage and input errors identify only the input kind and reason', () => {
  for (const args of [[], ['--tree', 'fixture'], ['--tree', 'fixture', '--out', 'report'], ['--tree', '--out', 'report', '--map', 'fixture:doc']]) {
    const out = spawnSync(process.execPath, ['scripts/real/gold/case-commands.ts', ...args], { encoding: 'utf8' }); assert.equal(out.status, 2); assert.match(out.stderr, /用法.*--map/);
  }
  const dir = mkdtempSync(join(tmpdir(), 'gold-usage-')); try {
    const tree = join(dir, 'tree.xml'); const map = join(dir, 'map.json'); writeFileSync(tree, '<commands><item name="bad"></commands>'); writeFileSync(map, '{}');
    const run = () => spawnSync(process.execPath, ['scripts/real/gold/case-commands.ts', '--tree', tree, '--map', `${map}:private-doc`, '--out', join(dir, 'out.json')], { encoding: 'utf8' });
    let result = run(); assert.equal(result.status, 1); assert.match(result.stderr, /命令树.*标签不匹配/);
    writeFileSync(tree, '<commands/>'); result = run(); assert.match(result.stderr, /脑图 1.*缺少 root/); assert.ok(!result.stderr.includes(dir)); assert.ok(!result.stderr.includes('private-doc'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('placement includes operation, intermediate and expected text but excludes preconditions and nested case bodies',()=>{
 const pre={data:{id:'pre',text:'widget pool add p1',priority:3}};
 const map={root:node('root','plain',[node('case','plain',[pre,node('step','show pools',[node('middle','widget health probe p1 tcp',[node('expected','relay endpoint add 192.0.2.1 80',[],false)],false)],false),node('nested','plain',[node('nested-step','widget pool add p1',[node('nested-expect','done',[],false)],false)])])],false)};
 const result=caseCommandsGold(xml,[{document:'synthetic-body',map}]);
 const outer=result.cases.find(c=>c.node==='case')! as any,nested=result.cases.find(c=>c.node==='nested')! as any;
 assert.deepEqual(outer.paths,[],'title measurement remains independent of the body');
 assert.deepEqual(outer.steps.map((p:any)=>p.path),['/commands/show/pools']);
 assert.deepEqual(outer.placement_paths.map((p:any)=>p.path),['/commands/relay/endpoint/add','/commands/show/pools','/commands/widget/health/probe']);
 assert.deepEqual(nested.placement_paths.map((p:any)=>p.path),['/commands/widget/pool/add']);
});

test('step-only placement changes unplaced while retaining legacy title and direct-step measurements', () => {
  const map={root:node('root','plain',[node('case','plain',[node('step','show pools',[node('expected','done',[],false)],false)])],false)};
  const gold=caseCommandsGold(xml,[{document:'synthetic-step-only',map}]);const c=gold.cases[0];
  assert.deepEqual(c.paths,[]);assert.deepEqual(c.steps.map(p=>p.path),['/commands/show/pools']);
  assert.deepEqual(c.placement_paths!.map(p=>p.path),['/commands/show/pools']);
  assert.equal(gold.totals.unplaced,0);
  assert.equal(gold.totals.step_placed,1,'this remains the old title-unplaced/direct-step measurement');
  const missing=caseCommandsGold(xml,[{document:'synthetic-no-command',map:{root:node('root','plain',[node('case','plain',[node('step','unsupported action',[node('expected','done',[],false)],false)])],false)}}]);
  assert.equal(missing.totals.unplaced,1);assert.deepEqual(missing.cases[0].placement_paths,[]);
});

test('expectation-only commands place a case; precondition leaves cannot place it', () => {
  const leaf=(id:string,text:string,priority?:number)=>({data:{id,text,...(priority===undefined?{}:{priority})}});
  const map={root:node('root','plain',[
    node('expected-only','plain',[leaf('answer','relay endpoint add 192.0.2.1 80')]),
    node('precondition-only','plain',[leaf('pre','relay endpoint add 192.0.2.1 80',3)]),
  ],false)};
  const gold=caseCommandsGold(xml,[{document:'synthetic-expectation',map}]);
  assert.deepEqual(gold.cases.find(c=>c.node==='expected-only')!.placement_paths!.map(p=>p.path),['/commands/relay/endpoint/add']);
  assert.deepEqual(gold.cases.find(c=>c.node==='precondition-only')!.placement_paths,[]);
  assert.equal(gold.totals.unplaced,1);assert.equal(gold.totals.step_placed,0);
});

test('multi-command placement is deduplicated, sorted and independent of body order', () => {
  const operation=(id:string,text:string,expected:string)=>node(id,text,[node(id+'-expected',expected,[],false)],false);
  const children=[operation('step1','show pools','relay endpoint add 192.0.2.1 80'),operation('step2','relay endpoint add 192.0.2.1 80','show pools'),operation('step3','show pools','done')];
  const make=(items:unknown[])=>caseCommandsGold(xml,[{document:'synthetic-order',map:{root:node('root','plain',[node('case','plain',items)],false)}}]);
  const a=make(children),b=make([...children].reverse());
  assert.deepEqual(a.cases[0].placement_paths,b.cases[0].placement_paths);
  assert.deepEqual(a.cases[0].placement_paths!.map(p=>p.path),['/commands/relay/endpoint/add','/commands/show/pools']);
  assert.equal(a.cases[0].placement_paths!.find(p=>p.path==='/commands/show/pools')!.abbreviated,false);
  assert.equal(a.totals.unplaced,0);assert.deepEqual(a.cases[0].paths,[]);
});

test('nested cases own their bodies while still inheriting ancestor labels', () => {
  const nested=node('inner','plain',[node('inner-step','relay endpoint add 192.0.2.1 80',[node('inner-expected','widget pool delete p1',[],false)],false)]);
  const map={root:node('root','plain',[node('outer','plain',[nested])],false)};
  const gold=caseCommandsGold(xml,[{document:'synthetic-nested',map}]);
  assert.deepEqual(gold.cases.find(c=>c.node==='outer')!.placement_paths,[]);
  assert.deepEqual(gold.cases.find(c=>c.node==='inner')!.placement_paths!.map(p=>p.path),['/commands/relay/endpoint/add','/commands/widget/pool/delete']);
  assert.equal(gold.totals.unplaced,1);
  const inherited=caseCommandsGold(xml,[{document:'synthetic-inherit',map:{root:node('root','plain',[node('outer','show pools',[nested])],false)}}]);
  assert.deepEqual(inherited.cases.find(c=>c.node==='outer')!.placement_paths!.map(p=>p.path),['/commands/show/pools']);
  assert.deepEqual(inherited.cases.find(c=>c.node==='inner')!.placement_paths!.map(p=>p.path),['/commands/relay/endpoint/add','/commands/show/pools','/commands/widget/pool/delete']);
  assert.equal(inherited.totals.unplaced,0);
});

test('node boundaries never manufacture a command and nonleaf priority three remains an operation', () => {
  const map={root:node('root','plain',[
    node('split','plain',[node('step','widget',[node('expected','pool add',[],false)],false)]),
    node('priority-operation','plain',[{data:{id:'operation',text:'show pools',priority:3},children:[node('expected','done',[],false)]}]),
  ],false)};
  const gold=caseCommandsGold(xml,[{document:'synthetic-boundaries',map}]);
  assert.deepEqual(gold.cases.find(c=>c.node==='split')!.placement_paths,[]);
  assert.deepEqual(gold.cases.find(c=>c.node==='priority-operation')!.placement_paths!.map(p=>p.path),['/commands/show/pools']);
  assert.equal(gold.totals.unplaced,1);
});

test('grammar consumes every token and validates the locked signatures, not help prose',()=>{
 assert.deepEqual(paths('widget health interval p1 60'),['widget health interval']);
 for(const text of ['widget health interval p1 61','widget health interval p1 word','widget health interval p1','widget health interval p1 5 extra','show pools extra','relay endpoint add invalid 80','relay endpoint add 192.0.2.1 65536'])assert.deepEqual(paths(text),[],text);
 assert.deepEqual(paths('widget health probe p1 tcp'),['widget health probe']);
 assert.deepEqual(paths('widget health probe p1 TCP'),[]);
 const custom=commandScanner('<commands><menu name="alpha"><item name="exact" help_string="show this is a command"><arguments><arg type="UNKNOWN"/></arguments></item></menu></commands>');
 assert.deepEqual(custom('alpha exact value'),[],'an unknown type is not guessed from help text');
 assert.deepEqual(custom('show this is a command'),[],'help text never creates grammar paths');
});
test('no command free-text heuristics or production implementation imports remain',()=>{
 const source=readFileSync(new URL('./case-commands.ts',import.meta.url),'utf8');
 assert.doesNotMatch(source,/from\s+['"][^'"]*(?:hub\/|packs\/)/);
 for(const removed of ['const SHORT','const STOP','prefixes:','quoteRanges','englishBefore','chineseContext','resolve(tokens, i + 1)'])assert.ok(!source.includes(removed));
});
