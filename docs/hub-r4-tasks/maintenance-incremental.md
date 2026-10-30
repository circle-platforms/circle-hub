# Visit only the runs something happened to, and verify a record once

After D5 the deployed Hub listened at once, but a maintenance pass still took about 90 s on the production data and ran
every minute, so maintenance kept one core busy. A profile of a pass on the throwaway copy of the real data showed half the
time in reading records and checking them against their digests: every pass read and verified every run's actions again.
The owner kept the check (the generic model's B05 R[5]) and chose to read less (decision 100).

Change:

- `PgRecordStore` remembers the rows this process verified (digest, envelope and body text, bounded at 32 Mi characters,
  only byte-canonical rows). A row read again with the same envelope and the same body text is the same bytes, so its
  digest is not computed again; any difference goes through the full check, so a row changed behind the triggers is still
  refused (new test).
- `RecordStore.lastPositions({keys, values})`, optional: the newest append position of each value under any of the keys,
  in one query over the `record_index_lookup` index.
- `dispatchedRuns(records)` (hub/dispatch): the jobs bound to each run, from one scan of the reservations; wired as the
  engine's `dispatch.runs()`.
- Scheduled maintenance passes (`maintain({ incremental: true })`, the minute timer and the first pass) keep a memory per run:
  the newest position among its actions, submissions, results, requests, successor runs, its predecessor's and its dispatch
  jobs' events. A run whose position did not move and whose submission deadline did not pass since its last visit is
  skipped. The first pass after a start and one every 30 minutes (`FULL_PASS_MS`) visit every run, for what no record of the
  run shows (a moved knowledge root, a disabled account). A visit remembers the position it found before its own writes, so
  a record written while a run is being maintained is never missed; the cost is one more visit after each change. An
  explicit `maintain()` still visits every run. The request sweeps run every pass as before.

On the copy (476 runs, 17,778 requests, dispatch wired, network denied) a pass with nothing to do takes 1.2 s and 272
queries; a full pass 10–11 s and about 7,900 queries (before D5: 13–15 s, about 131,000).

Allowed paths: `hub/records/store.ts`, `hub/records/api.ts`, `hub/records/store.test.ts`, `hub/records/README.md`,
`hub/dispatch/read-runs.ts`, `hub/dispatch/api.ts`, `hub/server/assemble/hub.ts`, `hub/runs/engine/deps.ts`,
`hub/runs/engine/maintenance.ts`, `hub/runs/engine/service.ts`, `hub/runs/engine/maintenance-pass.test.ts`,
`hub/runs/engine/README.md`, `docs/hub-r4-progress.md` (decision 100 and the deferred list), this page.

Verification: `npx tsc --noEmit`; the new maintenance and store tests; `affected-tests.py --run`; the full check before
deploying.
