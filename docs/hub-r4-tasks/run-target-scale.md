# Bound repeated build and seedling reads during run targeting

An unqualified run target may enumerate thousands of known builds across a much smaller set of version lines. The target
resolver currently repeats seedling lookups for every build and the start path reloads the same complete build list after
selection. This can exhaust the request's document deadline before source verification. Keep the declared product,
version, build selection, alias spelling and locked root semantics; do not infer a target from names or content.

Reuse one build-list snapshot within a run start when target selection already obtained it, including the optional build
context, and memoize exact line-to-seedling reads within the same target selection. Explicit-build paths that did not need
the list may still obtain it once. Add synthetic coverage for thousands of builds over multiple lines, selection and alias
parity, incomplete seedlings and query counts. Do not change historical records, timeout limits or existing assertions.

Allowed paths: this task page, `hub/runs/engine/target.ts`, `hub/runs/engine/start.ts`, the engine README, and synthetic tests under
`hub/runs/engine/`. Run the affected-test tool against the merge base, then merge through the locked workflow. Production
timing and the cause of a particular timeout remain unproven until verified after a separately authorized service switch.
