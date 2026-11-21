// Enforces that every git-tracked *.test.ts belongs to a standard suite in `npm test`, or is explicitly listed here by exact file path with a reason (never a wildcard glob).
import { execFileSync } from 'node:child_process';
import { existsSync, globSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCEPTANCE_PATTERNS } from '../../tools/run-acceptance-tests.ts';
import { UNIT_PATTERNS } from '../../tools/run-unit-tests.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const GLOB_META = /[*?[\]{}]/;
const REQUIRED_NPM_TEST_SCRIPTS = ['test:unit', 'test:docs', 'test:acceptance'] as const;

export type NotRunEntry = readonly [file: string, reason: string];

function withReason(reason: string, files: readonly string[]): NotRunEntry[] {
  return files.map((file) => [file, reason] as const);
}

const REAL_ACCEPT_REASON = 'real-system acceptance harness script: outside default Hub unit suite (run directly with node --test when needed)';
const REAL_CONVERT_REASON = 'real-system data conversion script: outside default Hub unit suite (run directly with node --test when needed)';
const REAL_GOLD_REASON = 'real-system gold-corpus tooling test: outside default Hub unit suite (run directly with node --test when needed)';
const REAL_LIB_REASON = 'real-system helper/driver library test: outside default Hub unit suite (run directly with node --test when needed)';
const REAL_TOOL_REASON = 'real-system diagnostic/probe/review runner test: outside default Hub unit suite (run directly with node --test when needed)';

/** Tracked test files intentionally omitted from default `npm test`, listed by exact path (wildcards forbidden). */
export const NOT_RUN: readonly NotRunEntry[] = [
  ...withReason(REAL_TOOL_REASON, [
    'scripts/real/accept-circle.test.ts',
    'scripts/real/benchmark/inject.test.ts',
    'scripts/real/console-page-resources.test.ts',
    'scripts/real/hub-call.test.ts',
    'scripts/real/inject-defects.test.ts',
    'scripts/real/list-models.test.ts',
    'scripts/real/measure-review.test.ts',
    'scripts/real/replay/core.test.ts',
    'scripts/real/replay/guard-compare.test.ts',
    'scripts/real/replay/guard.test.ts',
    'scripts/real/replay/native.test.ts',
    'scripts/real/replay/protocol.test.ts',
    'scripts/real/replay/submissions-compare.test.ts',
    'scripts/real/replay/submissions-net-guard.test.ts',
    'scripts/real/replay/submissions-recorded.test.ts',
    'scripts/real/replay/submissions-replay.test.ts',
    'scripts/real/replay/submissions-report.test.ts',
    'scripts/real/replay/validation.test.ts',
    'scripts/real/review-circle.test.ts',
    'scripts/real/score-injection.test.ts',
    'scripts/real/scripted-model.test.ts',
    'scripts/real/skill-script-safety.test.ts',
    'scripts/real/smoke-connectors.test.ts',
  ]),
  ...withReason(REAL_ACCEPT_REASON, [
    'scripts/real/accept/capability-scenarios.test.ts',
    'scripts/real/accept/case-location.candidates.test.ts',
    'scripts/real/accept/case-location.test.ts',
    'scripts/real/accept/closure2.test.ts',
    'scripts/real/accept/command-index.test.ts',
    'scripts/real/accept/defect-to-case-batch.test.ts',
    'scripts/real/accept/defect-to-case-compare.test.ts',
    'scripts/real/accept/device-run.test.ts',
    'scripts/real/accept/export-build-inputs.test.ts',
    'scripts/real/accept/id-spot-check.test.ts',
    'scripts/real/accept/location-index.test.ts',
    'scripts/real/accept/location-tree.test.ts',
    'scripts/real/accept/rendered-labels.test.ts',
    'scripts/real/accept/scope-cases.test.ts',
    'scripts/real/accept/story-traceability.test.ts',
    'scripts/real/accept/template-gap-metamorphic-circle.test.ts',
    'scripts/real/accept/template-gap-metamorphic.test.ts',
    'scripts/real/accept/template-gap.test.ts',
    'scripts/real/accept/test-bed.test.ts',
    'scripts/real/accept/traceability.test.ts',
  ]),
  ...withReason(REAL_CONVERT_REASON, [
    'scripts/real/convert/auto-cases.test.ts',
    'scripts/real/convert/bed-topology.test.ts',
    'scripts/real/convert/io.test.ts',
    'scripts/real/convert/observation.test.ts',
    'scripts/real/convert/runtime-profile.test.ts',
  ]),
  ...withReason(REAL_GOLD_REASON, [
    'scripts/real/gold/board-command-input.test.ts',
    'scripts/real/gold/board.test.ts',
    'scripts/real/gold/builds.test.ts',
    'scripts/real/gold/case-commands.test.ts',
    'scripts/real/gold/cases.test.ts',
    'scripts/real/gold/catalog-marks.test.ts',
    'scripts/real/gold/command-diff.test.ts',
    'scripts/real/gold/command-domains.test.ts',
    'scripts/real/gold/compile-helpers.test.ts',
    'scripts/real/gold/dup-recount.test.ts',
    'scripts/real/gold/gap-metamorphic.test.ts',
    'scripts/real/gold/id-policy.test.ts',
    'scripts/real/gold/join.test.ts',
    'scripts/real/gold/literal.test.ts',
    'scripts/real/gold/locations.test.ts',
    'scripts/real/gold/quotes.test.ts',
    'scripts/real/gold/regression-doc.test.ts',
    'scripts/real/gold/trace-scan.test.ts',
    'scripts/real/gold/trace-stories.test.ts',
    'scripts/real/gold/trace.test.ts',
  ]),
  ...withReason(REAL_LIB_REASON, [
    'scripts/real/lib/circle-session.test.ts',
    'scripts/real/lib/env-file.test.ts',
    'scripts/real/lib/inject.test.ts',
    'scripts/real/lib/otty.test.ts',
    'scripts/real/lib/report.test.ts',
    'scripts/real/lib/score-types.test.ts',
    'scripts/real/lib/score.test.ts',
  ]),
];

