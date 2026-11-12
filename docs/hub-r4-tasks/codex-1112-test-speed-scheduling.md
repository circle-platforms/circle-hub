# Start slower local test files first

Source: the sixth local brief, its restricted verification amendment and the integrator's synthetic baseline calculations.

Allowed paths:

- `tools/run-unit-tests.ts`
- `tools/run-acceptance-tests.ts`
- `tools/ordered-test-runner.ts`
- `tools/local-test-timings.ts`
- This task page

Only the local shared unit group and the local unsharded acceptance run use the ordered Node test API. Their concurrency remains 14 and 8 on the measured machine. Public CI partitions and shards, isolated and sentinel groups, and coverage runs keep the existing CLI path. No tests, assertions, input sizes or skip conditions change.

The local duration tables hold the twenty slowest files of each measured group. Other files use the existing CI estimates. These values only affect scheduling; discovery still determines the complete file list. The baseline's longest acceptance file took 146.689060 seconds. The baseline predicts shared unit test time from 665.184 to 582.273 seconds and acceptance from 324.507 to 285.556 seconds before module-loading and setup costs. These are estimates, not a new full-run result; the fifteen-minute overall target remains unmeasured.

The programmatic API preserves its supplied file order and uses process isolation. The entry uses the standard spec and JUnit reporters, reports unsuccessful summaries with a nonzero exit code, and forwards interruption through an AbortSignal. It does not force process exit before test processes and output finish.

The programmatic API assigns `NODE_TEST_WORKER_ID` differently from the CLI. Repository source outside the frozen references does not read that variable; this change does not simulate it or claim complete equivalence of all CLI and API behavior.

The agent ran only `node --test tools/run-unit-tests.test.ts` once: eight passed, none failed or skipped, exit 0, command time 1.005008 seconds. No type check, other test file or full test set was run. The integrator checks actual ordering and JUnit with a small selection of unchanged test files. Full regression belongs to Cursor's final integration branch.
