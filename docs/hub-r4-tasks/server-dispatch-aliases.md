# The Hub's own dispatch accepts the knowledge base's aliases of the locked build

Found by the first real whole-mindmap run (production abfd80e8ac64): with the whole bed booked, the Hub's own dispatch
(decision 105) refused before submitting because both load balancers echoed the other name family's (dotted) name of the
locked build while the probe expected only the locked name. That is the same build: the knowledge base records the dotted
name as based on it,
and the device probe accepts every alias of the locked build's base when it has the knowledge port. The administrator
command `job dispatch` sets that port (`hub/server/cli-job.ts`), which is why cases 1–3 passed on the same bed and build on
10-30; the server assembly never passed it to its `DispatchService`, so every dispatch the Hub starts itself compared the
literal name only.

Change: `hub/server/assemble/hub.ts` passes `knowledge` to the `DispatchService` it builds.

Test: scenario 28's whole-mindmap test lets the synthetic devices echo the site's alias of the locked build (`ALIAS`, based on
`RELEASED`), as the real devices do; it fails without the change (the dispatch ends not dispatched) and passes with it.

Allowed paths: `hub/server/assemble/hub.ts`, `tests/acceptance/28-device-run.test.ts`, this page.

Verification: `npx tsc --noEmit`; scenario 28 with and without the change; the full check before deploying.
