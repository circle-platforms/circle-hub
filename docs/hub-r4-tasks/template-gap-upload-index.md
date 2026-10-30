# template-gap 1.2.21: refuse a case index for uploads with the way out, not an empty only

In the real template-gap run of 2026-10-30 (T1-3, documents given as an upload) the model bound a case index. The pack refused
it, and its fix said to bind `knowledge:index:…&only=&fields=…`: `indexBindingFix` writes the run's agile document numbers into
`only=`, and an upload has none, so the fix was an empty `only`, which is no view id. The model followed it several times.

Change (template-gap 1.2.20 → 1.2.21): when the run has no agile document, `indexBindingFix` says that the documents are all
uploads, that the case index is narrowed by agile document numbers and cannot match an upload, and that command coverage needs
the documents bound as `agile:mindmap:<number>`, otherwise case_index is dropped; it never writes an empty `only`. Runs with
agile documents get the same fix as before. Version references in the pack tests follow the bump; the manifest is re-signed.

Test: `functions/index.test.ts` (a case index bound for uploads only is refused with the way out and no empty only).

Allowed paths: `packs/workflow/template-gap/**`, `docs/hub-r4-progress.md` (the deferred list), this page.

Verification: `npx tsc --noEmit`; `node packs/workflow/template-gap/api.ts check`; the pack's tests through
`node tools/run-unit-tests.ts files …`; the full check before the next deployment. Publishing 1.2.21 needs the owner's go.
