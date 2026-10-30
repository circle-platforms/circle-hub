# A build's fixed-bug list reaches the defect index by feeding on use

Owner decision of 2026-10-30 (the integrator records it as decision 94): traceability (T2-4) is fixed by feeding on use, as the
owner's rule of 2026-10-24 keeps a version line's seedling to the manual and the command tree. On production every build's
`knowledge:index:<product>:<build>?kind=defect&key=bug` is empty, so traceability's start_run refuses ("该构建的缺陷索引没有编号")
and a client that reads the fixed-bug page through `source-read` gets no feeding, because that read has no product.

What changes, and why:

- The APV product pack projects a fixed-bug page that is read with the product known: an html@1 build-site file whose whole
  file name is the fixed-bug form of the declared asset grammar gives one `fed-build@1` row per defect identity of its tracker
  anchors (read as `fixed-bugs.ts` reads them; the release status stays undeclared), bound to the build of the file name.
  `fed-build@1.fixed_bugs` is the model's field for a build's fixed-bug list (`docs/hub-r4-tasks/kb-feeding.md` §1.4); the
  model keeps `fed-defect@1` for PLM records.
- The asset grammar reads the prefixed real forms as whole names: an optional `<prefix>_` before the build in the fixed-bug
  form and `<prefix>-` in the command-tree form; nothing by substring.
- The Hub's index view lists, for `kind=defect` on a seedling root, every valid function-projected `fed-build@1` record of that
  exact build and root as a defect entry next to the root's entries, under the rules it applies to fed cases (frozen cut,
  root-less or other-root records counted as unknown entries, credential holds). The core reads only the model's fields.
- A workflow bound to no product line accepts `product` together with an exact `build` (never one of them alone) and then locks
  that build's root, so the generic read pack can feed what it reads into that product's layer.
- The refusal for an empty defect index, the feeding note for a read without product, the empty defect-view note and the
  traceability SKILL.md name that one step.

Allowed paths: this page; `hub/knowledge/feeding.ts`, `hub/knowledge/feeding-types.ts`, `hub/knowledge/views.ts`,
`hub/knowledge/README.md` and new tests under `hub/knowledge/`; `hub/runs/engine/target.ts`,
`hub/runs/engine/index-default.ts`, `hub/runs/engine/index-default.test.ts` and a new target test under `hub/runs/engine/`;
`packs/product/apv/functions/listing.ts`, `packs/product/apv/functions/feeding.ts`, `packs/product/apv/pack.json`,
`packs/product/apv/README.md` and new tests under `packs/product/apv/functions/`; `packs/workflow/traceability/SKILL.md`,
`pack.json`, `pack-files.ts`, `README.md` and the version strings in its tests. No change to `contracts/model.json` or
`contracts/src`. Versions: apv 1.7.37, traceability 1.0.12 (1.0.11 is taken by the public snapshot).

Verification: `npx tsc --noEmit`; `node --test` over the test files of every touched package (apv, traceability,
`hub/knowledge`, `hub/runs/engine`), `packs/workflow/case-review/packs.test.ts` and `.github/checks/pack-version.test.ts`; one
synthetic end-to-end test: a product-bound read of a synthetic fixed-bug page, the fed records, the `kind=defect` index listing
them, and traceability's start_run accepting and computing the matrix (hits and unknowns). Synthetic fixtures only (`DemoOS`
prefix, tracker under `.invalid`, invented ids).
