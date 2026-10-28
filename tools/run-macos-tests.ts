// macOS runner for the `macOS-only paths` workflow. It runs the test files whose tests skip on Ubuntu CI because they need
// what only macOS (or a matching libpq) provides: sandbox-exec isolation of pack functions, the keychain (/usr/bin/security),
// plutil and launchd, and pg_dump/pg_restore of the embedded PostgreSQL's major version. The list is computed from the
// sources, never kept by hand: a test file is selected when it names one of the skip guards (MACOS_GUARD), or when it
// imports a local helper that itself skips on one of them (tests/acceptance/support/operation-acceptance.ts, for example).
// Usage: node tools/run-macos-tests.ts unit|acceptance|list
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptanceFiles } from './run-acceptance-tests.ts';
import { unitFiles } from './run-unit-tests.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The shared skip guards and the macOS host tools a test checks for before it runs. */
export const MACOS_GUARD =
  /\b(?:sandboxSkip|osIsolationAvailable|securityAvailable|temporaryKeychainAvailable|libpqAvailable|LIBPQ_MISSING)\b|\/usr\/bin\/(?:sandbox-exec|security)\b|\bplutil\b|\blaunchctl\b|platform\s*[!=]==?\s*'darwin'/;

/** A helper skips by itself when it calls a skip and names a guard (harness.ts only defines sandboxSkip, it does not skip). */
const SELF_SKIP = /\.skip\(|\bskip\s*:/;

const LOCAL_IMPORT = /\bfrom\s+'(\.{1,2}\/[^']+\.ts)'/g;

/** Whether one test file needs the macOS run, given its source and a reader for the sources it imports. */
export function needsMacos(file: string, source: string, read: (file: string) => string | undefined): boolean {
  if (MACOS_GUARD.test(source)) return true;
  for (const match of source.matchAll(LOCAL_IMPORT)) {
    const imported = relative(ROOT, join(ROOT, dirname(file), match[1]));
    if (imported.endsWith('.test.ts')) continue;
    const helper = read(imported);
    if (helper !== undefined && MACOS_GUARD.test(helper) && SELF_SKIP.test(helper)) return true;
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

export function macosFiles(files: readonly string[], read: (file: string) => string | undefined = readSource): string[] {
  return files.filter((file) => needsMacos(file, read(file) ?? '', read));
}

/** The unit files and the acceptance files of the macOS run, each sorted. */
export function macosTestFiles(): { unit: string[]; acceptance: string[] } {
  return { unit: macosFiles(unitFiles('all')), acceptance: macosFiles(acceptanceFiles()) };
}

/** Unit files run like the public `regular` partition (two workers); acceptance files run one at a time, like CI. */
export function macosArguments(kind: 'unit' | 'acceptance', files: readonly string[]): string[] {
  if (files.length === 0) throw new Error(`没有需要 macOS 的${kind === 'unit' ? '单元' : '验收'}测试文件，拒绝空运行`);
  return kind === 'unit' ? ['--test', '--test-isolation=process', '--test-concurrency=2', ...files] : ['--test', '--test-concurrency=1', ...files];
}

async function run(kind: 'unit' | 'acceptance'): Promise<number> {
  const files = macosTestFiles()[kind];
  const args = macosArguments(kind, files);
  process.stderr.write(`macOS ${kind}: ${files.length} files\n`);
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
  const kind = process.argv[2];
  if (process.argv.length !== 3 || (kind !== 'unit' && kind !== 'acceptance' && kind !== 'list')) {
    process.stderr.write('用法：node tools/run-macos-tests.ts unit|acceptance|list\n');
    process.exitCode = 2;
  } else if (kind === 'list') {
    const { unit, acceptance } = macosTestFiles();
    for (const file of [...unit, ...acceptance]) process.stdout.write(`${file}\n`);
  } else {
    run(kind).then(
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
