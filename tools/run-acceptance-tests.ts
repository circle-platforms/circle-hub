// Acceptance runner. Without ACCEPTANCE_SHARD it runs every acceptance file in one `node --test` process at concurrency 1.
// With ACCEPTANCE_SHARD=<index>/<total> (CI) it runs one of `total` slices, balanced by the durations below (test-shards.ts).
import { spawn } from 'node:child_process';
import { globSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseShard, shardFiles } from './test-shards.ts';
import type { Shard } from './test-shards.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const ACCEPTANCE_PATTERNS = ['tests/acceptance/*.test.ts', 'tests/acceptance/oracle/*.test.ts'];

/** What a file not listed below is expected to take: most acceptance files start their own PostgreSQL and Hub. */
export const DEFAULT_SECONDS = 50;

/**
 * Seconds a file took on the Ubuntu CI runner (mean of Hub checks runs 40698639709 and 40728577809), for files more
 * than ten seconds away from DEFAULT_SECONDS. Files near zero skip there because they need sandbox-exec. Only the
 * balance of the slices depends on these numbers; a stale entry makes a slice slower, never drops a file.
 */
export const MEASURED_SECONDS: Readonly<Record<string, number>> = {
  'tests/acceptance/05-cross-item-claims.test.ts': 39,
  'tests/acceptance/06-user-without-pack.test.ts': 40,
  'tests/acceptance/07-call-log.test.ts': 40,
  'tests/acceptance/10-item-reuse.test.ts': 39,
  'tests/acceptance/11-no-judgment.test.ts': 38,
  'tests/acceptance/12-console-security.test.ts': 31,
  'tests/acceptance/13-idempotence.test.ts': 71,
  'tests/acceptance/17-hub-restart.test.ts': 39,
  'tests/acceptance/19-concurrency.test.ts': 93,
  'tests/acceptance/21-model-violations.test.ts': 101,
  'tests/acceptance/24-lease-start-run.test.ts': 39,
  'tests/acceptance/25-test-bed.test.ts': 74,
  'tests/acceptance/26-review-report.test.ts': 200,
  'tests/acceptance/28-device-run.test.ts': 0,
  'tests/acceptance/28-jev-skill.test.ts': 0,
  'tests/acceptance/30-shared-results.test.ts': 0,
  'tests/acceptance/32-r5-dispatch-rules.test.ts': 2,
  'tests/acceptance/35-r5-t1t3-build-diff.test.ts': 36,
  'tests/acceptance/37-operation-capture.test.ts': 0,
  'tests/acceptance/38-r5-t4-1-block-cases.test.ts': 0,
  'tests/acceptance/39-r5-t9-2-skill-packs.test.ts': 4,
  'tests/acceptance/40-r5-t9-3-process-restart.test.ts': 1,
  'tests/acceptance/41-r5-t1t3-acceptance.test.ts': 107,
  'tests/acceptance/42-r5-t4-2-operations.test.ts': 0,
  'tests/acceptance/43-r5-t4-3-change.test.ts': 0,
  'tests/acceptance/44-r5-t5-1-webui.test.ts': 0,
  'tests/acceptance/T7-4-publish-governance.test.ts': 39,
  'tests/acceptance/T8-1-second-product.test.ts': 66,
  'tests/acceptance/coverage-paths.test.ts': 0,
  'tests/acceptance/oracle/differential.test.ts': 0,
  'tests/acceptance/oracle/oracle.test.ts': 1,
};

export function acceptanceFiles(): string[] {
  return [...new Set(globSync(ACCEPTANCE_PATTERNS, { cwd: ROOT }))].sort();
}

export function expectedSeconds(file: string): number {
  return MEASURED_SECONDS[file] ?? DEFAULT_SECONDS;
}

/** Resolves to the test runner's exit code; signals reach the runner, which stops its PostgreSQL clusters. */
export async function runAcceptanceTests(shard: Shard | undefined): Promise<number> {
  const files = shardFiles(acceptanceFiles(), shard, expectedSeconds);
  if (files.length === 0) throw new Error('验收分片没有文件，拒绝空运行；减少分片数或检查 tests/acceptance');
  if (shard !== undefined) process.stderr.write(`acceptance shard ${shard.index}/${shard.total}: ${files.length} files\n`);
  const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], { cwd: ROOT, stdio: 'inherit' });
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
  let shard: Shard | undefined;
  try {
    if (process.argv.length > 2) throw new Error('用法：node tools/run-acceptance-tests.ts（分片由环境变量 ACCEPTANCE_SHARD=<序号>/<总数> 指定）');
    shard = parseShard(process.env.ACCEPTANCE_SHARD);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
  if (process.exitCode !== 2) {
    runAcceptanceTests(shard).then(
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
