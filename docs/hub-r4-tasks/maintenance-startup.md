# Serve before the first maintenance pass and make a pass cheap

The owner asked to fix the slow start found in the restart drill (decision 98 records it): the deployed Hub took about three
minutes to listen after every start, and a stop often outlived systemd's SIGTERM window and was killed.

Cause, measured on the throwaway copy of the real data (476 runs, 17,778 requests): `serve` awaited a whole run-maintenance
pass before listening, and `stopMaintenance` awaited a pass in progress. One pass issued about 131,000 queries (13–15 s on
the Mac copy; at about a millisecond per round trip on the deployed host, minutes): every listing of the requests looked up
each request's answer separately (about 22,000 lookups per listing, four listings per pass), the overdue-request sweep read
the account list and looked up the escalation of each of the 17,778 overdue requests, and every step read the account list
again.

Change:

- `requestRecords` reads the answers of a page of 500 requests at once (`findMany`) and keeps the newest of each request, as
  the lookup per request did; a page whose answers do not all name their request falls back to the lookup per request.
- A maintenance pass reads the account list once; the overdue sweep skips an escalation that exists (the dedup key the write
  would find, now exported as `requestKey`/`requestKeyOf` from hub/requests).
- `maintainRuns` takes a stop question asked between runs and between the request sweeps; `stopMaintenance({ abort: true })`
  makes a pass in progress return there (every step is idempotent, so the next pass goes on). `startMaintenance` schedules the
  minute timer before the first pass, so a failed first pass is retried on schedule.
- `serve` listens first and starts maintenance in the background, writes the first pass's duration (or failure) to the
  operator's log, and on stop asks a pass in progress to stop at its next run.

On the copy a pass now issues 7,013 queries and takes 4.5–6.2 s.

Allowed paths: `hub/requests/service.ts`, `hub/requests/api.ts`, `hub/requests/service.test.ts`, `hub/runs/engine/maintenance.ts`,
`hub/runs/engine/requests.ts`, `hub/runs/engine/service.ts`, `hub/runs/engine/maintenance-pass.test.ts`, `hub/server/main.ts`,
`hub/server/assemble/assemble.test.ts`, this page.

Verification: `npx tsc --noEmit`; the new tests fail on the unchanged trunk and pass here; `affected-tests.py --run` (1,168 tests,
0 failed, 0 skipped).
