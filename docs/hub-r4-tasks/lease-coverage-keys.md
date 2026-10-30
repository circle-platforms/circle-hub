# Name the keys a dispatch's lineage does not hold

Found by the first real whole-mindmap run (production 0c1b6c2d54e9): told "缺少覆盖派发窗口的同血缘资源租约", the model
booked the devices its plans use (seven of eleven) instead of the whole bed, was refused again with the same sentence and
then searched the pack's sources for what "covering the dispatch window" means. The Hub knew exactly which keys were not
held: `holders` checked each resource and threw one generic sentence, and the caller replaced it with another. CES reports a
failed bed check as it is (section 9 of its skill).

Change: `hub/dispatch/service.ts` `holders` computes the keys the lineage does not hold for the whole window (released,
another user, outside the lineage, expiring too early, or absent) and throws `LeaseCoverageError` with them; the first check
before a dispatch names them in the `LEASE_UNAVAILABLE` refusal ("缺少覆盖派发窗口的同血缘资源租约：<keys>；执行器的目标是这些键
所在的整台…"). The two rechecks during a run are unchanged. Device keys are the bed's lease keys the runner already sees.

Tests: `hub/dispatch/accepted.test.ts` (the lineage refusal names every resource key); scenario 28 (a booking of part of the
bed names every device key it did not book).

Allowed paths: `hub/dispatch/service.ts`, `hub/dispatch/accepted.test.ts`, `hub/dispatch/README.md`,
`tests/acceptance/28-device-run.test.ts`, this page.

Verification: `npx tsc --noEmit`; `hub/dispatch/accepted.test.ts`; scenario 28; the full check before deploying.
