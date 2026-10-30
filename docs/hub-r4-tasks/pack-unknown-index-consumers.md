# defect-to-case discloses the unknown entries of its case index

The core change view-unknown-entries lets a `knowledge:facets` or `knowledge:index` input declare
`unknown_entries: 'disclose'`; the Hub then binds a last page that is truncated only because some entries' facts are unknown
(`unknown_only`, with the count in `unknown_entries`). Without the declaration such a view is refused, so defect-to-case could not
start on a build whose fed cases have steps that are not complete commands.

Change (defect-to-case 1.6.22 to 1.6.23): `indexed_cases` declares `unknown_entries: "disclose"`. The pack reads the two fields,
never the notes: `unknown_entries` must be a positive integer on a truncated view and `unknown_only` true with a count; a malformed
or contradictory field proves no completeness. `unknown_only` means nothing else was cut, so it is taken only when the listed keys
and entries equal `total_keys` and `total_entries` and no key is cut; otherwise the view keeps the earlier truncation handling. A
visible duplicate is still refuted. A draft with no visible duplicate stays unknown (`integrity_unproven`) and its statement names
the count, the requested keys without listed cases, the view's notes verbatim and the next action: supply the missing facts as the
notes say and start a new run, because a re-read of the same frozen revision cannot supply them. start_run returns the gap
`defect-to-case.index_unknown_entries` with the count. A view without unknown entries gives byte-identical projection output and
outcomes; a truncated view without `unknown_only` is still refused by the Hub and, where it reaches the check, handled as before.

The brief assumed an `index_default` merge of only= slices for this pack; it has none. start_run binds the index without only=,
and the check reads one only= slice at the bound revision through `duplicate_check.reads.narrow`; the end-to-end test covers that
path. Needs from hub/runs/engine (narrow-reads.ts), recorded in the pack README: the narrowed read still reports an unknown-only
view as `budget_exhausted` with "raise the view or max_entries limits" and absent keys as "build these keys", and a `max_entries`
cut keeps the source view's `unknown_only: true`.

Template-gap is parked for a later batch (integrator's scope cut); its version stays 1.2.19 and nothing of it is committed here. A
finding for that batch: on the real knowledge views a `key=document` index lists the cases with unparsed steps under their document
without `commands` and `command_identities`, and template-gap's `readCaseIndex` refuses such entries as `index_invalid`, so the
slot opt-in alone would turn those unknown entries into a refusal. The reader has to admit them as unknown entries. An uncommitted
draft of that work stays in this task's worktree.

Allowed paths: `packs/workflow/defect-to-case/workflow.json`, `functions/compact-index.ts`, `functions/checks.ts`,
`functions/expected.ts`, `functions/unknown-entries.test.ts`, `unknown-entries.test.ts`, `testing/fixtures.ts`, `testing/hub.ts`,
`testing/samples.ts`, `samples/negative/duplicate_unknown_entries.json`, `SKILL.md`, `README.md`, `pack-files.ts`, `pack.json`,
`publish.test.ts` (all under `packs/workflow/defect-to-case/`), this page.

Verification: `npx tsc --noEmit`, `node --test "packs/workflow/defect-to-case/**/*.test.ts"`,
`node packs/workflow/defect-to-case/pack-files.ts --write` then `--check`, `node --test .github/checks/pack-version.test.ts`.
