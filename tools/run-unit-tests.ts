// Unit-test partitions. `regular` and `parser-bounds` are the public CI split (same files, concurrency 2 and 1).
// `all` is the local run: one shared PostgreSQL cluster, per-file CREATE DATABASE ... TEMPLATE, and a higher
// concurrency for files that do not start a postmaster. Files that need their own cluster stay at concurrency 2.
// Timing sentinels run in their own process so a crowded template clone does not share their millisecond budget.
// CI splits a public partition further with a shard (`UNIT_SHARD=<index>/<total>` or a second argument), which Node's
// --test-shard applies to the partition's file list.
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { globSync, readFileSync } from 'node:fs';
import { availableParallelism, loadavg } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, Database } from '../hub/records/db.ts';
import { migrate } from '../hub/records/migrations.ts';
import { startPostgres } from '../hub/testing/postgres.ts';
import type { TemporaryPostgres } from '../hub/testing/postgres.ts';
import { parseShard } from './run-acceptance-tests.ts';
import type { Shard } from './run-acceptance-tests.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const UNIT_PATTERNS = [
  'contracts/**/*.test.ts',
  'hub/**/*.test.ts',
  'packs/**/*.test.ts',
  'scripts/**/*.test.ts',
  'tools/gen-contracts*.test.ts',
  'tools/run-acceptance-tests.test.ts',
  'tools/run-unit-tests.test.ts',
];

