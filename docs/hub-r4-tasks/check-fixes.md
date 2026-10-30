# Fix what the full check of 93610610 found

The full check of the large-diff change found two failures that the targeted runs had not covered.

- The template-gap engine test pins that a model submission whose quotations exceed the 256-reference read budget is rejected, not accepted with the unread part unknown. The budget relief of the large-diff change therefore applies to a production run only (no model submission); a submission keeps failing closed.
- The vocabulary scan flagged the handwritten pair of change kinds in `maintenance-sweep/functions/sweep.ts`. The check now takes the kinds from the generated vocabulary. The pack changed after 1.8.9 was published, so it moves to 1.8.10 with its manifest regenerated (version reuse rule).

Allowed paths: `hub/runs/engine/evaluate.ts`, `packs/workflow/maintenance-sweep/{functions/sweep.ts,pack-files.ts,pack.json,pack.test.ts,publish.test.ts,README.md}`, `docs/hub-r4-tasks/start-large-diff.md`, this page.

Verification: `npx tsc --noEmit`, the case-review vocabulary scan, the template-gap engine test, the maintenance-sweep and regression-scope tests, the pack-version check, then the full check.
