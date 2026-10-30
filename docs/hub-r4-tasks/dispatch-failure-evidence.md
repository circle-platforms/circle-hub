# The runner reads the evidence of every case that did not pass, and case-compile says how to rework

Found by the first real whole-mindmap run that the Hub dispatched itself: three of five cases passed on the bed and two
failed, both for reasons of the plans that only the devices' answers showed (a TCP virtual service bound to an HTTP group;
three traffic expectations each placed one step before its trigger). The model asked the user whether to read the failure
sessions and rework, but it could not read them: the gateway returns the log and the per-device sessions of every case
that did not pass, the Hub keeps that answer as the raw response, and the raw response is readable by functions only. The
dispatch result rows carried the verdict and the report check, nothing to attribute a failure with. CES hands the model
each non-pass case's failed checks, its log and its session dumps, and its skill says what follows a run with failures:
attribute, rework only the failed cases with every passed case locked, rerun until fail 0 or the user accepts the rest.

Change:

- `hub/dispatch/service.ts`: for every row whose reported terminal is not pass, the log and each session at the result's
  declared pointers (`result.log`, `result.sessions`) are saved as separate projected sources readable by the runner and
  the administrators, generated from the raw response; the row names them in `evidence` (`log`, `sessions.<name>`). The raw
  response keeps its tier. Each piece is scanned on its own, so a held session leaves the others and the verdicts readable.
- `hub/dispatch/accepted.ts`: the job progress says that the rows that did not pass list their evidence.
- `packs/workflow/case-compile` 3.9.5: `SKILL.md` step 9 (read the evidence, attribute, never copy device output into an
  expectation, change only failed cases and keep passed plans as they ran, book the whole bed and rerun the whole mindmap
  until every case passes or the user decides on the rest); step 3 says `after` points at the step whose output the
  expectation reads; duplicated sentences shortened to stay within the length limit. Version files, regenerated samples,
  manifest by `pack-files.ts`.

Test: `hub/dispatch/results.test.ts` (a failing row names readable log and session sources for its runner, none for
another user, and an empty session names no source; a passing row names none); the case-compile pack tests.

Allowed paths: `hub/dispatch/service.ts`, `hub/dispatch/accepted.ts`, `hub/dispatch/results.test.ts`,
`hub/dispatch/README.md`, `packs/workflow/case-compile/**`, this page.

Verification: `npx tsc --noEmit`; the dispatch tests; the case-compile tests; the full check before deploying.
