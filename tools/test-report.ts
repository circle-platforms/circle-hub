// The junit report of a CI test run, shared by run-unit-tests.ts, run-acceptance-tests.ts and run-guarded-tests.ts. With
// JUNIT_REPORT=<file> a runner has `node --test` write Node's junit report to that file as well; .github/checks/test-timings.ts
// lists the slowest test files from it.

/**
 * Reporter arguments for `node --test`, none without a file. Naming one reporter replaces the default, so spec on stdout is
 * named too: .github/checks/test-summary.ts counts that output. They go before the test files, since Node ignores options
 * after them.
 */
export function junitArguments(file: string | undefined): string[] {
  if (file === undefined || file === '') return [];
  return ['--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=junit', `--test-reporter-destination=${file}`];
}
