# regression-scope 1.8.9 and maintenance-sweep 1.8.9 disclose unknown entries of the facet view

Both packs bind a required `facets` hint (`kind=case&by=commands`) for the count of cases without a command placement, and
every truncated facet view refused startup. On the real knowledge base a view is truncated whenever some cases' command
attribution is unknown, so neither workflow could start. The core change "view-unknown-entries" lets a slot opt in to such a
view; these packs now do, on the `facets` slot only (`"unknown_entries": "disclose"`). The impact and behaviour slots are
untouched.

Change: `readFacets` accepts `unknown_entries` and `unknown_only` as `contracts/src/views.ts` defines them and returns the
unknown count; any other truncated view is refused as before. The unknown cases are said as unknown (never zero, never
unplaced, never a failure) in the run note (`unknown_entries`, `facet_notes`), its message, a pack-local warning
`<pack>.unknown_entries` and, while the diff has a path they could sit on, an unknown check outcome with the next step quoted
from the view's notes; no claim then calls the scope or sweep empty or whole (regression-scope: `uncovered_changes` and the
empty `in_scope`; maintenance-sweep: `command_exists`, like skipped documents, and the empty `command_unchanged`). Without
unknown entries every output is byte for byte that of 1.8.8. The packs' READMEs record the details and the judgment calls.

Allowed paths: `packs/workflow/regression-scope/**` and `packs/workflow/maintenance-sweep/**` (functions, tests,
`test-support.ts`, `workflow.json`, `tables/codes.json`, `SKILL.md`, `README.md`, `samples/`, `examples/`, `pack-files.ts`,
the regenerated `pack.json`), this page.

Verification: `npx tsc --noEmit`, `node --test "packs/workflow/regression-scope/**/*.test.ts"
"packs/workflow/maintenance-sweep/**/*.test.ts"`, `pack-files.ts --write` then `--check` for each pack, and
`node --test .github/checks/pack-version.test.ts`.
