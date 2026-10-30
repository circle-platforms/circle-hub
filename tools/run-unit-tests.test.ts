import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { COMPILE_CACHE_DIR, PARSER_BOUNDS, SENTINELS, classifyLanes, cpuBusy, initialWorkers, longestFirst, nextWorkers, readDurations, runAdaptiveTasks, sentinelConcurrency, sharedConcurrency, unitFiles, unitLane, withCompileCache, writeDurations } from './run-unit-tests.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Tracked test files that no runner picks up on purpose, each with the reason. Everything else must be run.
const NOT_RUN: Array<[pattern: string, reason: string]> = [
  ['foundation/**/*.test.ts', 'frozen Circle baseline: its own test setup, never changed or run here (AGENTS.md)'],
  ['references/**/*.test.ts', 'immutable reference archive: never run or imported (AGENTS.md)'],
  ['docs/hub-r4-research/adoc-sandbox/prototype.test.ts', 'research prototype: needs an explicit public-registry download first (docs/hub-r4-research/adoc-sandbox.md)'],
];

/** The test files of the npm scripts that run node --test directly, read from package.json so they stay in step. */
function scriptFiles(): string[] {
  const scripts = (JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
  const files: string[] = [];
  for (const [name, script] of Object.entries(scripts)) {
    if (!/^node --test\b/.test(script)) continue;
    const patterns = [...script.matchAll(/"([^"]+\.test\.ts)"|(\S+\.test\.ts)/g)].map((match) => match[1] ?? match[2]);
    assert.ok(patterns.length > 0, `${name} names no test files`);
    for (const pattern of patterns) files.push(...globSync(pattern, { cwd: ROOT }));
  }
  return files;
}

test('every tracked test file is run by a runner or listed as not run, with its reason', () => {
  const run = new Set([...unitFiles('all'), ...unitFiles('acceptance'), ...unitFiles('docs'), ...scriptFiles()]);
  const excluded = new Set(NOT_RUN.flatMap(([pattern]) => globSync(pattern, { cwd: ROOT })));
  for (const [pattern] of NOT_RUN) assert.ok(globSync(pattern, { cwd: ROOT }).length > 0, `stale exclusion: ${pattern}`);
  const tracked = execFileSync('git', ['ls-files', '-z', '--', '*.test.ts'], { cwd: ROOT }).toString().split('\0').filter(Boolean);
  assert.ok(tracked.length > 100);
  const orphans = tracked.filter((file) => !run.has(file) && !excluded.has(file));
  assert.deepEqual(orphans, [], 'add these to a runner (UNIT_PATTERNS or the acceptance and docs groups of tools/run-unit-tests.ts, or a package.json test script) or to NOT_RUN with a reason');
  for (const file of excluded) assert.equal(run.has(file), false, `${file} is both run and listed as not run`);
  for (const file of ['tests/acceptance/oracle/oracle.test.ts', 'tests/acceptance/oracle/differential.test.ts', 'tools/slot-schema.test.ts', 'tests/fixtures/recompose/checks.test.ts', '.github/checks/workflow.test.ts', 'tools/verify-reference-archive.test.ts']) assert.ok(run.has(file), file);
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

test('acceptance includes oracle files once and explicit file selection is exact', () => {
  const files=unitFiles('acceptance');assert.equal(new Set(files).size,files.length);
  assert.ok(files.includes('tests/acceptance/oracle/differential.test.ts'));
  assert.ok(files.includes('tests/acceptance/oracle/oracle.test.ts'));
  assert.deepEqual(unitFiles('files',['b.test.ts','a.test.ts','b.test.ts']),['a.test.ts','b.test.ts']);
  assert.ok(unitFiles('docs').includes('.github/checks/docs.test.ts'));
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

test('worker ceilings follow available cores while timing-sensitive files stay isolated', () => {
  assert.equal(sharedConcurrency('regular'), sharedConcurrency('all'));
  assert.equal(sharedConcurrency('parser-bounds'), 1);
  assert.ok(sharedConcurrency('all') >= 1 && sharedConcurrency('all') <= Math.max(1,availableParallelism()-1));
  assert.equal(sentinelConcurrency('parser-bounds'), 1);
  assert.equal(sentinelConcurrency('regular'), 1);
  assert.equal(sentinelConcurrency('all'), 1);
  assert.equal(classifyLanes(unitFiles('parser-bounds')).shared.length, 0);
});

test('CPU and memory pressure change the target without a fixed two-worker ceiling', () => {
  assert.equal(cpuBusy({total:100,idle:40},{total:200,idle:100}),0.4);
  assert.equal(initialWorkers(16,0.25),12);
  assert.equal(initialWorkers(4,0.9),1);
  assert.equal(nextWorkers(8,15,0.95,0.5),7);
  assert.equal(nextWorkers(8,15,0.3,0.5),9);
  assert.equal(nextWorkers(8,15,0.3,0.05),6);
  assert.equal(nextWorkers(1,15,0.95,0.01),1);
});

test('adaptive pool actually runs over two files together and reduces its target under load', async () => {
  const dir=mkdtempSync(join(tmpdir(),'synthetic-adaptive-tests-'));
  try {
    const files=Array.from({length:8},(_,i)=>{const path=join(dir,`case-${i}.test.mjs`);writeFileSync(path,"import {test} from 'node:test';test('synthetic',async()=>new Promise(r=>setTimeout(r,150)));"+(i===0?"test('synthetic skipped',{skip:'synthetic reason'},()=>{});":"")+"\n");return path;});
    const observations:Array<[number,number]>=[];
    const result=await runAdaptiveTasks(files.map(file=>({file,lane:'shared'})),{}, {},{root:dir,cap:4,initialBusy:0,memoryFree:()=>0.8,sampleBusy:()=>0.99,intervalMs:30,onWorkers:(active,target)=>observations.push([active,target]),output:()=>{}});
    assert.equal(result.code,0);assert.equal(result.counts.tests,9);assert.equal(result.counts.pass,8);assert.equal(result.counts.skipped,1);
    assert.ok(observations.some(([active])=>active>2));assert.ok(observations.some(([,target])=>target<4));
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('a failed test file makes the aggregate fail and retains its test count', async () => {
  const dir=mkdtempSync(join(tmpdir(),'synthetic-adaptive-failure-'));
  try {
    const file=join(dir,'failure.test.mjs');writeFileSync(file,"import {test} from 'node:test';test('synthetic failure',()=>{throw Error('synthetic')});\n");
    const result=await runAdaptiveTasks([{file,lane:'shared'}],{}, {},{root:dir,cap:1,initialBusy:0,memoryFree:()=>0.8,output:()=>{}});
    assert.equal(result.code,1);assert.equal(result.counts.tests,1);assert.equal(result.counts.fail,1);assert.equal(result.counts.pass,0);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('earlier durations start the longest files first; files without one go first in their given order', () => {
  const tasks=['a','b','c','d','e'].map(file=>({file,lane:'shared' as const}));
  assert.deepEqual(longestFirst(tasks,{a:10,b:300,d:300,e:20}).map(task=>task.file),['c','b','d','e','a']);
  assert.deepEqual(longestFirst(tasks,{}).map(task=>task.file),['a','b','c','d','e']);
  assert.deepEqual(longestFirst(tasks,{a:Number.NaN,b:-1,c:5}).map(task=>task.file),['a','b','d','e','c']);
});

test('durations survive between runs, merge with earlier ones and a damaged file means no order', async () => {
  const dir=mkdtempSync(join(tmpdir(),'synthetic-durations-'));
  try {
    const path=join(dir,'durations.json');
    assert.deepEqual(readDurations(path),{});
    writeDurations({'a.test.ts':120,'b.test.ts':40},path);writeDurations({'b.test.ts':60},path);
    assert.deepEqual(readDurations(path),{'a.test.ts':120,'b.test.ts':60});
    writeFileSync(path,'{not json');assert.deepEqual(readDurations(path),{});
    const files=Array.from({length:3},(_,i)=>{const file=join(dir,`case-${i}.test.mjs`);writeFileSync(file,"import {test} from 'node:test';test('synthetic',()=>{});\n");return file;});
    const started:string[]=[],ended:Record<string,number>={};
    const result=await runAdaptiveTasks(files.map(file=>({file,lane:'shared' as const})),{},{},{root:dir,cap:1,initialBusy:0,memoryFree:()=>0.8,output:()=>{},
      durations:{[files[0]]:1,[files[1]]:3,[files[2]]:2},onWorkers:()=>{},onDuration:(file,ms)=>{started.push(file);ended[file]=ms;}});
    assert.equal(result.code,0);assert.deepEqual(started,[files[1],files[2],files[0]]);
    for(const file of files)assert.ok(ended[file]>=0);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('the shared and isolated lanes reuse a compile cache unless the caller chose one', () => {
  assert.equal(withCompileCache({ PATH: '/usr/bin' }).NODE_COMPILE_CACHE, COMPILE_CACHE_DIR);
  assert.equal(withCompileCache({ NODE_COMPILE_CACHE: '/synthetic/cache' }).NODE_COMPILE_CACHE, '/synthetic/cache');
  assert.equal(COMPILE_CACHE_DIR.startsWith(tmpdir()), true);
});
