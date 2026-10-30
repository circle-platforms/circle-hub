# The client fetches its run's generation inputs from the Hub (decision 104)

Generating a workbook needs the plan run's record, its accepted result and that result's submission, and the exact bytes of
the bound contract (about 1.15 MB), profile and inventory. A model cannot rebuild those bytes from paged text, so until now an
administrator exported them (`run show --json`, `original export`). Decision 104 removes administrator steps from the user's
flow.

Change:

- `hub/ports.ts` RunsService gains optional `exportRun(user, run)`; `hub/runs/engine/service.ts` implements it (runner or
  administrator; the latest accepted result and its stored submission, found by digest).
- `hub/server/run-export.ts`, routed in `hub/server/app.ts`: `GET /run-export/<run>` (canonical JSON `run-export@1`) and
  `GET /run-export/<run>/sources/<sha256>` (original bytes through `artifacts.sourceForRun`), Bearer token on every request,
  GET and HEAD only, 404 for anything not the caller's or not bound, 409 without an accepted submission, one call-log line.
  `hub/server/fakes.ts` FakeRuns implements `exportRun`.
- `packs/workflow/case-compile/tools/fetch-run.ts` (case-compile 3.9.0 → 3.9.1): token from standard input only, the six
  files written new and checked against the run's bound digests. SKILL.md steps 5, 6 and 8 use it and describe the Hub's own
  dispatch (decision 105). Generator identity and the typed samples follow the version.
- Tests: `hub/server/run-export.test.ts`, `packs/workflow/case-compile/tools/fetch-run.test.ts`.

Allowed paths: `hub/ports.ts`, `hub/runs/engine/service.ts`, `hub/server/run-export.ts`, `hub/server/run-export.test.ts`,
`hub/server/app.ts`, `hub/server/fakes.ts`, `hub/server/README.md`, `packs/workflow/case-compile/**`, this page.

Verification: `npx tsc --noEmit`; hub/server and case-compile tests; `affected-tests.py --run`; the full check before deploying.
