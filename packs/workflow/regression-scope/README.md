# packs/workflow/regression-scope

Capability 4a of the architecture brief (section 6a): a fact-only workflow pack bound to no product line. Given an impact
view of two builds, it lists the cases of the later build that sit on an added or modified path. A path with no case is
unknown, never a failure. `start_run` stores the validation result; `submit_result` only adds model commentary.

The product name in the view (`widget`) and the build names (`Rel_W_1_0_1`, `Rel_W_1_0_2`) in the tests are synthetic.

## Files

| Path | Content |
| --- | --- |
| `pack.json` | manifest of the pack files (`pack-files.ts --write`) |
| `workflow.json` | input `impact` (`knowledge:impact`, one, required; the id asks for the slim cataloged view: `?catalog=commands@1&attached_fields=document,node,title,priority,negative` — changes counted among the command catalog's members, compared by syntax); parameters `priorities`, `include_added`; `product: { catalogs: [] }` |
| `requirements.json` | `in_scope` (item) and `uncovered_changes` (run); both fact, static, bookkeeping |
| `checks.json` | both checks are `functions/check.ts`, apply `run`, subject `functions/subject.ts`, advisory |
| `slots.schema.json` | empty |
| `SKILL.md` | relay the result unchanged; page it with `get_nodes` on the `rec:` reference |
| `functions/scope.ts` | the scope rules |
| `functions/project.ts`, `functions/subject.ts`, `functions/check.ts` | projection, subject, outcomes |
| `functions/view.ts` | `impact-view@1` read locally, so the function stays inside the pack |
| `tables/codes.json` | refusals, warnings, and the two invariant refutations |
| `samples/positive/*`, `samples/negative/*` | one positive and one negative sample of each check (author samples) |
| `examples/scope.json` | a synthetic illustration. No verified run exists yet (T01 F[11]); the task page asks for examples, so this file says it is synthetic |
| `pack-files.ts`, `functions/test-support.ts`, `test-hub.ts`, `*.test.ts`, `README.md` | not pack files |

## The answer

Each item is one case, id `<document>:<node>`, sorted by id. A case on several added or modified paths is one item; its
`reasons` are sorted by path and carry only the index of the path in the run-level details table and the change
(`added` or `modified`) — since 1.3.0 the path string, the digests and the tree references live once per path in
`note.details` (a cross-line pair of 2,096 cases was 7.9 MB before this round; 1.2.0 had repeated them per item).
Each detail row carries the path, the change, `definition_change` — what happened to the command definition on the
path, read from the definition-kind entries of the two sides: none before and some after is `added` (a new command),
some before and none after is `removed`, both with different digests is `modified`, and equal definitions (only
behaviour texts changed) or no definition on either side is `none`. Its `conclusion` says it in one line (新增命令 /
删除命令 / 命令定义有变更 / 仅说明文字有变更), so a command the manual already described is never called "modified".
The summary is at most 200 characters: priority, document, how many commands changed, and the first reason's
conclusion. Removed paths are neither in scope nor uncovered. A case on an unchanged path is not an item.

`in_scope` supports each item. One ground per claim: the item's own location (the case entry fragment); the definition
references stay once per path in `note.details`. The case data (document, node, priority, negative) is written once in
`fields`; the title lives once in `label`. `uncovered_changes` is one unknown (`missing_input`) per considered path
that has no case in the later build, with no item, so it is a cross-item claim. The statement says this is not a
failure. When `skipped.to` is above zero, the statement and the run note say the later build's index lacks that many
listed documents. A truncated view adds an unknown of `integrity_unproven` and does not claim that the list is
complete. A bound view that names no catalog adds one conclusion line (`catalog-hint`): the changes were then counted
by entry kind alone, and another producer's entries on the same path may be mixed in.

The uncovered list is computed before the priority filter and stored on the projection note. Filtering a case out does
not make its path uncovered. `include_added: false` drops added paths from the scope and from the uncovered list. An
empty `priorities` array keeps nothing. Input order does not change the output.

## Decisions

1. The pack names no product and no catalog, so a run must not pass `product`, `version` or `build`.
2. Case data is read as `document`, `node`, `title` (else the statement, else `（无标题）`), `priority` (a finite number
   or absent) and `negative` (`true` only when the field is `true`). The cases index is owned by another pack and is not
   in this tree; this shape is an assumption (see Needs).
3. A well-formed view never refutes: a scope is not a defect, and a missing case is unknown. The publish check still
   requires a negative sample of every check (C05 R[0], T02). The only refutations are two projection invariants
   (`not_in_scope`, `not_uncovered`) that this pack's projection does not produce. They are declared as such.
4. An empty scope is an empty projection plus a warning that says so. An empty item set is a legal answer (W01 R[3]):
   the run engine accepts an empty projection, stores its validation result with empty partitions and coverage complete
   at 0 of 0, and notes in the answer that there are no items carrying the pack's explanation.

## How to test

```
node --test --test-concurrency=2 "packs/workflow/regression-scope/**/*.test.ts"
npx tsc --noEmit
node packs/workflow/regression-scope/pack-files.ts --check
```

The function tests build impact views by hand: every change kind, one case on two paths, a case on an unchanged path, a
changed path with no case, the priority filter, `include_added` false, an empty view, 5,000 cases, and order
independence. `publish.test.ts` publishes through the real registry. `production.test.ts` runs `start_run` against a
fake reader. Both use a temporary PostgreSQL and are skipped where `sandbox-exec` is absent. A skip is not a pass.
`production.test.ts` has one `it.todo` for the real knowledge reader, which waits until the product pack's cases index
is committed.

## Limits

- At most 10,000 check outcomes in one call (the engine's cap). A larger run becomes one `check_error`. The 5,000-case
  test calls the function directly.
- A run admits at most 4,000 in-scope cases and about 6 MiB of projection output (`regression-scope.too_large`, with the
  fix: narrow by `priorities`). The limit exists because a bigger scope died in the sandbox on memory (a cross-line pair
  with full entries took about 790 MB); the slim view (`attached_fields`) is what the id asks for, and with it the view
  itself fits the byte budget. Measured on synthetic corpora: 25,000 slim cases complete in the sandbox (256 MB); the same
  run with full entries also fits (the pack reads only the five fields) but its input is far bigger.
- `ignore` is not a parameter. `priorities` holds at most 64 numbers.
- `ignore_fields` belongs to maintenance-sweep, not to this pack.
- Tree references in the view are copied onto the claims. This pack does not resolve them against a knowledge root.
- Warnings kept on a run are the first 100. An empty projection's warnings are kept and carried in the answer's gaps and parse action.

## Needs from other packages

- **runs engine** (`hub/runs/engine/projection.ts`, W01 R[3]): done — empty item sets are accepted as legal answers, storing an empty validation result and carrying the projection's explanation.
- **runs engine** (C05 R[0], T02): every check needs a refuting sample. This pack's refutations are invariants, not defects of a scope. Request: allow a check whose only honest outcomes are support and unknown to publish without a refutation.
- **product pack** (`packs/product/apv` cases producer, not in this tree): confirm the case entry fields (`document`, `node`, `title`, `priority`, `negative`). Until that producer is committed, the real-reader end-to-end test stays a todo. Tests here use hand-built views.
- **knowledge pack**: the impact view is served by the Hub's reader. This pack only parses `impact-view@1`.
