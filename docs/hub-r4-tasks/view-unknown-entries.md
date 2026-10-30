# Bind a count view that is truncated only by unknown entries, when the pack says so

On the real knowledge base every fed case with a step the projection cannot turn into a complete command, and every fed case
read before a structural fact existed, is left out of the command-dependent facet and index views and marks the view
truncated. `completeKnowledgeView` refuses every truncated last page, so the five workflows that bind these views
(regression-scope, maintenance-sweep, defect-to-case, template-gap, quality-board) could not start on real data even though
each of them already knows how to say a partial count. The truncation mixed two different things.

Change: a facet or index view that has unknown entries says so — `unknown_entries` (entries left out because a fact the query
needs is unknown or their sources disagree; one count per distinct entry) and `unknown_only` (that is the only reason the view is
truncated: nothing else was cut or withheld). Views without unknown entries are byte for byte what they were (a first version
that also marked cut views changed the pinned bytes of the cold 49,000-entry index in `view-perf.test.ts`). `truncated` keeps
its meaning, so every existing consumer still fails closed. An input slot of a workflow can declare `unknown_entries: 'disclose'`
(only on `knowledge:facets` or `knowledge:index`); `completeKnowledgeView` then binds a last page that says `unknown_only`, still
marked truncated and carrying the count. Other truncation, impact and links views, and slots without the declaration are refused
as before. No pack opts in by this change; the packs follow in their own tasks, each with the disclosure in its functions.

Allowed paths: `contracts/src/views.ts`, `contracts/src/pack.ts`, `contracts/src/pack.test.ts`, the regenerated
`contracts/generated/schemas/{facet-view,index-view,workflow}.v1.schema.json`, `hub/knowledge/views.ts`,
`hub/knowledge/complete-view.ts`, `hub/knowledge/complete-view-unknown.test.ts`,
`hub/knowledge/feeding-unparsed-index.test.ts`, `hub/knowledge/README.md`, `hub/runs/engine/inputs.ts`,
`hub/runs/engine/index-default.ts`, this page.

Verification: `npx tsc --noEmit`, `npm run verify:contracts`, the new and extended tests above, and
`affected-tests.py --run` against hub-redesign; the whole suite runs once before the next deployment.
