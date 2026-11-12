# Share compilation work across local unit processes

Source: the sixth local task brief and the integrator's baseline measurement. This task starts from the final C4 integration commit and remains on the separate test-speed line.

Allowed paths:

- `tools/run-unit-tests.ts`
- `tools/run-unit-tests.test.ts`, only if an existing assertion needs synchronization
- This task page

The local `all` runner gives its three lanes one private temporary Node compilation cache and removes it after their processes finish. Modules still execute in every test process. PostgreSQL and the cache are cleaned up if setup or a lane fails. Public CI partitions, concurrency, file membership, sandbox environments and test assertions remain unchanged. Coverage runs and Node's explicit cache opt-out keep their existing behavior.

Validation: `node --test tools/run-unit-tests.test.ts` ran once: 8 tests, 0 failures, 0 skipped, exit status 0, 1.02 seconds elapsed. The existing assertions required no changes. The original output, status and elapsed time are retained as `unit-cache-own.log`, `unit-cache-own.exit` and `unit-cache-own.seconds` in the local acceptance report directory.

Only that test file ran. No type check, additional probes or complete test suite ran for this change. Cache performance across files remains unmeasured; the final combined regression belongs to Cursor's integration branch under the owner's latest testing rule.
