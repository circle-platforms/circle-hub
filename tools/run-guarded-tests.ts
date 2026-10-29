// Runner for the test files whose tests skip in the ordinary Ubuntu jobs of the Hub checks, because those runners lack what
// the tests need. Each host has its own selection, computed from the sources and never kept by hand: a test file is selected
// when it names one of the host's skip guards, or when it imports a local helper that itself skips on one of them
// (tests/acceptance/support/operation-acceptance.ts, for example).
// - macos (the `macOS-only paths` workflow, macos.yml): sandbox-exec isolation of pack functions, the keychain
//   (/usr/bin/security), plutil and launchd, and pg_dump/pg_restore of the embedded PostgreSQL's major version (MACOS_GUARD).
// - linux (the `Linux isolation` jobs of checks.yml): bubblewrap and AppArmor isolation of pack functions, which those jobs
//   install and load before they run this (ISOLATION_GUARD). The other Ubuntu jobs have no isolation and keep skipping them.
// A run refuses to start where the host's isolation is unavailable, since every guarded test would only skip. With
// GUARDED_SHARD=<index>/<total> it runs one of `total` slices, balanced by GUARDED_MEASURED_SECONDS (tools/test-shards.ts).
// Usage: node tools/run-guarded-tests.ts macos|linux unit|acceptance|list
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { osIsolationAvailable, osIsolationFailure } from '../hub/rules/sandbox/isolation.ts';
import { acceptanceFiles, DEFAULT_SECONDS } from './run-acceptance-tests.ts';
import { UNIT_DEFAULT_SECONDS, unitFiles } from './run-unit-tests.ts';
import { parseShard, shardFiles } from './test-shards.ts';
import type { Shard } from './test-shards.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export type Host = 'macos' | 'linux';
export type Kind = 'unit' | 'acceptance';

/** The skip guards of the operating-system isolation of pack functions (sandbox-exec on macOS, bubblewrap and AppArmor on Linux). */
export const ISOLATION_GUARD = /\b(?:sandboxSkip|osIsolationAvailable)\b/;

/** The isolation guards plus the macOS host tools and libpq guards a test checks for before it runs. */
export const MACOS_GUARD =
  /\b(?:sandboxSkip|osIsolationAvailable|securityAvailable|temporaryKeychainAvailable|libpqAvailable|LIBPQ_MISSING)\b|\/usr\/bin\/(?:sandbox-exec|security)\b|\bplutil\b|\blaunchctl\b|platform\s*[!=]==?\s*'darwin'/;

const GUARDS: Readonly<Record<Host, RegExp>> = { macos: MACOS_GUARD, linux: ISOLATION_GUARD };
const PLATFORMS: Readonly<Record<Host, NodeJS.Platform>> = { macos: 'darwin', linux: 'linux' };

/** A helper skips by itself when it calls a skip and names a guard (harness.ts only defines sandboxSkip, it does not skip). */
const SELF_SKIP = /\.skip\(|\bskip\s*:/;

const LOCAL_IMPORT = /\bfrom\s+'(\.{1,2}\/[^']+\.ts)'/g;

/** Whether one test file belongs to the host's run, given its source and a reader for the sources it imports. */
export function needsHost(host: Host, file: string, source: string, read: (file: string) => string | undefined): boolean {
  const guard = GUARDS[host];
  if (guard.test(source)) return true;
  for (const match of source.matchAll(LOCAL_IMPORT)) {
    const imported = relative(ROOT, join(ROOT, dirname(file), match[1]));
    if (imported.endsWith('.test.ts')) continue;
    const helper = read(imported);
    if (helper !== undefined && guard.test(helper) && SELF_SKIP.test(helper)) return true;
  }
  return false;
}

function readSource(file: string): string | undefined {
  try {
    return readFileSync(resolve(ROOT, file), 'utf8');
  } catch {
    return undefined;
  }
}

export function guardedFiles(host: Host, files: readonly string[], read: (file: string) => string | undefined = readSource): string[] {
  return files.filter((file) => needsHost(host, file, read(file) ?? '', read));
}

/** The unit files and the acceptance files of the host's run, each sorted. */
export function guardedTestFiles(host: Host): Record<Kind, string[]> {
  return { unit: guardedFiles(host, unitFiles('all')), acceptance: guardedFiles(host, acceptanceFiles()) };
}

/**
 * Worker seconds of a file's tests under Linux isolation on the Ubuntu runner (run 40814823913: the unit files at concurrency 2,
 * the acceptance files one at a time), for the unit files of 12 s or more and every acceptance file. A file not listed takes
 * the default of its kind. Only the balance of the slices depends on these numbers; a stale entry makes a slice slower, never
 * drops a file.
 */
