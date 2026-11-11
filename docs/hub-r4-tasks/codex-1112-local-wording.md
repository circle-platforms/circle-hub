# Local tool wording

Source: the owner's 2026-11-12 brief and merged wording rules.

Scope: user-facing text only; keep the model input protocol and machine-readable result fields.

Allowed paths:
- `packs/workflow/case-compile/tools/*.ts`
- `packs/workflow/case-compile/recompose/tools/*.ts`
- `packs/workflow/case-compile/functions/delivery.ts` and its existing tests
- `packs/workflow/case-compile/functions/channels.ts` and its existing tests
- `packs/workflow/case-compile/functions/workbook.ts` and its existing tests
- `packs/workflow/case-compile/functions/volume-order.test.ts`
- `packs/workflow/case-compile/pack.json`
- `packs/workflow/case-compile/recompose/pack.json`
- This task page

Run only `node --test packs/workflow/case-compile/tools/assemble-delivery.test.ts` after the dependent author-conflict and channel changes are available. The integrator runs the final full check.
