# Runs

Workflow publication and execution consume the model-owned contracts and expose their public ports through `api.ts`.

## Decisions and limits

### C56: author-declared workflow steps

The owner's 2026-11-15 07:00 decision approves optional `workflow.json.steps` entries `{id, name}` and explicit `requirements[].step` references. C60 implements this under provisional model 89; the contracts owner supplies the shapes and generated artifacts. Steps describe business work, not tool calls, dispatch phases or an execution graph. Publication validates references across the two files. Old packs without declarations remain valid.

The evaluator records an internal, current-invocation `checkedScope` at the requirement-processing boundaries. Unknown outcomes and missing-input requirements remain in that scope. The response includes `step_name` only for a complete, nonempty scope whose requirements all explicitly resolve to one declared step id. Different ids remain different even when their names match. Missing declarations, ambiguous references, incomplete scope and unscoped errors retain neutral presentation. Neither submitted slots, package names, error wording nor result rows establish an execution scope.

Names come from the run's digest-frozen workflow version, including its pack space. The internal scope is not persisted in a new schema or retroactively added to append-only results. A cached receipt without current producer evidence has no `step_name`, including a replay of a newly created run; an actual fresh evaluation may independently establish one. No historical result or latest publication is used to guess a missing scope.

Cursor owns rendering the optional name and the neutral sentences; agy owns the packs' explicit step declarations. Those deliveries remain outside this package receipt. Dispatch effects do not acquire a step association through this change.

Validation receipt: package-owned pure scope and static publication tests passed 8/8. The integrator separately reported actual PostgreSQL integration 4/4, full types with zero errors and generated-contract verification 220. These are synthetic/local checks, not client presentation, production availability or device evidence. Further source changes await independent review; no PostgreSQL slot is retained.
