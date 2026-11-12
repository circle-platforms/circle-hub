import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { run } from 'node:test';
import { junit, spec } from 'node:test/reporters';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(import.meta.url);

export function usesCoverage(): boolean {
  return process.env.NODE_V8_COVERAGE !== undefined
    || process.execArgv.includes('--experimental-test-coverage')
    || process.env.NODE_OPTIONS?.includes('--experimental-test-coverage') === true;
}

export function slowestFirst(files: readonly string[], secondsOf: (file: string) => number): string[] {
  return [...files].sort((a, b) => secondsOf(b) - secondsOf(a) || (a < b ? -1 : a > b ? 1 : 0));
}

export function orderedArguments(files: readonly string[], concurrency: number, report?: string): string[] {
  return [ENTRY, String(concurrency), report ?? '', ...files];
}

export function runOrderedFiles(files: readonly string[], concurrency: number, report?: string) {
  const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const events = run({ files: [...files], concurrency, isolation: 'process', signal: controller.signal });
  events.on('test:summary', summary => { if (!summary.success) process.exitCode = 1; });
  events.compose(new spec()).pipe(process.stdout);
  if (report) events.compose(junit).pipe(createWriteStream(report));
  events.once('end', () => {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  });
  return events;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === ENTRY) {
  const [concurrency, report, ...files] = process.argv.slice(2);
  runOrderedFiles(files, Number(concurrency), report || undefined);
}
