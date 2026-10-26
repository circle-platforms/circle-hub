// Reads what `node --test` printed (spec or TAP reporter) and reports it for CI: the counts in the job summary, a warning
// naming every skipped test or suite (a skip is not a pass), and a failing exit when no test ran or any failed or was cancelled.
// Usage: node .github/checks/test-summary.ts <log file> <label>
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const COUNTERS = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'] as const;
export type Counter = (typeof COUNTERS)[number];
export type Counts = Record<Counter, number>;

export interface Skip {
  name: string;
  reason: string;
}

export interface TestOutput {
  /** The final summary; undefined when the run did not print one (it did not finish). */
  counts?: Counts;
  /** Every skipped test and skipped suite. A skipped suite is not counted in `tests`, so its tests are invisible otherwise. */
  skips: Skip[];
}

export interface Report {
  ok: boolean;
  annotations: string[];
  markdown: string;
}

const ANSI = /\x1b\[[0-9;]*m/g;
// Spec reporter: "ℹ tests 4"; TAP reporter: "# tests 4". The last occurrence wins (the final summary).
const COUNT = /^(?:ℹ|#)\s+(tests|suites|pass|fail|cancelled|skipped|todo)\s+(\d+)$/;
// Spec reporter: "﹣ name (0.04ms) # reason"; TAP reporter: "ok 2 - name # SKIP reason".
const SPEC_SKIP = /^﹣\s+(.*?)\s+\(\d+(?:\.\d+)?m?s\)(?:\s+#\s*(.*))?$/;
const TAP_SKIP = /^ok \d+ - (.*?)\s+#\s*SKIP\b\s*(.*)$/i;

export function parseTestOutput(text: string): TestOutput {
  const found: Partial<Counts> = {};
  const skips: Skip[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(ANSI, '').trim();
    const count = COUNT.exec(line);
    if (count) {
      found[count[1] as Counter] = Number(count[2]);
      continue;
    }
    const skip = SPEC_SKIP.exec(line) ?? TAP_SKIP.exec(line);
    if (skip) {
      const reason = (skip[2] ?? '').trim();
      skips.push({ name: skip[1], reason: reason === '' || reason.toUpperCase() === 'SKIP' ? 'no reason given' : reason });
    }
  }
  const complete = COUNTERS.every((c) => found[c] !== undefined);
  return { counts: complete ? (found as Counts) : undefined, skips };
}

/** A GitHub workflow command; the message is escaped as workflow command data. */
export function command(kind: 'error' | 'warning', message: string): string {
  return `::${kind}::${message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`;
}

function md(text: string): string {
  return text.replace(/[\\`*_|<>[\]]/g, (c) => `\\${c}`);
}

export function report(label: string, output: TestOutput): Report {
  const counts = output.counts;
  if (counts === undefined) {
    return {
      ok: false,
      annotations: [command('error', `${label}: no node --test summary found; the tests did not run to the end`)],
      markdown: `### ${label}\n\nNo test summary was found: the tests did not run to the end.\n`,
    };
  }
  const annotations: string[] = [];
  let ok = true;
  if (counts.tests === 0) {
    ok = false;
    annotations.push(command('error', `${label}: no test ran (the pattern matched no test file); an empty run is not a pass`));
  }
  if (counts.fail > 0 || counts.cancelled > 0) {
    ok = false;
    annotations.push(command('error', `${label}: ${counts.fail} failed, ${counts.cancelled} cancelled`));
  }
  if (counts.skipped > 0 || output.skips.length > 0) {
    annotations.push(
      command('warning', `${label}: ${counts.skipped} tests skipped, ${output.skips.length} skipped tests and suites listed in the job summary; a skip is not a pass`),
    );
  }
  const lines = [
    `### ${label}`,
    '',
    '| tests | pass | fail | cancelled | skipped | todo |',
    '| --- | --- | --- | --- | --- | --- |',
    `| ${counts.tests} | ${counts.pass} | ${counts.fail} | ${counts.cancelled} | ${counts.skipped} | ${counts.todo} |`,
    '',
  ];
  if (counts.tests === 0) lines.push('No test ran, so this job verified nothing.', '');
  if (output.skips.length > 0) {
    lines.push('Skipped here, so not verified by this job (a skipped suite hides how many tests it holds):', '');
    for (const s of output.skips) lines.push(`- ${md(s.name)}: ${md(s.reason)}`);
    lines.push('');
  }
  return { ok, annotations, markdown: `${lines.join('\n')}\n` };
}

/** Returns the exit code: 0 when at least one test ran and none failed or was cancelled, 1 otherwise, 2 on bad usage. */
export function main(argv: readonly string[], env: NodeJS.ProcessEnv, out: (line: string) => void): number {
  const [file, label] = argv;
  if (file === undefined || label === undefined || argv.length !== 2) {
    out('usage: node .github/checks/test-summary.ts <log file> <label>');
    return 2;
  }
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    out(command('error', `${label}: cannot read ${file}: ${(error as Error).message}`));
    return 1;
  }
  const result = report(label, parseTestOutput(text));
  for (const annotation of result.annotations) out(annotation);
  const summary = env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, result.markdown);
  else out(result.markdown);
  return result.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2), process.env, (line) => console.log(line));
}
