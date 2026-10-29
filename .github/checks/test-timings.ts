// Reads the junit report that `node --test` wrote for a test job (JUNIT_REPORT, tools/test-report.ts) and writes the job's
// slowest test files to the job summary, so that a file holding up its shard shows, and the measured durations that balance
// the shards (tools/run-unit-tests.ts, run-acceptance-tests.ts and run-guarded-tests.ts) can be checked against a run. It
// never fails the job: whether the tests passed is test-summary.ts's to say.
// Usage: node .github/checks/test-timings.ts <junit file> <label>
import { appendFileSync, readFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface FileTiming {
  file: string;
  /** Top-level tests and suites of the file. */
  tests: number;
  seconds: number;
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescape(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name: string) => {
    if (name[0] === '#') return String.fromCodePoint(name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10));
    return ENTITIES[name] ?? whole;
  });
}

function attributes(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of text.matchAll(/([\w:-]+)="([^"]*)"/g)) found[match[1]] = unescape(match[2]);
  return found;
}

/** The file as the repository names it; Node writes absolute paths. */
function repositoryPath(file: string, root: string): string {
  const inside = relative(root, file);
  return isAbsolute(file) && !inside.startsWith('..') && !isAbsolute(inside) ? inside : file;
}

/**
 * Seconds per test file: the sum of the file's top-level tests and suites. Their times hold their nested tests and hooks, and
 * Node counts a file's top-level `before` in its first test; loading the module is not counted. A suite names no file, so it
 * takes the file of its first test. Slowest first.
 */
export function fileTimings(junit: string, root: string): FileTiming[] {
  const files = new Map<string, FileTiming>();
  let depth = 0;
  let top: { file?: string; seconds: number } | undefined;
  const commit = (): void => {
    if (top?.file !== undefined) {
      const file = repositoryPath(top.file, root);
      const entry = files.get(file) ?? { file, tests: 0, seconds: 0 };
      entry.tests++;
      entry.seconds += top.seconds;
      files.set(file, entry);
    }
    top = undefined;
  };
  // An attribute value may hold an unescaped '>': Node writes a test named 'a <b>' as name="a &lt;b>".
  for (const match of junit.matchAll(/<(\/?)(testsuites|testsuite|testcase)\b((?:[^>"]|"[^"]*")*?)(\/?)>/g)) {
    const [, closing, tag, body, selfClosing] = match;
    if (tag === 'testsuites') continue;
    if (closing !== '') {
      if (--depth === 0) commit();
      continue;
    }
    const { file, time } = attributes(body);
    if (depth === 0) top = { file, seconds: Number(time) || 0 };
    else if (top !== undefined && top.file === undefined) top.file = file;
    if (selfClosing === '') depth++;
    else if (depth === 0) commit();
  }
  return [...files.values()].sort((a, b) => b.seconds - a.seconds || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

export function timingsMarkdown(label: string, timings: readonly FileTiming[], limit = 15): string {
  const heading = `### ${label}: slowest test files`;
  if (timings.length === 0) return `${heading}\n\nThe junit report holds no test.\n`;
  const total = timings.reduce((sum, entry) => sum + entry.seconds, 0);
  const share = (seconds: number): string => (total > 0 ? ((seconds / total) * 100).toFixed(1) : '0.0');
  const lines = [
    heading,
    '',
    `${timings.length} files, ${total.toFixed(1)} s of test time in all. A shard takes at least as long as its slowest file.`,
    '',
    '| # | File | Top-level tests | Seconds | Share |',
    '| ---: | --- | ---: | ---: | ---: |',
    ...timings
      .slice(0, limit)
      .map((entry, index) => `| ${index + 1} | \`${entry.file.replace(/\|/g, '\\|')}\` | ${entry.tests} | ${entry.seconds.toFixed(1)} | ${share(entry.seconds)}% |`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

/** Returns 0, also without a report (test-summary.ts fails a job whose tests did not run), or 2 on bad usage. */
export function main(argv: readonly string[], env: NodeJS.ProcessEnv, out: (line: string) => void, root = process.cwd()): number {
  const [file, label] = argv;
  if (file === undefined || label === undefined || argv.length !== 2) {
    out('usage: node .github/checks/test-timings.ts <junit file> <label>');
    return 2;
  }
  let markdown: string;
  try {
    markdown = timingsMarkdown(label, fileTimings(readFileSync(file, 'utf8'), root));
  } catch (error) {
    markdown = `### ${label}: slowest test files\n\nNo junit report was written: \`${(error as Error).message}\`.\n`;
  }
  const summary = env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, markdown);
  else out(markdown);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2), process.env, (line) => console.log(line));
}