/** The public parser-boundary partition. Assertions stay in these files; only the schedule changes. */
export const PARSER_BOUNDS = [
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

export type UnitGroup = 'all' | 'regular' | 'parser-bounds';
export type UnitLane = 'shared' | 'isolated' | 'sentinel';

export function unitFiles(group: string = 'all'): string[] {
  const all = [...new Set(globSync(UNIT_PATTERNS, { cwd: ROOT }))].sort();
  if (group === 'all') return all;
  if (group === 'regular') return all.filter((file) => !PARSER_BOUND_SET.has(file));
  if (group === 'parser-bounds') return all.filter((file) => PARSER_BOUND_SET.has(file));
  throw new Error('未知的单元测试分组；使用 all、regular 或 parser-bounds');
}

/** Preserve the public partition argument interface for CI and its existing regression checks. */
export function unitArguments(group = 'all'): string[] {
  const files = unitFiles(group);
  if (files.length === 0) throw new Error('单元测试分组没有文件，拒绝空运行；检查测试文件声明');
  return ['--test', '--test-concurrency=' + (group === 'parser-bounds' ? 1 : 2), ...files];
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

/** Public `regular` stays at 2 and `parser-bounds` at 1. `all` uses most of this machine, leaving the postmaster a core. */
export function sharedConcurrency(group: UnitGroup): number {
  if (group === 'parser-bounds') return 1;
  if (group === 'regular') return 2;
  const fromEnv = Number(process.env.HUB_UNIT_CONCURRENCY);
  if (Number.isInteger(fromEnv) && fromEnv >= 1 && fromEnv <= 32) return fromEnv;
  return Math.max(2, Math.min(14, availableParallelism() - 1));
}

/**
 * Timing sentinels follow the group concurrency, so `parser-bounds` stays a single worker.
 * `all` does not inherit the shared lane's width. On this machine three consecutive runs of the
 * sentinel lane at concurrency 2 all passed (99–171s), including one that started at load 30,
 * and three at concurrency 1 also passed but took 166–315s. The local default is 2.
 */
export function sentinelConcurrency(group: UnitGroup): number {
  if (group === 'all') return 2;
  return sharedConcurrency(group);
}

function stringEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string' && !key.startsWith('HUB_UNIT_PG_')) env[key] = value;
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  return env;
}

/** The files Node's --test-shard keeps: index modulo total over the sorted list. Used to refuse an empty shard. */
export function shardOf(files: readonly string[], shard: Shard | undefined): string[] {
  if (shard === undefined) return [...files];
  return files.filter((_, i) => i % shard.total === shard.index - 1);
}

/** Arguments of one lane. The shard goes before the files: Node ignores a --test-shard written after them. */
export function laneArguments(files: readonly string[], concurrency: number, shard?: Shard): string[] {
  const split = shard === undefined ? [] : [`--test-shard=${shard.index}/${shard.total}`];
  return ['--test', '--test-isolation=process', `--test-concurrency=${concurrency}`, ...split, ...files];
}

function spawnLane(files: string[], concurrency: number, env: NodeJS.ProcessEnv, shard?: Shard): ChildProcess | undefined {
  if (files.length === 0) return undefined;
  return spawn(process.execPath, laneArguments(files, concurrency, shard), { cwd: ROOT, env, stdio: 'inherit' });
}

function exitOf(child: ChildProcess | undefined): Promise<number> {
  if (child === undefined) return Promise.resolve(0);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

interface Peaks {
  shm: number;
  rssKiB: number;
  cpu: number;
}

function samplePeaks(postmaster: number, into: Peaks): void {
  try {
    const text = execFileSync('ipcs', ['-m', '-o'], { encoding: 'utf8' });
    const shm = text.split('\n').filter((line) => line.startsWith('m ')).length;
    if (shm > into.shm) into.shm = shm;
  } catch {
    /* ipcs is informational */
  }
  if (postmaster <= 0) return;
  const listed = execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,rss=,pcpu='], { encoding: 'utf8' });
  let rss = 0;
  let cpu = 0;
  for (const line of listed.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (pid !== postmaster && ppid !== postmaster) continue;
    rss += Number(parts[2]);
    cpu += Number(parts[3]);
  }
  if (rss > into.rssKiB) into.rssKiB = rss;
  if (cpu > into.cpu) into.cpu = cpu;
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

/** Runs one public partition (optionally one shard of it) or the whole local suite. Resolves to the test runner's exit code. */
export async function runUnitTests(group: UnitGroup = 'all', shard?: Shard): Promise<number> {
  const files = unitFiles(group);
  if (files.length === 0) throw new Error('单元测试分组没有文件，拒绝空运行；检查测试文件声明');
  if (shard !== undefined && group === 'all') throw new Error('分片只用于 regular 和 parser-bounds 分组');
  if (shardOf(files, shard).length === 0) throw new Error('单元测试分片没有文件，拒绝空运行；减少分片数');
  const children: ChildProcess[] = [];
  const stopChildren = (): void => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT');
  };
  // Installed before either path, so an interrupted CI partition also stops its runner and the clusters it started.
  process.once('SIGINT', stopChildren);
  process.once('SIGTERM', stopChildren);
  try {
    // Public CI partitions keep one process and a global worker cap; shared lanes are local-all only.
    if (group !== 'all') {
      const child = spawnLane(files, sharedConcurrency(group), stringEnv(), shard);
      if (child) children.push(child);
      return await exitOf(child);
    }
    return await runLocalLanes(files, children);
  } finally {
    process.off('SIGINT', stopChildren);
    process.off('SIGTERM', stopChildren);
  }
}

async function runLocalLanes(files: string[], children: ChildProcess[]): Promise<number> {
  const group: UnitGroup = 'all';
  const lanes = classifyLanes(files);
  const concurrency = sharedConcurrency(group);
  const sentinelLimit = sentinelConcurrency(group);
  const wallBegan = Date.now();
  process.stderr.write(
    `unit lanes shared=${lanes.shared.length} isolated=${lanes.isolated.length} sentinel=${lanes.sentinel.length} sharedConcurrency=${concurrency} sentinelConcurrency=${sentinelLimit} load=${loadavg().map((n) => n.toFixed(2)).join(' ')}\n`,
  );
  const postgres = lanes.shared.length === 0 ? undefined : await startPostgres({ maxConnections: 500, sharedBuffers: '512MB', autovacuum: false, private: true });
  try {
    if (postgres) {
      await prepareTemplate(postgres);
      process.stderr.write(`template clone ${(await timeClone(postgres)).toFixed(0)} ms\n`);
    } else {
      process.stderr.write('unit shared cluster not started\n');
    }
    const shared = postgres ? spawnLane(lanes.shared, concurrency, sharedEnv(postgres)) : undefined;
    // Own-cluster files stay at 2 so they do not add SysV segments while the shared lane is busy.
    const isolated = spawnLane(lanes.isolated, 2, stringEnv());
    const sentinel = spawnLane(lanes.sentinel, sentinelLimit, stringEnv());
    for (const child of [shared, isolated, sentinel]) if (child) children.push(child);
    const peaks: Peaks = { shm: 0, rssKiB: 0, cpu: 0 };
    const postmaster = postgres?.pid ?? 0;
    const timer = setInterval(() => samplePeaks(postmaster, peaks), 2000);
    timer.unref();
    const laneDone = async (name: string, child: ChildProcess | undefined): Promise<number> => {
      const began = Date.now();
      const code = await exitOf(child);
      process.stderr.write(`lane ${name} exit ${code} ${((Date.now() - began) / 1000).toFixed(1)}s\n`);
      return code;
    };
    let codes: number[];
    try {
      codes = await Promise.all([laneDone('shared', shared), laneDone('isolated', isolated), laneDone('sentinel', sentinel)]);
    } finally {
      clearInterval(timer);
      samplePeaks(postmaster, peaks);
    }
    const failed = codes.find((code) => code !== 0) ?? 0;
    process.stderr.write(
      `unit wall ${((Date.now() - wallBegan) / 1000).toFixed(1)}s exit ${failed} shm=${peaks.shm} rssKiB=${peaks.rssKiB} cpu=${peaks.cpu.toFixed(0)} load=${loadavg().map((n) => n.toFixed(2)).join(' ')}\n`,
    );
    return failed;
  } finally {
    await postgres?.stop();
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const group = process.argv[2] ?? 'all';
  const fail = (message: string): void => {
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
  };
  if ((group !== 'all' && group !== 'regular' && group !== 'parser-bounds') || process.argv.length > 4) {
    fail('用法：node tools/run-unit-tests.ts [all|regular|parser-bounds] [<序号>/<总数>]（分片也可由 UNIT_SHARD 指定）');
  } else {
    Promise.resolve()
      .then(() => runUnitTests(group, parseShard(process.argv[3] ?? process.env.UNIT_SHARD)))
      .then(
        (code) => {
          process.exitCode = code;
        },
        (error: unknown) => fail(error instanceof Error ? error.message : String(error)),
      );
  }
}
