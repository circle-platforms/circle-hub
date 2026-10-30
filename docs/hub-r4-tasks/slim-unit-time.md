# Shorten the wall time of the unit suite

Source: owner decision 90 (slimming: shorten the unit tests, delete no assertion) and the integrator's task of 2026-10-30.
Branch and worktree `slim-unit-time`, opened from hub-redesign at c638c137.

## Goal

At least 25 percent less wall time for `npm run test:unit` on the macOS development machine, with no test or assertion
deleted, skipped, weakened or loosened, and the timing sentinels still running alone.

## Allowed paths

- `tools/run-unit-tests.ts`, `tools/run-unit-tests.test.ts`
- test helpers: `hub/testing/no-fsync.ts` (new), `tests/acceptance/support/hub.ts`
- test files: `hub/records/store.test.ts`, `hub/server/assemble/testing-real.test.ts`, `hub/server/submit-load.test.ts`,
  `scripts/real/accept/export-build-inputs.test.ts`
- this page

No production code of the Hub or of a pack changes.

## What the time went to

Measured on this machine (15 cores, Node 24.17, PostgreSQL 18.4). Baseline at c638c137, `npm run test:unit` under
`/usr/bin/time -l`: 637.3 s wall, 3,207 s CPU of the test process tree (2,378 s user, 829 s system), 8,377 tests,
10 skipped, 0 failed. A run has two phases: the shared and isolated lanes in parallel (464 s) and the twelve timing
sentinels one after another (174 s).

- **A one-minute stall in every run.** `hub/records/store.test.ts` checks that a pool without a password is refused.
  pg-pool does not end a client whose connection fails, so the refused socket stays open and its server backend waits in
  `authentication` for `authentication_timeout` (60 s). Such a backend does not absorb the barrier every `DROP DATABASE`
  waits for, so for a minute no test database on the shared cluster could be dropped and 14 running files stalled at their
  teardown (an instrumented run shows 14 files on one core from 220 s to 280 s; `effect-snapshot.test.ts`, one test, took
  52.7 s instead of 1.9 s). Reproduced alone: a drop takes 8 ms before the refused pool and 59,734 ms after it.
- **The parallel phase waits on the file system.** Per-file CPU (each test process under `/usr/bin/time`) adds up to
  2,332 s over 466 s, five cores on average with 14 files running. In the dispatch files (46 files, 356 tests, 14 workers,
  67 to 74 s) a test-database clone took 778 ms at the median and its drop 1,009 ms (38 ms and 8 ms on an idle cluster),
  59 % of their worker time; spreading the shared lane over three clusters, the FILE_COPY strategy with
  `file_copy_method = clone`, or skipping the drops did not help (74.9, 69.2, 75.5 s). What does help is fsync: a file and
  directory fsync runs at 250 pairs a second for one writer and 375 for twelve, serialized machine-wide, and the object store
  and the vault fsync every write (`hub/dispatch/review-first.test.ts` alone issues 1,498). With fsync a no-op the same 46
  files take 21.5 s instead of 67.1 s.
- **Repeated CPU.** 8,924 sandboxed pack-function launches per run (about 90 ms of CPU each, 30 ms of it stripping the
  TypeScript of the bootstrap), 8,208 `ps` launches of the sandbox's resident watch, and every test process compiling and
  type-stripping the Hub again (importing `hub/server/testing-real.ts` costs 0.67 s of CPU cold, 0.25 s from Node's compile
  cache).
- **A long tail.** Files ran in path order, so the longest end-to-end files of `packs/workflow` started last.
- **Packs nobody uses.** `createTestHub` publishes every repository pack by default: 10.7 to 12.8 s on a quiet machine,
  against 4.8 s for the eleven the acceptance bed uses and 0.5 s for none.

## Commits

| Commit | Lever | Effect measured |
| --- | --- | --- |
| ddc7c911 | the passwordless-pool test refuses on a private cluster (+0.4 s for that cluster) | the 60 s stall is gone: `store.test.ts` 96 s → 29 to 37 s, `effect-snapshot.test.ts` 52.7 s → 1.9 s, `criterion-freeze.test.ts` 77 s → 17 s |
| 3f3ac93f | longest files first, by their wall time in the previous run (a file in the temporary directory; without it the sorted order) | with the stall fix, parallel phase 463.6 s → 405.5 s (run B) |
| 0247f76a | the lease-wiring test of `createTestHub` publishes no repository pack | 10.7 to 12.8 s → 0.5 s of hub setup in that test |
| 549e6902 | Node's compile cache for the shared and isolated lanes (in the temporary directory; sentinels keep cold processes) | parallel phase 405.5 s → 370.8 s on a cold cache (run C), tree CPU 3,275 s → 3,128 s |
| 5ea6ae0e | `openBed` takes `repositoryPacks`; `bedPacks()` names the bed's eleven; `submit-load` and `export-build-inputs` use it | `submit-load` (a sentinel) 37.1 s → 30.7 s alone, 33.0 s in run D; `export-build-inputs` 58.1 s → 45.6 s |
| a4e6eece | the sentinels run before the parallel lanes | none measurable (sentinel sum 175.6 s in C, 182.1 s in E); kept because the sentinels then start before this run's file churn |
| 888fcce3 | `hub/testing/no-fsync.ts`: fsync and fdatasync return at once in the shared and isolated lanes (`HUB_UNIT_FSYNC=on` keeps them), like `fsync=off` of the test clusters | the 46 dispatch files 67.1 s → 21.5 s; in the full run the parallel phase about 363 s → 298 s (run E → F), process-tree CPU 3,135 s → 2,994 s |

