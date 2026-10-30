# Point the empty defect index refusal at the pack's own read step

In the real traceability run of 2026-10-30 (T2-4) the refusal for an empty defect index told the model to read the build's
fixed-bug list with the generic read pack and to bind "the external identifier of that original". The model guessed a
read slot of another system and looped for eleven minutes; it succeeded only after being pointed at the first step of the
traceability instructions, which names the slot and the external form.

Change: the fix text of that refusal (`narrowIndexId`, hub/runs/engine/index-default.ts) now says that the input slot and
the external identifier are written as the pack's instructions write them in the step that reads the fixed-bug list, and
not replaced by another read slot. The rest of the text, the code and the product and build it names are unchanged; the
unit test asserts the new sentence.

Allowed paths: `hub/runs/engine/index-default.ts`, `hub/runs/engine/index-default.test.ts`, `docs/hub-r4-progress.md`
(the deferred list), this page.

Verification: `npx tsc --noEmit`; `node --test hub/runs/engine/index-default.test.ts hub/knowledge/feeding-fixed-bugs-trace.test.ts`;
`affected-tests.py --run`; the full check before the next deployment.
