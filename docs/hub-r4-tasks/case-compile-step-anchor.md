# case-compile 3.8.10: an unlabeled expectation under several actions binds to the step (decision 103)

The real compile of 2026-10-30 (case "在已关联vslist的addrlist中添加ipv4" of the mindmap "slb virtual httplist等list命令支持no和clear")
stopped at "期望 a5 缺作者动作定位": the expectation "无法添加，访问失败" is the child of a step node holding three numbered
actions, and compile-structure bound an expectation only by `step_ref`, a bracket label, a number, or a single preceding
action. The owner decided to align fully with InfoTest's handling and pointed to the CES skill design (decision 103). CES
(compile-excel-skills, mindmap-recompose R24 and R51) keeps an unnumbered expectation as one atomic item, never splits it
on commas, binds it to its step, and leaves the assertions to the authoring stage.

Change (case-compile 3.8.9 → 3.8.10):

- `functions/compile-structure.ts`: an expectation with no `step_ref` field, no bracket label and no number, preceded by
  several actions, binds to those actions as one step instead of being reported unbound. An explicit `step_ref`, label or
  number that matches no action, or several, still leaves it unbound; one preceding action binds as before. The authoring
  model places its assertions, a judgment; the Hub still checks every quote against the expectation's original bytes.
- Test: `functions/compile-structure.test.ts` (the unlabeled multi-action case moves from "stays unbound" to its own test of
  the binding, with the unbound label, number and malformed `step_ref` cases).
- The recompose stage folders carry generated copies of the structure module (`testing/gen-recompose.ts`), so recompose,
  recompose-adjudication and recompose-authority go 1.0.0 → 1.0.1; the evidence check pins its sibling packs by version
  (`functions/recompose-evidence.ts`, the test helper `testing/recompose.ts` and two recompose samples follow to 1.0.1).
- Generator identity and the typed samples follow the pack version as in case-compile-export-prefix.

Allowed paths: `packs/workflow/case-compile/**`, `docs/hub-r4-progress.md` (decision 103), this page.

Verification: `npx tsc --noEmit`; all case-compile tests through `node tools/run-unit-tests.ts files …` (509 passed);
`affected-tests.py --run`.
