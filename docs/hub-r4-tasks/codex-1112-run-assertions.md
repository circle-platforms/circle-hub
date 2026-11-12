# Run reply assertions

Scope: statically align existing reader-facing text assertions with the November 12 wording change. Keep every scenario and structured-data assertion.

Allowed paths: `hub/runs/engine/{device-help,production-notes,read-coverage,leases-wiring,contributions,predecessor-default}.test.ts`, `packs/workflow/{maintenance-sweep,regression-scope}/production.test.ts`, `tests/acceptance/{31-predecessor-default,42-r5-t4-4-reproduce}.test.ts`, and this page.

No tests or type checks run in this worktree. The integrator runs the final single `npm test`. Missing conclusions, source coverage and contribution explanations are reported to the reply owner rather than removed from the tests.
