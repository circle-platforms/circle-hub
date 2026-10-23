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
// Every hand-written row currently agrees; this explicit registry must name and explain any later discrepancy.
const differences: Record<string, { actual: string[]; reason: string }> = {};
for (const row of CASE_COMMAND_TABLE) test(`hand truth: ${row.key}`, () => {
  const difference = differences[row.key];
  assert.deepEqual(paths(row.text), difference?.actual ?? [...row.commands].sort(), difference?.reason ?? row.note);
  if (difference) assert.notDeepEqual(difference.actual, row.commands);
});
test('abbreviation metadata, ambiguity, capitals and no forms', () => {
  assert.equal(scan('sh health')[0].abbreviated, true);
  assert.equal(scan('widget hea int')[0].words, 3);
  for (const text of ['SH health', 'widget HE interval', 'sh', 'relay en', 'widget health']) assert.deepEqual(scan(text), []);
  assert.equal(scan('no widget pool mode')[0].via_no, true);
  assert.equal(scan('no widget health probe')[0].via_no, false);
  assert.deepEqual(paths('2）show pools'), ['show pools']);
  assert.deepEqual(paths('show\u2028health'), []);
});
const node = (id: string | undefined, text: string, children: unknown[] = [], tagged = true) => ({ data: { id, text, ...(tagged ? { resource: ['Functional'] } : {}) }, children });
test('unique ids only; nested cases inherit outer command; steps are measurements', () => {
  const map = { root: node('root', 'show pools', [node('same', 'plain'), node('same', 'plain'), node(undefined, 'plain'), node('@4', 'plain'), node('id#2', 'plain'), node('outer', 'widget pool add', [node('inner', 'plain'), node('step', 'relay endpoint add', [node('expected', 'done', [], false)], false)])], false) };
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
  const map = { root: node('root', 'root', [node('case', 'plain', [node('step', 'show pools', [node('nonstep', 'widget pool add', [node('expected', 'done', [], false)], false)], false), node('nested', 'plain', [node('nested-step', 'relay endpoint add', [node('expected', 'done', [], false)], false)])])], false) };
  const result = caseCommandsGold(xml, [{ document: 'synthetic-doc', map }]);
  assert.deepEqual(result.cases.find((c) => c.node === 'case')!.steps.map((p) => p.path), ['/commands/show/pools']);
  assert.deepEqual(result.cases.find((c) => c.node === 'nested')!.steps.map((p) => p.path), ['/commands/relay/endpoint/add']);
});

test('lone heads, quoted words, Chinese context and English prose follow the documented phrase rules', () => {
  assert.deepEqual(paths('"ping"'), ['ping']);
  assert.deepEqual(paths('`ping`'), ['ping']);
  assert.deepEqual(paths('“ping”'), ['ping']);
  assert.deepEqual(paths('执行ping查看'), ['ping']);
  for (const text of ['ping', 'ping命令', '执行 ping 命令', 'Please ping the gateway', 'ping xxx', 'ping the gateway', 'will ping', '"ping']) assert.deepEqual(paths(text), [], text);
  assert.deepEqual(paths('ping gateway'), ['ping']);
  assert.deepEqual(paths('执行 ping xxx'), ['ping']);
  assert.deepEqual(paths('Then run widget pool add pool1'), ['widget pool add']);
  assert.deepEqual(paths('widget pool add xxx show pools'), ['show pools', 'widget pool add']);
});
