// Unit-test partitions share a migrated PostgreSQL template where possible. Normal work adapts to CPU and memory;
// timing sentinels run alone so other tests do not consume their millisecond budget. Acceptance uses the same scheduler.
// Files start longest first by their wall time in earlier runs on this machine (a file in the temporary directory), so the
// run does not end with one long file alone; without that file the order is the sorted one.
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { closeSync, globSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, freemem, loadavg, platform, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COUNTERS, parseTestOutput, type Counts } from '../.github/checks/test-summary.ts';
import { createPool, Database } from '../hub/records/db.ts';
import { migrate } from '../hub/records/migrations.ts';
import { startPostgres } from '../hub/testing/postgres.ts';
import type { TemporaryPostgres } from '../hub/testing/postgres.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const UNIT_PATTERNS = [
  'contracts/**/*.test.ts',
  'hub/**/*.test.ts',
  'packs/**/*.test.ts',
  'scripts/**/*.test.ts',
  'tools/gen-contracts*.test.ts',
  'tools/prepare-packs.test.ts',
  'tools/run-unit-tests.test.ts',
  'tools/slot-schema.test.ts',
  'tests/fixtures/**/*.test.ts',
];

/** The public parser-boundary partition. Assertions stay in these files; only the schedule changes. */
export const PARSER_BOUNDS = [
  'hub/refs/adversarial.test.ts',
  'hub/refs/parsers/html.test.ts',
  'hub/refs/skill-lazy-locate.test.ts',
  'packs/skill/html-format/functions/html.test.ts',
  'packs/skill/mindmap-format/functions/kityminder.test.ts',
  'packs/skill/workbook-format/functions/xlsx.test.ts',
  'packs/skill/xml-format/functions/resource.test.ts',
  'packs/skill/xml-format/functions/xml.test.ts',
] as const;

const PARSER_BOUND_SET = new Set<string>(PARSER_BOUNDS);

/** Millisecond budgets that a busy shared run would invalidate. They get a process of their own. */
export const SENTINELS = [
  'hub/refs/adversarial.test.ts',
  'hub/refs/skill-lazy-locate-book.test.ts',
  'hub/refs/skill-lazy-locate-mind.test.ts',
  'hub/refs/skill-lazy-locate-xml.test.ts',
  'hub/server/submit-load.test.ts',
  'hub/knowledge/view-perf.test.ts',
] as const;

const SENTINEL_SET = new Set<string>(SENTINELS);