function readPackageScripts(root: string): Record<string, string> {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  return pkg.scripts ?? {};
}

/** Patterns matched by direct `node --test` scripts in `package.json` (currently `test:docs`). */
export function docsSuitePatterns(scripts: Readonly<Record<string, string>>): string[] {
  const script = scripts['test:docs'] ?? '';
  return [...script.matchAll(/"([^"]+\.test\.ts)"|(\S+\.test\.ts)/g)].map((match) => match[1] ?? match[2]);
}

/** Sorted deduplicated relative paths covered by the standard test runners under `root`. */
export function suiteTestFiles(root = ROOT): string[] {
  const scripts = readPackageScripts(root);
  const patterns = [...UNIT_PATTERNS, ...ACCEPTANCE_PATTERNS, ...docsSuitePatterns(scripts)];
  return [...new Set(globSync(patterns, { cwd: root }))].sort();
}

/** Sorted relative paths of all git-tracked `*.test.ts` files under `root`. */
export function trackedTestFiles(root = ROOT): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', '*.test.ts'], { cwd: root })
    .toString()
    .split('\0')
    .filter(Boolean)
    .sort();
}

export interface TestSuiteSnapshot {
  readonly tracked: readonly string[];
  readonly run: readonly string[];
  readonly notRun: readonly NotRunEntry[];
  readonly exists: (file: string) => boolean;
  readonly npmTestScript?: string;
}

/** Validate that every tracked `*.test.ts` belongs to a suite or has a valid exact `NOT_RUN` entry. */
export function evaluateTestSuites(snapshot: TestSuiteSnapshot): string[] {
  const problems: string[] = [];
  if (snapshot.npmTestScript !== undefined) {
    for (const name of REQUIRED_NPM_TEST_SCRIPTS) {
      if (!new RegExp(`\\b${name}\\b`).test(snapshot.npmTestScript)) {
        problems.push(`package.json scripts.test omits ${name}`);
      }
    }
  }
  const runSet = new Set(snapshot.run);
  const excludedSet = new Set<string>();
  for (const [entry, reason] of snapshot.notRun) {
    if (!reason.trim()) problems.push(`NOT_RUN entry ${entry} must state a non-empty reason`);
    if (GLOB_META.test(entry)) {
      problems.push(`wildcard exclusion not allowed in NOT_RUN (${entry}): list exact test file paths so new tests cannot hide`);
      continue;
    }
    if (excludedSet.has(entry)) problems.push(`duplicate NOT_RUN entry: ${entry}`);
    excludedSet.add(entry);
    if (!snapshot.exists(entry)) problems.push(`stale NOT_RUN exclusion (missing on disk): ${entry}`);
    if (runSet.has(entry)) problems.push(`${entry} is both run by a test suite and listed in NOT_RUN`);
  }
  for (const file of snapshot.tracked) {
    if (!runSet.has(file) && !excludedSet.has(file)) {
      problems.push(
        `orphan tracked test file ${file}: add it to a suite (tools/run-unit-tests.ts UNIT_PATTERNS, tools/run-acceptance-tests.ts ACCEPTANCE_PATTERNS, or package.json test:docs) or register its exact path with a reason in .github/checks/test-suites.ts`,
      );
    }
  }
  return problems;
}

/** Check repository-level test suite coverage against git-tracked `*.test.ts` files. */
export function testSuiteProblems(root = ROOT, notRun: readonly NotRunEntry[] = NOT_RUN): string[] {
  const scripts = readPackageScripts(root);
  const problems: string[] = [];
  if (docsSuitePatterns(scripts).length === 0) problems.push('package.json scripts["test:docs"] names no *.test.ts patterns');
  return [
    ...problems,
    ...evaluateTestSuites({
      tracked: trackedTestFiles(root),
      run: suiteTestFiles(root),
      notRun,
      exists: (file) => existsSync(resolve(root, file)),
      npmTestScript: scripts.test ?? '',
    }),
  ];
}
