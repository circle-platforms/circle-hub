# case-compile 3.9.6: commands the skills home admits, each case's own identity and registers, the size cap at the start

Found by the review of case-compile 3.9.5 (the first release that compiles a whole mindmap into one workbook) and by the
audit of the colleague Circle home that `scripts/real/circle-home.ts --profile skills` builds. The 5/5 run on the bed passed
only in an acceptance home with its own allow hook; the colleague home's guard refuses SKILL steps 5 and 6. The review also
found four ways a whole-mindmap run could go wrong without anyone noticing or only at its end: a pasted case took another
case's identity, a case with a mis-shaped autoid was silently left out, two block-plan cases that reuse a register name could
not be verified, and more cases than one dispatch takes were refused only after plans, workbook and verification. The owner
approved fixing them.

Change (all in `packs/workflow/case-compile` 3.9.6 unless named):

- `SKILL.md`, `tools/fetch-run.ts`: every local command in the one form the skills home admits, as the Jev skill writes it
  (`packs/workflow/knowledge-contribution/tools/jev/SKILL.md`): `node <技能目录>/tools/<script>.ts` with the installed
  script's full path, file arguments relative to the work directory, the token as a quoted here-document whose only line is
  `%HUB_TOKEN%`, no `cd`, pipe or redirection. The client tree is installed as the Circle skill `skills/case-compile/`;
  "技能目录" is the Base directory Circle shows when the skill loads. Steps 1 (normalize), 5 (fetch-run) and 6
  (generate-workbook, `--run <目录>/run.json` and so on, no "run it in that directory") are rewritten; the fetch-run usage
  header and its missing-token hint name the here-document. `scripts/real/circle-home.test.ts` fills in the SKILL's
  commands, installs the skill in a temporary skills home and expects the generated guard to allow them (and to deny the
  3.9.5 spelling).
- `SKILL.md` step 8, with the integrator's Hub change of the same release (`hub/dispatch`, `hub/runs/engine`, not on this
  branch): progress and the result reference are read by repeating, byte for byte, the submission the dispatch was made from
  (all plans). Another submission while a job of the run is in flight is stored as received but not validated; the Hub
  answers `IDEMPOTENCY_MISMATCH` with the jobs' progress and the dispatch continues; a change waits for the job to end and
  goes to a new verification run. This follows CES's device run (`skills/compile-excel/SKILL.md`, on-device step 3): poll
  the printed task and do not resubmit, which would run the whole workbook again. The progress notes no longer carry
  administrator commands (Hub side).
- `functions/project.ts`: the earlier extraction of a case is found by selector alone; a model without selectors falls back to
  a node id that names exactly one case. An item id stays `<document>:<node id>` when the node id names one node of the
  document and takes the node's selector when the id repeats (a pasted case keeps the id of its source; the kityminder@1
  parser then addresses both by position). Unique ids and the samples are unchanged. CES takes the node that carries the
  autoid as the case (`skills/mindmap-recompose/SKILL.md` R42) and never another node's fields.
- `functions/project.ts`: a whole-document run refuses with `autoid_invalid` when a case that the rule takes and the author
  did not exclude carries an autoid of another shape than the profile's `autoid_pattern`, naming up to ten cases by selector
  and quoted autoid, with the fix (correct or remove the autoid and upload the document again, or name one autoid). Cases
  without an autoid stay out and the selection summary counts them. This follows CES's batch check: an autoid outside the
  declared shape fails the batch (`skills/compile-excel/SKILL.md` rule 3, `references/gotchas.md` `autoid_malformed`),
  because the framework would not take it for a case boundary and the verdicts would land on the wrong case; and CES takes
  only nodes that carry an autoid. The Hub differs in the shape it checks: the published profile's pattern (18 digits in
  the synthetic and real profiles) instead of CES's 12 to 24 digits.
- `functions/workbook.ts`: the independent reader keeps block-plan registers within one case, as InfoTest's runner does
  (runtime mirror `lib/test_xlsx.py`): its static preflight `_preflight_excel_rows` (lines 772-784) resets the registers at
  every row that starts a case (an autoid in A, C not the init type 1) to those its init rows captured, and the run clears
  them before each case's init (`_reset_case_state`, line 836; lines 1059-1061, "寄存器和当前结果仅在单个 case 内有效；先清再执行本案
  init"). This generator writes no init rows, so every case starts without registers. The Hub keeps its stricter rule inside a
  case: a name is captured once, where InfoTest lets a later step overwrite it.
- `functions/project.ts`, `functions/dispatch-policy.ts`, `functions/generate.ts`, `tables/codes.json`: more selectable cases
  than `policies/dispatch.json` `max_items` (64) refuse the start with the new refusal `too_many_cases` and a split the
  workflow offers (several uploaded documents, or one autoid per run). The `dispatch_policy` refusal states the cap instead
  of asking for the policy table to be fixed; the model-budget (`workbook_input`) and row-limit messages name the same split
  instead of a batch mode the workflow does not have. CES has no case cap per batch; the Hub's comes from one dispatch per
  run (decision 105), and refusing at the start follows CES's rule of not going past a failed check.
- `tools/fetch-run.ts`: a secret Circle does not store arrives as its literal placeholder (`^%[A-Z][A-Z0-9_]*%$`); it is
  answered with `/secrets HUB_TOKEN` and never sent, as the Jev skill handles it in the same home
  (`docs/hub-r4-tasks/jev-skill.md`). The export must be of `--run` (run, result and submission). Every original is fetched
  and checked before anything is written, an input already in the directory refuses before any write, and a failed write
  removes what the call wrote: a failure leaves no partial inputs.
- `README.md` describes the whole-mindmap behaviour where it still described one case, and has a 3.9.6 section; `workflow.json`
  says when a whole-document run is refused. Version files, regenerated samples (`testing/samples.ts`) and the manifest by
  `pack-files.ts --write`. `SKILL.md` stays within its 8000-character limit by shortening sentences that said the same rule
  twice.

Test: `functions/whole-mindmap.test.ts` (a pasted node id gives two items with their own autoids, titles and selectors, and
with the first copy not automatable the second keeps its own autoid; unique ids keep `<document>:<node id>`; mis-shaped
autoids refuse with the cases named, at most ten; a case without an autoid is counted; two block-plan cases that both capture
`baseline` verify, and a register does not carry over to the next case; 65 cases refuse at the start and 64 start; the
dispatch-policy statement states the cap), `tools/fetch-run.test.ts` (placeholder never sent, an export of another run,
no partial files, an existing input left as it was), `scripts/real/circle-home.test.ts` (the SKILL's commands pass the skills
guard).

Allowed paths: `packs/workflow/case-compile/**`, `scripts/real/circle-home.test.ts` (the hook cross-check only), this page.

Verification: `npx tsc --noEmit -p .`; `node --test "packs/workflow/case-compile/**/*.test.ts"`;
`node --test scripts/real/circle-home.test.ts`; the full check before deploying.
