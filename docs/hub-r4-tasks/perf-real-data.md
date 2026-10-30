# Task: perf-real-data

Source: the integrator's performance task of 2026-10-30. On the deployed Hub a small get_nodes page (37 nodes, depth 1)
still took 11–15 s after perf-n-plus-one, and most active statements were single-key index lookups. A real quality-board
start_run failed fast because its facet view was truncated. Branch and worktree `perf-real-data`, opened from
hub-redesign at 63f1095f.

## Goal

1. Measure the get_nodes and quality-board view paths on a read-only copy of real data (harness and numbers stay outside
   Git), find the repeated lookups that remain and remove the largest ones on the get_nodes path. Pages stay
   byte-identical; every request still decides the reader's current permissions at its start and uses them for that
   request only (decision 82).
2. Say which truncation counters make the quality-board views truncated on that data, and recommend the smallest semantic
   change that would let a facts-only counting pack bind such a view; the recommendation is for the owner and integrator,
   not implemented here.

## Allowed paths

- `hub/knowledge/readable-products.ts` (new): the request-scoped answer of `PacksPort.readableProducts`
- `hub/knowledge/read.ts`, `hub/knowledge/contributions.ts`, `hub/knowledge/links.ts`: use it
- `hub/knowledge/contribution-pages.ts`, `hub/knowledge/contributions.ts`: one batched lookup for the nodes that have
  contribution records
- `hub/knowledge/read.ts`: one batched read of the children of an expanded node
- `hub/knowledge/node-page-lookups.test.ts` (new)
- `hub/knowledge/README.md` (items 13 and the batched feeding section)
- this page

Not touched: the records package (its existing `requestRead` is used as is), the pack registry and the run engine (their
remaining per-request costs are reported), contracts, packs.

## Verification

- `npx tsc --noEmit`
- the affected-tests helper with `--run`
- `node tools/run-unit-tests.ts files <every test file of hub/knowledge, hub/records and hub/server>`, since the
  readable-products decision is used by every knowledge read

## Rules

Synthetic data and a temporary loopback PostgreSQL only in Git. The real-data copy is opened read-only or copied into a
throwaway cluster; no deployment, no server, no environment or credential file. No assertion is weakened or removed; a
skipped test is not a pass. Commits with `git commit -s` on this branch only; the integrator merges.
