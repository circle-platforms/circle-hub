# Task: perf-n-plus-one

Source: the integrator's performance task of 2026-10-30. On the deployed Hub a start_run of the facts-only pack
quality-board@2.0.11 ran for more than 12 minutes (earlier identical calls 14–44 minutes, get_nodes p95 14.8 minutes) while
PostgreSQL executed the same single-key indexed lookup over and over. Branch and worktree `perf-n-plus-one`, opened from
hub-redesign at 85568696.

## Goal

Find the loops that issue one lookup per feeding record on the read paths of start_run (the knowledge views a facts-only
pack binds) and get_nodes (node pages and the feeding objects of a run), and group those lookups so the number of SQL
executions no longer grows with the feeding history. Results stay byte-identical; every request still checks the
permissions it captured at its start for the reader, the source and the consumer, and uses them for that request only.

## Allowed paths

- `hub/knowledge/feeding.ts`
- `hub/knowledge/feeding-visibility-batch.test.ts` (new)
- `hub/knowledge/feeding-node-select.test.ts`: one count assertion. It asserted one source read per candidate (40); a
  shared capture is now read once per call, as decision 82 allows within one request, reader and consumer, so it asserts
  exactly one read pinned to the candidates' own capture. The integrator reviews this change.
- `hub/knowledge/README.md` (the frozen feeding cut section)
- `tools/feeding-perf.ts` (new synthetic benchmark)
- this page

Not touched: `hub/refs/skills.ts`, `hub/server/recover-read.ts`, `tools/run-unit-tests.ts` (another task), the records
package, the run engine and the pack registry (their remaining per-item costs are reported, not changed).

## Verification

- `npx tsc --noEmit`
- the affected-tests helper with `--run` (decision 80), plus the PostgreSQL-backed feeding and view tests of
  `hub/knowledge` with low concurrency
- `node tools/feeding-perf.ts <empty dir> --baseline <export of 85568696 with node_modules linked>`: builds one synthetic
  fixture (a seedling root with 35,772 compiled cases, 10 fed documents × 101 cases × 4 runs = 4,040 fed records), clones
  it per code tree and asserts that both trees bind and read the same bytes

## Rules

Synthetic data and a temporary loopback PostgreSQL only; no deployment, no real system, no environment or credential file.
No assertion is weakened or removed; a skipped test is not a pass. Commits with `git commit -s` on this branch only; the
integrator merges.