const ISOLATED_MARK = /passwordless\s*:\s*true|CREATE ROLE\b|startPostgres\(\s*\{[^)]*socket\s*:\s*true|createPostgres\s*\(|postgresFor\s*\(|ensureDatabaseRunning\s*\(/;

export type UnitGroup = 'all' | 'regular' | 'parser-bounds' | 'acceptance' | 'docs' | 'files';
export type UnitLane = 'shared' | 'isolated' | 'sentinel';

export function unitFiles(group: UnitGroup = 'all', explicit:readonly string[]=[]): string[] {
  if (group === 'acceptance') return [...new Set(globSync(['tests/acceptance/*.test.ts','tests/acceptance/oracle/*.test.ts'], { cwd: ROOT }))].sort();
  if (group === 'docs') return [...new Set(globSync('.github/checks/*.test.ts', { cwd: ROOT }))].sort();
  if (group === 'files') return [...new Set(explicit)].sort();
  const all = [...new Set(globSync(UNIT_PATTERNS, { cwd: ROOT }))].sort();
  if (group === 'all') return all;
  if (group === 'regular') return all.filter((file) => !PARSER_BOUND_SET.has(file));
  if (group === 'parser-bounds') return all.filter((file) => PARSER_BOUND_SET.has(file));
  throw new Error('未知的单元测试分组；使用 all、regular 或 parser-bounds');
}

export function unitLane(file: string, source: string): UnitLane {
  // Parser-boundary files carry millisecond budgets. They stay out of the wide shared pool.
  if (SENTINEL_SET.has(file) || PARSER_BOUND_SET.has(file)) return 'sentinel';
  if (ISOLATED_MARK.test(source)) return 'isolated';
  return 'shared';
}

export function classifyLanes(files: readonly string[]): Record<UnitLane, string[]> {
  const lanes: Record<UnitLane, string[]> = { shared: [], isolated: [], sentinel: [] };
  for (const file of files) lanes[unitLane(file, readFileSync(resolve(ROOT, file), 'utf8'))].push(file);
  return lanes;
}

/** Maximum from available cores (or the operator's explicit cap); actual workers adapt to load. */
export function sharedConcurrency(group: UnitGroup): number {
  if (group === 'parser-bounds') return 1;
  const fromEnv = Number(process.env.HUB_UNIT_CONCURRENCY);
  const capacity=Math.max(1,availableParallelism()-1);
  return Number.isInteger(fromEnv) && fromEnv >= 1 ? Math.min(capacity,fromEnv) : capacity;
}

/** Timing sentinels run individually because their assertions measure elapsed time. */
export function sentinelConcurrency(group: UnitGroup): number {
  return 1; // timing-sensitive files run alone, without other tests in this runner
}

/** Start from observed idle capacity, then adjust gradually to keep the machine responsive. */
export function initialWorkers(cores: number, busy: number): number {
  const cap=Math.max(1,Math.floor(cores)-1);
  return Math.max(1,Math.min(cap,Math.ceil(cap*(1-Math.max(0,Math.min(1,busy))))));
}
export function nextWorkers(current: number, cap: number, busy: number, memoryFree: number): number {
  if(memoryFree<0.08)return Math.max(1,current-2);
  if(memoryFree<0.18 || busy>0.90)return Math.max(1,current-1);
  if(memoryFree>0.25 && busy<0.72)return Math.min(cap,current+1);
  return current;
}

function stringEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string' && !key.startsWith('HUB_UNIT_PG_')) env[key] = value;
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  return env;
}

/**
 * Node's on-disk compile cache (V8 code and stripped TypeScript, checked against each source's hash) for the shared and
 * isolated lanes: the test processes of a run, and later runs, stop compiling the same modules again. Timing sentinels keep
 * cold processes, as their budgets were measured. Sandboxed pack functions never see it: their environment is fixed.
 */
export const COMPILE_CACHE_DIR = join(tmpdir(), 'circle-hub-unit-compile-cache');
export function withCompileCache(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return env.NODE_COMPILE_CACHE ? env : { ...env, NODE_COMPILE_CACHE: COMPILE_CACHE_DIR };
}

/** Current spare shared-memory slots, if the host exposes the limit. */
function sharedMemorySpare(): number | null {
  try {
    if(platform()!=='darwin')return null;
    const limit=Number(execFileSync('sysctl',['-n','kern.sysv.shmmni'],{encoding:'utf8',timeout:1000}).trim());
    const text = execFileSync('ipcs', ['-m', '-o'], { encoding: 'utf8' });
    const used=text.split('\n').filter(line=>line.startsWith('m ')).length;
    return Number.isFinite(limit) ? Math.max(0,limit-used) : null;
  } catch {
    return null;
  }
}

/** macOS free memory excludes reclaimable cache; memory_pressure reports the OS's available percentage. */
function freeMemoryRatio(): number {
  try {
    if(platform()==='darwin'){
      const text=execFileSync('memory_pressure',['-Q'],{encoding:'utf8',timeout:1000});
      const match=/System-wide memory free percentage:\s*(\d+)%/.exec(text);
      if(match)return Number(match[1])/100;
    }
    if(platform()==='linux'){
      const text=readFileSync('/proc/meminfo','utf8'),match=/^MemAvailable:\s*(\d+)\s+kB/m.exec(text);
      if(match)return Math.min(1,Number(match[1])*1024/totalmem());
    }
  } catch { /* fall back to the OS-reported free bytes */ }
  return Math.min(1,freemem()/totalmem());
}

type CpuSample = {total:number;idle:number};
function cpuSample(): CpuSample {
  return cpus().reduce((sum,cpu)=>({total:sum.total+Object.values(cpu.times).reduce((a,b)=>a+b,0),idle:sum.idle+cpu.times.idle}),{total:0,idle:0});
}
export function cpuBusy(before:CpuSample,after:CpuSample):number {
  const total=after.total-before.total,idle=after.idle-before.idle;
  return total>0?Math.max(0,Math.min(1,1-idle/total)):0.5;
}

type TestTask = {file:string;lane:UnitLane};
type AdaptiveOptions = { root?:string; cap?:number; initialBusy?:number; memoryFree?:()=>number; sampleBusy?:()=>number; intervalMs?:number; onWorkers?:(active:number,target:number)=>void; output?:(text:string)=>void;
  /** Wall milliseconds of each file in earlier runs: the longest start first, so no long file is left for the end. */
  durations?:Readonly<Record<string,number>>;
  /** Called with each file's wall milliseconds when it ends. */
  onDuration?:(file:string,ms:number)=>void };
const emptyCounts=():Counts=>Object.fromEntries(COUNTERS.map(key=>[key,0])) as Counts;

/** Longest first by earlier durations; files without one (new files, a first run, CI) go first in their given order. */
export function longestFirst<T extends {file:string}>(tasks:readonly T[],durations:Readonly<Record<string,number>>):T[] {
  const known=(file:string)=>{const ms=durations[file];return typeof ms==='number'&&Number.isFinite(ms)&&ms>=0?ms:undefined;};
  return tasks.map((task,index)=>({task,index,ms:known(task.file)})).sort((a,b)=>{
    if(a.ms===undefined||b.ms===undefined)return a.ms===b.ms?a.index-b.index:a.ms===undefined?-1:1;
    return b.ms-a.ms||a.index-b.index;
  }).map(entry=>entry.task);
}

/** Durations of earlier runs on this machine. Only the order of later runs uses them; a missing or damaged file is no order. */
export const DURATIONS_FILE=join(tmpdir(),'circle-hub-unit-durations.json');
export function readDurations(path=DURATIONS_FILE):Record<string,number> {
  try {
    const value=JSON.parse(readFileSync(path,'utf8')) as {durations?:unknown};
    if(!value||typeof value.durations!=='object'||value.durations===null)return {};
    return Object.fromEntries(Object.entries(value.durations as Record<string,unknown>).filter((entry):entry is [string,number]=>typeof entry[1]==='number'&&Number.isFinite(entry[1])&&entry[1]>=0));
  } catch { return {}; }
}
export function writeDurations(observed:Readonly<Record<string,number>>,path=DURATIONS_FILE):void {
  if(Object.keys(observed).length===0)return;
  try {
    const temporary=`${path}.${process.pid}.tmp`;
    writeFileSync(temporary,JSON.stringify({durations:{...readDurations(path),...observed}}));renameSync(temporary,path);
  } catch { /* the order is a convenience: an unwritable temporary directory changes nothing else */ }
}

/** Run one isolated Node test process per file and adapt the number in flight without stopping running tests. */
export async function runAdaptiveTasks(tasks:readonly TestTask[], shared:NodeJS.ProcessEnv, clean:NodeJS.ProcessEnv, options:AdaptiveOptions={}):Promise<{code:number;counts:Counts}> {
  const root=options.root??ROOT,cap=Math.max(1,options.cap??sharedConcurrency('all'));
  const memory=options.memoryFree??freeMemoryRatio,interval=options.intervalMs??3000;
  const pending=options.durations?longestFirst(tasks,options.durations):[...tasks],active=new Map<ChildProcess,UnitLane>(),counts=emptyCounts();
  let resourceAt=0,cachedFree=1,cachedPrivate=cap;
  const resources=()=>{if(Date.now()-resourceAt>=interval){
    cachedFree=memory();const spare=sharedMemorySpare(),running=[...active.values()].filter(lane=>lane==='isolated').length;
    const memoryLimit=running+Math.max(0,Math.floor(totalmem()*cachedFree/(2*1024**3)));
    const shmLimit=spare===null?cap:running+Math.max(0,Math.floor(Math.max(0,spare-4)/2));
    cachedPrivate=Math.min(cap,memoryLimit,shmLimit);resourceAt=Date.now();
  }return {free:cachedFree,privateLimit:cachedPrivate};};
  let previous=cpuSample();
  if(options.initialBusy===undefined)await new Promise(resolve=>setTimeout(resolve,350));
  let current=cpuSample();const firstBusy=options.initialBusy??cpuBusy(previous,current);let target=initialWorkers(cap+1,firstBusy);previous=current;
  if(resources().free<0.08)target=1;
  process.stderr.write(`adaptive start ${target}/${cap} workers (CPU ${Math.round(firstBusy*100)}%, memory free ${Math.round(resources().free*100)}%)\n`);
  const dir=mkdtempSync(join(tmpdir(),'circle-hub-test-output-'));let serial=0,stopping=false,failed=false,waitingSince:number|null=null;
  const stop=()=>{stopping=true;for(const child of active.keys())child.kill('SIGINT');};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try {
    await new Promise<void>((done,reject)=>{
      const tick=setInterval(()=>{
        current=cpuSample();const busy=options.sampleBusy?.()??cpuBusy(previous,current);previous=current;const free=resources().free;
        const next=nextWorkers(target,cap,busy,free);
        if(next!==target){process.stderr.write(`adaptive workers ${target} -> ${next} (CPU ${Math.round(busy*100)}%, memory free ${Math.round(free*100)}%)\n`);target=next;}
        schedule();
      },interval);
      const finish=()=>{if(active.size===0&&(pending.length===0||stopping)){clearInterval(tick);done();}};
      const schedule=()=>{
        if(stopping)return finish();
        const {privateLimit}=resources(),runningPrivate=[...active.values()].filter(lane=>lane==='isolated').length;
        let availablePrivate=Math.max(0,privateLimit-runningPrivate);
        while(active.size<target&&pending.length){
          const index=pending.findIndex(task=>task.lane!=='isolated'||availablePrivate>0);
          if(index<0)break;
          const [task]=pending.splice(index,1),path=join(dir,`${serial++}.tap`),fd=openSync(path,'w');
          if(task.lane==='isolated')availablePrivate--;
          const child=spawn(process.execPath,['--test','--test-reporter=tap',task.file],{cwd:root,env:task.lane==='shared'?shared:clean,stdio:['ignore',fd,fd]});
          active.set(child,task.lane);options.onWorkers?.(active.size,target);
          let ended=false;const startedAt=Date.now();
          const complete=(code:number)=>{
            if(ended)return;ended=true;closeSync(fd);active.delete(child);options.onDuration?.(task.file,Date.now()-startedAt);
            try {
              const output=readFileSync(path,'utf8');if(options.output)options.output(output);else process.stdout.write(output);
              const parsed=parseTestOutput(output);
              if(parsed.counts){for(const key of COUNTERS)counts[key]+=parsed.counts[key];}
              else {counts.tests++;counts.fail++;failed=true;process.stderr.write(`No complete test summary: ${task.file}\n`);}
              if(code!==0){failed=true;if(parsed.counts?.fail===0 && parsed.counts?.cancelled===0){counts.tests++;counts.fail++;}}
            } catch(error){failed=true;counts.tests++;counts.fail++;process.stderr.write(`Cannot read test output for ${task.file}: ${String(error)}\n`);}
            options.onWorkers?.(active.size,target);schedule();finish();
          };
          child.once('error',()=>complete(1));child.once('close',code=>complete(code??1));
        }
        if(active.size===0&&pending.length){
          waitingSince??=Date.now();
          if(Date.now()-waitingSince>30_000){failed=true;counts.tests++;counts.fail++;pending.length=0;process.stderr.write('No memory or shared-memory capacity for the remaining tests\n');}
        }else waitingSince=null;
        finish();
      };
      try{schedule();}catch(error){clearInterval(tick);reject(error);}
    });
  } finally {
    process.off('SIGINT',stop);process.off('SIGTERM',stop);rmSync(dir,{recursive:true,force:true});
  }
  return {code:stopping?130:failed||counts.fail>0||counts.cancelled>0||counts.tests===0?1:0,counts};
}

async function timeClone(postgres: TemporaryPostgres): Promise<number> {
  const name = `t_clone_${process.pid.toString(16)}`;
  const admin = new Database(createPool(postgres.config, 1));
  const began = performance.now();
  try {
    await admin.query(`CREATE DATABASE ${name} TEMPLATE hub_migrated`);
    return performance.now() - began;
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    await admin.end();
  }
}

async function prepareTemplate(postgres: TemporaryPostgres): Promise<void> {
  const database = await postgres.createDatabase('hub_migrated');
  const db = new Database(createPool(database, 1));
  try {
    await migrate(db);
  } finally {
    await db.end();
  }
  const admin = new Database(createPool(postgres.config, 1));
  try {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'hub_migrated' AND pid <> pg_backend_pid()`);
  } finally {
    await admin.end();
  }
}

function sharedEnv(postgres: TemporaryPostgres): NodeJS.ProcessEnv {
  return stringEnv({
    HUB_UNIT_PG_HOST: postgres.config.host,
    HUB_UNIT_PG_PORT: String(postgres.config.port),
    HUB_UNIT_PG_USER: postgres.config.user,
    HUB_UNIT_PG_PASSWORD: postgres.config.password ?? '',
    HUB_UNIT_PG_TEMPLATE: 'hub_migrated',
    HUB_UNIT_PG_EMPTY: 'template0',
    HUB_UNIT_PG_SOCKET_DIR: postgres.socketDir,
  });
}

/** Runs a partition or acceptance, adjusting normal work while keeping timing-sensitive files isolated. */
export async function runUnitTests(group: UnitGroup = 'all', explicit:readonly string[]=[]): Promise<number> {
  const files = unitFiles(group,explicit);
  if (files.length === 0) throw new Error('单元测试分组没有文件，拒绝空运行；检查测试文件声明');
  const lanes = classifyLanes(files);
  const cap = sharedConcurrency(group);
  const wallBegan = Date.now();
  process.stderr.write(
    `test lanes shared=${lanes.shared.length} isolated=${lanes.isolated.length} sentinel=${lanes.sentinel.length} adaptiveCeiling=${cap} load=${loadavg().map((n) => n.toFixed(2)).join(' ')}\n`,
  );
  const postgres = lanes.shared.length === 0 || group==='docs' ? undefined : await startPostgres({ maxConnections: 500, sharedBuffers: '512MB', autovacuum: false, private: true });
  try {
    if (postgres) {
      await prepareTemplate(postgres);
      process.stderr.write(`template clone ${(await timeClone(postgres)).toFixed(0)} ms\n`);
    } else {
      process.stderr.write('unit shared cluster not started\n');
    }
    const sharedSet=new Set(lanes.shared),isolatedSet=new Set(lanes.isolated);
    const tasks=files.flatMap<TestTask>(file=>sharedSet.has(file)?[{file,lane:postgres?'shared':'sentinel'}]:isolatedSet.has(file)?[{file,lane:'isolated'}]:[]);
    const counts=emptyCounts();let code=0;const observed:Record<string,number>={};
    if(tasks.length){
      const result=await runAdaptiveTasks(tasks,withCompileCache(postgres?sharedEnv(postgres):stringEnv()),withCompileCache(stringEnv()),{cap,durations:readDurations(),onDuration:(file,ms)=>{observed[file]=ms;}});
      code=result.code;for(const key of COUNTERS)counts[key]+=result.counts[key];
      if(code!==130)writeDurations(observed);
    }
    if(code!==130&&lanes.sentinel.length){
      const result=await runAdaptiveTasks(lanes.sentinel.map(file=>({file,lane:'sentinel' as const})),stringEnv(),stringEnv(),{cap:1,initialBusy:0});
      if(code===0)code=result.code;for(const key of COUNTERS)counts[key]+=result.counts[key];
    }
    for(const key of COUNTERS)process.stdout.write(`# ${key} ${counts[key]}\n`);
    process.stderr.write(`test wall ${((Date.now()-wallBegan)/1000).toFixed(1)}s exit ${code}\n`);
    return code;
  } finally {
    await postgres?.stop();
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const group = process.argv[2] ?? 'all';
  const explicit=group==='files'?process.argv.slice(3):[];
  if ((group !== 'all' && group !== 'regular' && group !== 'parser-bounds' && group !== 'acceptance' && group !== 'docs' && group !== 'files') || (group==='files'?explicit.length===0:process.argv.length>3)) {
    process.stderr.write('用法：node tools/run-unit-tests.ts [all|regular|parser-bounds|acceptance|docs|files <测试文件>...]\n');
    process.exitCode = 2;
  } else {
    runUnitTests(group,explicit).then(
      (code) => {
        process.exitCode = code;
      },
      (error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 2;
      },
    );
  }
}
