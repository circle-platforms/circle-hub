# A retraction reaches a contribution grounded in tree entries, by its record or by the run that stored it

Found on the production Hub and reproduced from the code. A Circle contribution (`knowledge-contribution@1`) may be
grounded directly in knowledge-tree entries, for example a `contradicts` relation whose `source` and `relation.other` are
`tree:` references; it then has no `feeding_record`. For such a contribution:

- `circle-hub knowledge retract --entry <its record digest>` was refused ("撤回目标不是已登记的喂入或回注条目"): the
  target check (`FeedingLayer.retractionTargets`) accepted a contribution only with a feeding record.
- `--run <the run that submitted it>` was accepted and recorded, and the command said "原记录未改动；读侧将显示根据已撤回",
  but nothing changed on the read side. The node view marked a contribution `grounds_withdrawn` only when its feeding
  record was invalid; a run retraction matches only feeding records whose claim names the run; the contribution record
  names no run, and the index `knowledge.contribution.run` was written for operation records only and read nowhere.

Test scenario T6-3 (`docs/hub-r5-tests.md`) expects that after the administrator retracts the contribution it is no
longer valid but not deleted (record and digest unchanged), the read side shows its basis withdrawn, the other end stays
valid, and retracting the same target again appends nothing.

Change:

- `hub/knowledge/feeding.ts`: `retractionTargets` and `retractionCover('entry', …)` accept every
  `knowledge-contribution@1` record. One without a feeding record is covered only by a retraction that lists it among
  its entries; feeding records and feeding-grounded contributions are checked as before. `retractedEntries()` returns
  the digests the entries of all retraction records name.
- `hub/knowledge/contributions.ts`: the node view (`#views`) and the single read (`readView`, which the `rec:` read of
  get_nodes in `hub/server/tools.ts` and the status comparison of a recovered answer use) show a contribution whose own
  digest a retraction lists as `grounds_withdrawn`, note "这条回注本身已被管理员撤回；历史引文仍保留", before the
  feeding-record check and after the credential hold. A page call reads the retraction records once, through its view
  cache. Every new contribution, not only an operation record, gets the `knowledge.contribution.run` index; it has no
  reader yet.
- `hub/server/cli-admin.ts`: `knowledge retract --run` reads each run through the runs service (`deps.runs.getRun`, as
  `run show` and `share run` do), takes `contributions.stored[].record` of every accepted result the run's detail names
  (`runContributionEntries`), adds them to the entries of the same command and prints one line per run, "运行 … 存下的
  回注条目 N 个一并列为撤回目标". Every accepted result is read, not only the latest the brief named: a later accepted
  submission's receipt lists only its own items, and an abandoned run's latest result is the management projection,
  which has no receipt. Results are read as stored, so older result shapes still give their receipts. Covered-target
  detection runs on the expanded entries: a run an older record retracted alone still gets one record for its uncovered
  entries, and an identical repeat appends nothing.
- `hub/knowledge/README.md`: the retraction section, the run index, and a need of the server package.
- `hub/server/README.md` (integrator, at review): the `knowledge retract` paragraph names the `--entry` targets and the
  `--run` expansion.

Not changed: `hub/server/tools.ts` (its `rec:` read takes status and note from `readView`); `ContributionLayer.read`
(readability only; a retracted record stays readable); `hub/knowledge/api.ts` (`knowledgeRetract` retracts the targets
it is given). Applicability judgments already skip every contribution view that is not `valid`.

Limits: a record shared by identical content across runs is retracted with any run whose receipt lists it. A run-only
retraction record still marks no contribution without a feeding record by itself; for a run retracted before this
change, the administrator runs the same `--run` command again, which appends one entry record. Replaying a saved
`get_nodes` answer for `rec:<contribution record>` (`hub/server/recover-read.ts`) does not recheck the contribution's
current status; that path is outside this task and is listed as a need in the knowledge README. The CLI glue around
`runContributionEntries` (argument loop and printed line) has no test of its own: the admin CLI assembles a full Hub.

Test:

- `hub/knowledge/contribution-retraction.test.ts` (new): a `contradicts` relation grounded in tree entries, retracted by
  its record, keeps its record and digest, shows `grounds_withdrawn` in the node view, the single read and the tool text,
  leaves the other end (its tree entries and the assertion placed on it) as it was, appends nothing on a repeat, and is
  indexed under its run; after an older run-only record, retracting the run with its receipt entries appends one entry
  record, skips the run as covered, marks both contributions, and a repeat appends nothing.
- `hub/server/knowledge-retract-cli.test.ts`: `runContributionEntries` takes the receipts of every accepted result the
  run detail names (not the management latest, not another run's result, not a non-result record), answers null for an
  absent run, and reads as the acting administrator; with the real runs service it returns the run's receipt, the
  expanded command marks the contribution, the `rec:` read of get_nodes shows the same note, and a repeat appends
  nothing.
- `hub/knowledge/operation-records.test.ts`: a feeding-grounded contribution keeps its feeding notes in the single read
  and the node view, and stays covered by its feeding record and by its run when `--run` lists it.

On the old sources (only the three source files stashed): both tests of `contribution-retraction.test.ts` fail with the
refusal "撤回目标不是已登记的喂入或回注条目"; `knowledge-retract-cli.test.ts` does not load (no
`runContributionEntries`); the feeding-grounded test passes, as it pins unchanged behaviour.

Allowed paths: `hub/knowledge/feeding.ts`, `hub/knowledge/contributions.ts`, `hub/knowledge/api.ts`,
`hub/knowledge/README.md`, `hub/server/README.md`, `hub/server/cli-admin.ts`, `hub/server/tools.ts` (only if a status reader there needs it), the
test files added or extended under `hub/knowledge` and `hub/server`, this page.

Verification: `npx tsc --noEmit -p .`; `node --test hub/knowledge/contribution-retraction.test.ts
hub/knowledge/operation-records.test.ts hub/server/knowledge-retract-cli.test.ts`; `node --test hub/knowledge/*.test.ts`;
the workspace's affected-tests helper; the full check before deploying.
