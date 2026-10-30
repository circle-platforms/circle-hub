# template-gap discloses the unknown entries of its case index

The second batch after the owner's scope cut (decisions 88–92) includes template-gap. Its `case_index` slot binds a
`key=document` index of the locked build. On the real knowledge views that index lists a case whose steps are not complete
commands under its document without `commands` and `command_identities`, counts it in `unknown_entries` and marks the view
`unknown_only` when nothing else is cut. Before this change the Hub refused such a view for the slot (no opt-in), and even with
the opt-in `readCaseIndex` refused the entries as `index_invalid`, so the command coverage of a real document could not be
checked at all.

Change (template-gap 1.2.19 to 1.2.20): the `case_index` slot declares `unknown_entries: "disclose"`. `readCaseIndex` reads the
two fields, never the notes, with the rules defect-to-case 1.6.23 uses: `unknown_entries` a positive integer on a truncated view,
`unknown_only` true and only with a count, and taken only when the listed keys and entries equal the totals and no key is cut. An
entry without `commands` and `command_identities` is admitted only on a view that declares unknown entries, and never more of them
than the count; it stays without a command set (never an empty list). Such a case adds no command to the universe, so categories
the read cases do not show for a command are potential gaps (unknown), never `command_shortfall`, and the document gets an unknown
with the count, the view notes verbatim and the next action (complete the commands, re-read the index, rerun; a re-read of the same
frozen view cannot supply them). The projection warns `template-gap.index_unknown_entries`. A view without unknown entries gives
the outcomes of 1.2.19.

New synthetic examples: `examples/command_unknown_entries.json` (truncated only by unknown entries, every case with commands) and
`examples/command_unknown_commands.json` (two cases listed without commands, the real shape); both run through the real registry
and engine in `engine.test.ts`.

Allowed paths: `packs/workflow/template-gap/**` (functions, tests, `testing/`, `workflow.json`, `tables/codes.json`, `README.md`,
`examples/`, the re-signed `pack.json`), this page.

Verification: `npx tsc --noEmit`, `node --test "packs/workflow/template-gap/**/*.test.ts"`,
`node packs/workflow/template-gap/api.ts check`, `node --test packs/workflow/case-review/packs.test.ts` (the repository vocabulary
scan) and `node --test .github/checks/pack-version.test.ts`.
