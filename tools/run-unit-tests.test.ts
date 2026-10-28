import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {unitArguments,unitFiles,PARSER_BOUNDS,SENTINELS,classifyLanes,laneArguments,runUnitTests,sentinelConcurrency,sharedConcurrency,unitLane,unitSeconds,unitShardFiles,UNIT_MEASURED_SECONDS} from './run-unit-tests.ts';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
test('CI test partitions are disjoint and cover every original tracked unit test',()=>{
 const all=unitFiles(),regular=unitFiles('regular'),parsers=unitFiles('parser-bounds');
 assert.deepEqual([...regular,...parsers].sort(),all);assert.equal(new Set([...regular,...parsers]).size,all.length);
 const owned=new Set(['contracts','hub','packs','scripts']);
 const tracked=execFileSync('git',['ls-files','-z'],{cwd:ROOT}).toString().split('\0').filter(file=>file.endsWith('.test.ts')&&owned.has(file.split('/')[0]));
 for(const file of tracked)assert.ok(all.includes(file),file);
 assert.deepEqual(parsers,[
  'hub/refs/adversarial.test.ts',
  'hub/refs/parsers/html.test.ts',
  'hub/refs/skill-lazy-locate-book.test.ts',
  'hub/refs/skill-lazy-locate-mind.test.ts',
  'hub/refs/skill-lazy-locate-xml.test.ts',
  'hub/refs/skill-lazy-locate.test.ts',
  'packs/skill/html-format/functions/html.test.ts',
  'packs/skill/mindmap-format/functions/kityminder.test.ts',
  'packs/skill/workbook-format/functions/xlsx.test.ts',
  'packs/skill/xml-format/functions/resource.test.ts',
  'packs/skill/xml-format/functions/xml.test.ts',
 ]);assert.ok(regular.length>0);
});
test('parser bounds retain a single worker and other unit tests retain the two-worker cap',()=>{
 assert.equal(unitArguments('parser-bounds')[1],'--test-concurrency=1');assert.equal(unitArguments('regular')[1],'--test-concurrency=2');
 assert.throws(()=>unitFiles('unknown'),/未知的单元测试分组/);
});

test('public partitions cover the unit files once', () => {
  const all = unitFiles('all');
  const regular = new Set(unitFiles('regular'));
  const bounds = unitFiles('parser-bounds');
  assert.deepEqual(bounds, [...PARSER_BOUNDS].filter((file) => all.includes(file)).sort());
  assert.equal(regular.size + bounds.length, all.length);
  for (const file of bounds) assert.equal(regular.has(file), false);
  const boundSet = new Set<string>(bounds);
  for (const file of all) assert.equal(regular.has(file) || boundSet.has(file), true);
});

test('lanes partition the suite and keep private clusters and timing sentinels out of the shared pool', () => {
  const lanes = classifyLanes(unitFiles('all'));
  const seen = new Set([...lanes.shared, ...lanes.isolated, ...lanes.sentinel]);
  assert.equal(seen.size, unitFiles('all').length);
  const sentinel = [...new Set([...SENTINELS, ...PARSER_BOUNDS])].filter((file) => unitFiles('all').includes(file)).sort();
  assert.deepEqual(lanes.sentinel, sentinel);
  for (const file of ['hub/platform/backup-live.test.ts', 'hub/records/roles.test.ts', 'hub/testing/postgres.test.ts', 'hub/server/cli.test.ts', 'hub/platform/deploy-system.test.ts']) {
    assert.equal(lanes.isolated.includes(file), true, file);
  }
  assert.equal(unitLane('hub/records/store.test.ts', 'startPostgres()'), 'shared');
  assert.equal(unitLane('hub/records/roles.test.ts', 'CREATE ' + 'ROLE hub_owner'), 'isolated');
  assert.equal(lanes.shared.length > lanes.isolated.length, true);
});

test('local concurrency tracks this machine and the public partitions stay capped', () => {
  assert.equal(sharedConcurrency('regular'), 2);
  assert.equal(sharedConcurrency('parser-bounds'), 1);
  assert.ok(sharedConcurrency('all') >= 2 && sharedConcurrency('all') <= 14);
  assert.equal(sentinelConcurrency('parser-bounds'), 1);
  assert.equal(sentinelConcurrency('regular'), sharedConcurrency('regular'));
  assert.equal(sentinelConcurrency('all'), 2);
  assert.equal(classifyLanes(unitFiles('parser-bounds')).shared.length, 0);
});

test('the shards of a public partition cover it once, balanced, and the measured files exist', () => {
  const regular = unitFiles('regular');
  assert.deepEqual(laneArguments(regular, 2), ['--test', '--test-isolation=process', '--test-concurrency=2', ...regular]);
  assert.deepEqual(unitShardFiles('regular', undefined), regular, 'without a shard the whole partition runs');
  for (const group of ['regular', 'parser-bounds'] as const) {
    for (let total = 1; total <= 4; total++) {
      const files = unitFiles(group);
      const parts = Array.from({ length: total }, (_, i) => unitShardFiles(group, { index: i + 1, total }));
      assert.equal(parts.flat().length, files.length, `${group} in ${total} shards: no overlap`);
      assert.deepEqual(parts.flat().sort(), files, `${group} in ${total} shards: every file`);
      for (const part of parts) assert.ok(part.length > 0, `${group} ${total} shards: none empty`);
    }
  }
  const loads = [1, 2, 3].map((index) => unitShardFiles('regular', { index, total: 3 }).reduce((sum, file) => sum + unitSeconds(file), 0));
  assert.ok(Math.max(...loads) <= Math.min(...loads) * 1.1, `balanced shards: ${loads.join(', ')}`);
  const all = new Set(unitFiles('all'));
  for (const file of Object.keys(UNIT_MEASURED_SECONDS)) assert.ok(all.has(file), file);
});

test('the runner refuses a shard of the local lanes and a malformed shard', async () => {
  await assert.rejects(runUnitTests('all', { index: 1, total: 2 }), /分片只用于/);
  const out = spawnSync(process.execPath, ['tools/run-unit-tests.ts', 'regular', '4/3'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(out.status, 2);
  assert.match(out.stderr, /分片必须写成/);
});