Full runs, all `npm run test:unit` under `/usr/bin/time -l` (wall s / parallel s / sentinels s / CPU of the process tree s /
CPU of the whole machine s). The machine is shared with other sessions; the last column shows how much else ran.

| Run | Code | Wall | Parallel | Sentinels | Tree CPU | Machine CPU |
| --- | --- | --- | --- | --- | --- | --- |
| baseline | c638c137 | 637.1 | 463.6 | 173.5 | 3,207 | not measured |
| baseline, instrumented | c638c137 | 643.6 | 466.1 | 177.5 | 3,224 | 4,722 |
| A | + ddc7c911 (another session's tests ran meanwhile) | 703.3 | 477.9 | 225.4 | 3,269 | 6,417 |
| B | + 3f3ac93f, 0247f76a | 589.2 | 405.5 | 183.7 | 3,275 | 5,148 |
| C | + 549e6902 (cold compile cache) | 546.4 | 370.8 | 175.6 | 3,128 | 4,581 |
| D | + 5ea6ae0e (more outside load) | 613.3 | 427.5 | 185.8 | 3,185 | 5,850 |
| E | + a4e6eece | 546.3 | 363 | 182.1 | 3,135 | 4,947 |
| F | + 888fcce3 | 483.2 | 298 | 183.9 | 2,994 | 4,690 |
| G | the same code again, with an earlier draft of this page (another worktree's type check and tests ran meanwhile) | 574.9 | 318 | 253.3 | 2,964 | 6,298 |

Run F against the baseline: 24.2 % less wall time and 6.6 % less CPU of the process tree; the parallel phase is 36 %
shorter. The sentinels vary with what else the machine runs (fseventsd alone used a core all afternoon; in run G another
session's work pushed them from 184 s to 253 s while the parallel phase stayed at 318 s); at the baseline's 173.5 s run F
would have been 26 % shorter.

## Not done, and why

- **Production changes this measurement points at** (not made, described for the owner):
  - `hub/records/db.ts`: a client whose password function throws keeps its socket (pg-pool drops the client without ending
    it), so the server waits `authentication_timeout` and every `DROP DATABASE` of that cluster waits with it. Ending the
    client on a failed connect would make the private cluster of `store.test.ts` unnecessary.
  - The sandbox type-strips `bootstrap.ts` and `policy.ts` on every launch (about 30 of the 90 ms of CPU); a stripped
    bootstrap would save about 270 s of CPU per run. The resident watch starts `/bin/ps` every 100 ms per test process.
- **Sharing a database per file** (one clone instead of one per test): most database-heavy tests count what they wrote, so
  it changes what they assert; not done.
- **A RAM disk for `TMPDIR`** would also take the remaining file churn (each test database is about 750 file operations)
  off the shared volume, sentinels included; it is an environment change for the owner, not a code change.
- **The fsync stand-in is a test-environment choice** like `fsync=off` of the test clusters: no assertion depends on fsync
  (none of the unit tests checks durability across a power loss), the timing sentinels keep real fsync, and
  `HUB_UNIT_FSYNC=on` restores it everywhere. It is the one commit the integrator may want the owner to see.
- **Acceptance**: 43 acceptance files open a bed and publish every repository pack; files that use only the bed's packs can
  pass `repositoryPacks: await bedPacks()`. Not changed here (secondary goal; each file needs its own check).
- No test was found redundant.

## Verification

- `npx tsc --noEmit` after every commit: no errors.
- Each commit's touched files through the runner (`node tools/run-unit-tests.ts files <paths>`): `hub/records/store.test.ts`
  with the runner tests (25 pass), the runner tests with `testing-real.test.ts` (16 pass), `submit-load.test.ts` with
  `export-build-inputs.test.ts` (27 pass), `tests/acceptance/01-normal-review.test.ts` for the bed's default (7 pass), the
  runner tests with two sentinels (28 pass), the runner tests with all of `hub/records` (186 pass).
- `npm run test:unit` at 888fcce3 (run F) and again with an earlier draft of this page (run G): 8,381 tests, 8,371 passed, 0 failed, 10 skipped each
  (the baseline's 8,377 plus four new runner tests; the same ten skips).
- `npm run test:acceptance` at 888fcce3 (the runner changes apply to it too): 199 tests, 199 passed, 480.6 s (the
  integrator's run at c638c137: 453.0 s; nothing acceptance-specific changed, and its first run has no stored durations).
- `npm run test:docs`: 332 tests, 332 passed.
- Measurement only, not committed: a copy of the runner that timed every test process under `/usr/bin/time`, a preload that
  counted sandbox launches (it disturbed two process-group tests of `hub/rules/sandbox`, so its run is not a verification),
  a temporary timing log in `hub/testing/postgres.ts` (reverted), and scratch benchmarks of clones, fsync and imports.