export const GUARDED_MEASURED_SECONDS: Readonly<Record<string, number>> = {
  'hub/knowledge/feeding-bounds-identity.test.ts': 22,
  'hub/knowledge/feeding-bounds.test.ts': 26,
  'hub/knowledge/links.test.ts': 24,
  'hub/knowledge/unversioned-empty.test.ts': 12,
  'hub/rules/sandbox/sandbox.test.ts': 21,
  'hub/runs/engine/contributions.test.ts': 60,
  'hub/runs/engine/empty-slots.test.ts': 28,
  'hub/runs/engine/fragile.test.ts': 15,
  'hub/runs/engine/leases-wiring.test.ts': 35,
  'hub/runs/engine/predecessor-default.test.ts': 19,
  'hub/runs/engine/quote-fragments.test.ts': 42,
  'hub/runs/engine/reuse.test.ts': 14,
  'hub/runs/engine/start.test.ts': 14,
  'hub/runs/engine/submit.test.ts': 45,
  'hub/runs/engine/verify.test.ts': 41,
  'hub/server/assemble/cli-admin.test.ts': 76,
  'packs/product/famx/functions/cases-integration.test.ts': 16,
  'packs/skill/xml-format/functions/resource.test.ts': 16,
  'packs/workflow/case-compile/production.test.ts': 135,
  'packs/workflow/case-compile/publish.test.ts': 14,
  'packs/workflow/case-compile/recompose/end-to-end.test.ts': 68,
  'packs/workflow/case-compile/review/end-to-end.test.ts': 31,
  'packs/workflow/case-location/production.test.ts': 33,
  'packs/workflow/case-review/packs.test.ts': 24,
  'packs/workflow/defect-to-case/end-to-end.test.ts': 42,
  'packs/workflow/maintenance-sweep/production.test.ts': 12,
  'packs/workflow/regression-scope/production.test.ts': 12,
  'packs/workflow/template-gap/engine.test.ts': 161,
  'packs/workflow/traceability/production.test.ts': 15,
  'scripts/real/accept/export-build-inputs.test.ts': 75,
  'tests/acceptance/28-device-run.test.ts': 133,
  'tests/acceptance/28-jev-skill.test.ts': 163,
  'tests/acceptance/30-shared-results.test.ts': 39,
  'tests/acceptance/37-operation-capture.test.ts': 41,
  'tests/acceptance/42-r5-t4-2-operations.test.ts': 121,
  'tests/acceptance/43-r5-t4-3-change.test.ts': 45,
  'tests/acceptance/44-r5-t5-1-webui.test.ts': 76,
  'tests/acceptance/oracle/differential.test.ts': 147,
};

export function guardedSeconds(kind: Kind, file: string): number {
  return GUARDED_MEASURED_SECONDS[file] ?? (kind === 'unit' ? UNIT_DEFAULT_SECONDS : DEFAULT_SECONDS);
}

/** The files of one slice of the host's run (all of them without a shard). */
export function guardedShardFiles(host: Host, kind: Kind, shard: Shard | undefined): string[] {
  return shardFiles(guardedTestFiles(host)[kind], shard, (file) => guardedSeconds(kind, file));
}

/** Unit files run like the public `regular` partition (two workers); acceptance files run one at a time, like CI. */
export function guardedArguments(kind: Kind, files: readonly string[]): string[] {
  if (files.length === 0) throw new Error(`没有需要主机隔离的${kind === 'unit' ? '单元' : '验收'}测试文件，拒绝空运行`);
  return kind === 'unit' ? ['--test', '--test-isolation=process', '--test-concurrency=2', ...files] : ['--test', '--test-concurrency=1', ...files];
}

/** Why this machine cannot run the host's selection (every guarded test would skip), or undefined when it can. */
export async function hostUnavailable(
  host: Host,
  platform: NodeJS.Platform = process.platform,
  available: () => Promise<boolean> = osIsolationAvailable,
  failure: () => string | undefined = osIsolationFailure,
): Promise<string | undefined> {
  if (platform !== PLATFORMS[host]) return `${host} 的测试文件要在 ${PLATFORMS[host]} 上运行，这里是 ${platform}`;
  if (!(await available())) return `这台机器上没有任务包函数的操作系统隔离（${failure() ?? '原因未知'}），所选测试只会跳过，拒绝运行`;
  return undefined;
}

async function run(host: Host, kind: Kind, shard: Shard | undefined): Promise<number> {
  const unavailable = await hostUnavailable(host);
  if (unavailable !== undefined) throw new Error(unavailable);
  const files = guardedShardFiles(host, kind, shard);
  const args = guardedArguments(kind, files);
  process.stderr.write(`${host} ${kind}${shard === undefined ? '' : ` shard ${shard.index}/${shard.total}`}: ${files.length} files\n${files.map((file) => `  ${file}\n`).join('')}`);
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  const forward = (signal: NodeJS.Signals): void => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    });
  } finally {
    process.off('SIGINT', forward);
    process.off('SIGTERM', forward);
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const [host, kind] = process.argv.slice(2);
  const fail = (message: string, code: number): void => {
    process.stderr.write(`${message}\n`);
    process.exitCode = code;
  };
  if (process.argv.length !== 4 || (host !== 'macos' && host !== 'linux') || (kind !== 'unit' && kind !== 'acceptance' && kind !== 'list')) {
    fail('用法：node tools/run-guarded-tests.ts macos|linux unit|acceptance|list（分片由 GUARDED_SHARD=<序号>/<总数> 指定）', 2);
  } else if (kind === 'list') {
    const { unit, acceptance } = guardedTestFiles(host);
    for (const file of [...unit, ...acceptance]) process.stdout.write(`${file}\n`);
  } else {
    Promise.resolve()
      .then(() => run(host, kind, parseShard(process.env.GUARDED_SHARD)))
      .then(
        (code) => {
          process.exitCode = code;
        },
        (error: unknown) => fail(error instanceof Error ? error.message : String(error), 2),
      );
  }
}
