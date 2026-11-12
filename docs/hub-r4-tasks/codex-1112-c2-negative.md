# Clarify authored negative expectations

Scope: explain how Circle writes an author's negative outcome as a block-form `not_found` check, with a query after deletion and no new criterion or criterion review. Preserve the existing scenario-fidelity check. The integrator updates the package version and generated manifests after merging.

Allowed paths:

- `docs/hub-r4-tasks/codex-1112-c2-negative.md`
- `packs/workflow/case-compile/SKILL.md`
- `packs/workflow/case-compile/tools/delivery.md`
- `packs/workflow/case-compile/functions/authoring-brief.ts`
- `packs/workflow/case-compile/functions/block-expected.ts`
- `packs/workflow/case-compile/functions/blocks.test.ts`
- `packs/workflow/case-compile/pack.test.ts`
- `packs/workflow/case-compile/README.md`

No model, code registry, production configuration or generated manifest changes. Development uses synthetic data only.

The existing block check requires criterion review for every assertion without an authored literal declaration. Align that branch with the owner's negative-result rule by the explicit `not_found` operator; do not classify prose. Keep source quotations, expectation coverage, authored literal declarations and scenario fidelity unchanged.
