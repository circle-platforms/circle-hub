# packs/workflow/maintenance-sweep

Capability 4b of the architecture brief (section 6a): a fact-only workflow pack bound to no product line. Given an impact
view of two builds, it lists the cases of the earlier build that need maintenance. A removed command is a blocking
violation. A changed definition is an advisory violation, field by field, with both values. `start_run` stores the
validation result; `submit_result` only adds model commentary.

The product name in the tests (`widget`) and the build names (`Rel_W_1_0_1`, `Rel_W_1_0_2`) are synthetic.

## Files

| Path | Content |
| --- | --- |
| `workflow.json` | input `impact` (`knowledge:impact`, one, required); parameter `ignore_fields`; `product: { catalogs: [] }` |
| `requirements.json` | `command_exists` and `command_unchanged`; both fact, item, static, bookkeeping |
| `checks.json` | `command_exists` is blocking and names its basis; `command_unchanged` is advisory. Both are `functions/check.ts` |
| `functions/sweep.ts` | which cases are items |
| `functions/diff.ts` | structural diff of definition JSON |
| `tables/codes.json` | the two violation codes, the refusals and the warnings |
| `samples/` | one positive and one negative sample of each check (author samples) |
| `examples/sweep.json` | a synthetic illustration. No verified run exists yet (T01 F[11]); the task page asks for examples, so this file says it is synthetic |

`pack.json` is the manifest (`pack-files.ts --write`). `pack-files.ts`, `functions/test-support.ts`, `test-hub.ts`, the tests and this README are not pack files.

## The answer

Each item is one case of the earlier build, id `<document>:<node>`, sorted by id. A case on several maintenance paths is
one item. Reasons are sorted by path and carry `code`, `path`, `change` and, for a definition change, `fields`.

A case is an item when the earlier build places it on a removed path, or on a modified path whose definition data
differ. An added path is not an item. A change only in entries of kind `behaviour` is not an item. A case that exists
only in the later build is not an item.

`maintenance-sweep.case.command_removed` is blocking. The statement and `data.fix` say：按替代命令改写这条用例，或者停用它.
`maintenance-sweep.case.command_changed` is advisory. `data.fields` lists each difference as `command` (the tree path),
`path` (a JSON Pointer), `before` and `after`. A key that is absent on one side is distinct from JSON null: `absent` is
`before` or `after`, and the missing side's value is null.

`ignore_fields` drops those names at the top level of each definition before the diff. A nested key of the same name is
still compared. Several definitions on one side are sorted by canonical JSON. Equal multisets are not a change; otherwise
they are compared as an array (`/0/...`). One definition on each side is compared as a value (`/help`, `/args/0/type`).

The run note always says that nothing is claimed about cases the index does not hold. When `skipped.from` is above zero
it also says the earlier build's index lacks that many listed documents, so a clean result is not proof that no case is
stale. The same sentence is an unknown cross-item claim (`missing_input`) from `command_exists` whenever the projection
note is present. A truncated view adds `integrity_unproven`.

## Decisions

1. The pack names no product and no catalog, so a run must not pass `product`, `version` or `build`.
2. Violation codes carry the pack name (`maintenance-sweep.case.command_removed`, `maintenance-sweep.case.command_changed`). The engine rejects a pack-function code outside that namespace. The short names in the task page are the part after the pack id.
3. Case data is read as `document`, `node`, `title`, `priority` and `negative`, the same assumption as regression-scope. The cases index is owned by another pack.
4. A pair with no maintenance item is an empty projection plus a warning that says so. The run engine refuses a projection with no items (W01 R[3]). This pack does not invent an item to get past that refusal.
5. The positive samples are a case whose reasons are neither a removal nor a definition diff. A well-formed projection does not emit such an item; the samples exist so each check has a support (C05 R[0]).

## How to test

```
node --test --test-concurrency=2 "packs/workflow/maintenance-sweep/**/*.test.ts"
npx tsc --noEmit
node packs/workflow/maintenance-sweep/pack-files.ts --check
```

The function tests build impact views by hand: a removed path with two cases, a modified signature, modified help text,
a behaviour-only change, both reasons on one case, `ignore_fields`, a clean pair, 5,000 cases, and order independence.
`publish.test.ts` and `production.test.ts` use a temporary PostgreSQL and are skipped where `sandbox-exec` is absent.
A skip is not a pass. `production.test.ts` has one `it.todo` for the real knowledge reader, which waits until the
product pack's cases index is committed.

## Limits

- At most 10,000 check outcomes in one call (the engine's cap). The 5,000-case test calls the function directly.
- `ignore_fields` holds at most 40 names, each at most 80 characters.
- Warnings kept on a run are the first 100. An empty projection's warnings are dropped by the engine with the refusal.
- A named definition entry that is missing from the view is not treated as “no difference”: the path stays a maintenance
  item and the warning names the digest.

## Needs from other packages

- **runs engine** (`hub/runs/engine/projection.ts`, W01 R[3]): a projection with zero items refuses `start_run` (“投影没有给出任何条目”). A clean pair cannot be stored. Request: accept an empty item list when the projection says why.
- **product pack** (cases producer): confirm the case entry fields. Until that producer is committed, the real-reader end-to-end test stays a todo.
- **knowledge pack**: this pack only parses `impact-view@1`.
