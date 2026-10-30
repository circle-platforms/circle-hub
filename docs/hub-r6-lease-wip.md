# Operation device and lease binding (work in progress)

This branch is a hand-off, not a finished change. Do not merge it into main until the blockers below are fixed and
independently reviewed. It is based on the R6 snapshot branch and carries only the new work, as one signed-off commit.

## What it adds

Operation records (observation, procedure, pitfall) from a Circle session can carry two optional declarations, `device`
and `bed`. When a record is stored, the Hub adds lease evidence of its own: the resource key and the lease record that
covered the bed and device continuously from the declared capture time to the time the Hub received the record. When
coverage cannot be shown (acquired, released, taken over or expired inside the interval, or no lease at all) the record
is still accepted, and it says which of these applies and what to do next. Records stay at declaration grade and can never
be grounds for a verified result.

Related changes: the exact capture record is part of the identity of an operation record, a missing capture time is
marked and never replaced silently by the upload time, lease actions use the lease service's own clock with an exact
resource-key index, and batch lease actions replay per key. The `knowledge-contribution` pack moves to 1.3.13 in the public
numbering, and three entries of `contracts/model.json` gain optional fields only. It was 1.3.2 here until `main` published
its own 1.3.2 (the dead-lock recovery fix, #92); the merge of `main` combines both as 1.3.7, after this branch's internal
numbers 1.3.3 to 1.3.6.

## Known blockers (see issue #28)

1. A prefetched source can skip the declaration-grade check when it is later used as grounds. Prefetch may cache only the
   parse result; every use as grounds must check provenance again.
2. The current Hub token can leak inside the `device` or `bed` field of a proposal: only an exact match is refused. Refuse
   any substring and check the current token again just before sending.
3. When the client omits the capture time, the upload time can be mistaken for it in the record's `at`.
4. A lease timestamp is taken before the row lock; the history read and the commit do not share one lock, so an action
   that arrives later can be missed inside the interval.

Each has an implementation and a targeted counter-example on this branch.

## Fourth independent review (codex, 2026-10-30)

A read-only review by a different model family (codex, gpt-6.1-terra) of eb663b9 found the targeted fixes cover the original
counter-examples and listed eight remaining problems; its full text is on issue #28. Each is fixed here with a test that
fails without the fix:

| # | Problem | Fix | Test |
|---|---|---|---|
| 1 | History read without a lock could miss a lease action timed inside its window but not yet committed. | Every lease change takes a per-key advisory lock before its clock; `history()` takes it shared before it reads (`hub/leases/service.ts`). | `history does not miss a change that was timed inside its window but had not committed yet` (`hub/leases/time-order.test.ts`) |
| 2 | `acquire()` and `reclaimOrphans()` took their time before the row lock. | Both take the key locks first; reclaim re-reads its rows under them and never releases a row twice. | `an acquire that waits for a release is timed after it, never before`; `an orphan reclaim that meets a release in flight re-reads the row instead of releasing it twice` |
| 3 | The artifact read and the artifact whose provenance a use as grounds checks could differ. | One concrete artifact per digest per resolver: the run's bound one, or the one readable at first use; reads are pinned to it (`hub/runs/engine/exact.ts`). | `a use as grounds reads the very artifact whose provenance it checks` (`captured-ground.test.ts`) |
| 4 | The token was read once for the target check and again for the request. | `HubClient.callChecked()`: one read for both (pack 1.3.8). | `a checked call carries exactly the token its check saw, even when the token rotates between them` |
| 5 | An upload's `fed-note` still recorded the upload time as `at`. | Model and contracts: `at` optional on `fed-note@1`, with `captured_at_declared` and `received_at` as on operation records; a note has `at` only when the client declared it (pack 1.3.9). | `an upload note records a capture time only when the client declared one` (`feeding.test.ts`) |
| 6 | An undeclared capture time dropped a bed derived from the frozen manifest. | The derived bed is kept in the record and its identity. | `a bed derived from the frozen manifest stays in the record and its identity when the capture time is not declared` |
| 7 | Every artifact origin put the capture time into its dedupe key, so connector re-reads made new records. | Only an upload's declared capture time takes part. The legacy fixture uses main's real key. | `a connector answer read again at another time reuses its record, as before capture times existed` |
| 8 | Only operation records with a device said the capture time was undeclared. | Every operation record says so. | the two notes asserted in `operation-records-leases.test.ts` |

## Fifth independent review (codex, 2026-10-30)

The same reviewer read the round-four fixes (PR #102) and confirmed items 2, 6 and 7. It asked for more on items 1, 3, 4, 5
and 8; its full text is on issue #28. CI on the same PR also found a regression from the round-four fix for item 3: the
resolver looked up the run record to find a source's bound artifact, so a run that was still starting, with no stored run
record yet, could not read its own sources (`hub/runs/engine/production-notes.test.ts`, five tests). Each point below has a
test that fails without its fix:

| Item | Problem | Fix | Test |
|---|---|---|---|
| 1 | `history()` held one pooled connection while loading records through the same pool. | Only digests are read under the lock; records load after the transaction. | `a history read on a one-connection pool shared with its records does not wait for its own connection` |
| 1 | A window that had not ended before the read could still gain a change, timed later, even in the same millisecond. | `history()` takes its own moment on the lease clock under the lock and reports `settled`; an unsettled answer leaves the lease unconfirmed. | `a history read is settled only for a window that ended before its own moment on the lease clock`; `a receipt not yet before the lease clock is unconfirmed …` |
| 1 | The ordering test stopped the change before it had read its clock. | The test now holds the change after its clock, at its record write. | `history does not miss a change that was timed inside its window but had not committed yet` |
| 2 | No test showed the reclaim reads its clock only after the key lock. | The reclaim test records when its clock is read. | `an orphan reclaim that meets a release in flight …` |
| 3 | Without a run, a use as grounds was not checked; several bound records chose the first; an undeterminable record passed. | Bindings come with the scope (`RunScope.bound`, `pack`). Every record bound to the digest is checked; when no record can be determined the use is refused (`UNKNOWN_GROUND`), and so is an inner ground that does not parse. `evaluate.ts` uses the same rule. | `without a run, a use as grounds still checks the record it reads …`; `a run that binds one digest to two records refuses it as grounds when either record is captured …` |
| 4 | The checked token was kept on the shared client, so two concurrent calls could swap tokens. | The token is passed down to the request that carries it (pack 1.3.10). | `two checked calls on one client each carry the token their own check saw` |
| 5 | Note compatibility: same bytes uploaded twice at one declared time; notes written before the declaration; old uploads given new notes. | A note proposal must equal the note the Hub wrote for one upload record (looked up by its unique key), whatever its shape. A new note for an upload without the marker says the time was not declared (main never let uploads declare one). | `two uploads of the same bytes at the same declared time …`; `a new note for an upload recorded before …`; the upgrade replay annotates the frozen Hub's note |
| 5 | A run locked to 1.3.8 or older cannot carry a note in the new shape. | By design: its slot schema requires `at` and allows no other time field, so it is refused there; start a new run. | `a run locked to the frozen pack carries notes as the frozen Hub wrote them, and refuses a note in the new shape` |
| 6 | No test showed that a different bed changes the identity. | Added. | the derived-bed test |
| 8 | A historical operation record with no marker showed no time-source note. | Its view says the source of its `at` is unknown (`HISTORICAL_CAPTURE_TIME`); its bytes are unchanged. The upgrade test now expects that note. | `a run and receipt persisted by the frozen Hub replay unchanged after upgrade` |

Known limits, not changed:

- The order holds for one lease clock (the database clock by default) that does not step back. A step back can time a later
  change into a window already answered; detecting that would need a recorded per-key read mark.
- `reclaimOrphans()` locks every unreleased key whose run is missing, one query per key, before it checks age and expiry
  under the clock. Nothing in the Hub calls it on a schedule yet; measure it before it does.

## Sixth independent review (codex, 2026-10-30)

The reviewer confirmed items 2, 4, 6 and 8 and asked for more on items 1, 3 and 5. Its full text is on issue #28. Each fix
below has a test that fails without it:

| Item | Problem | Fix | Test |
|---|---|---|---|
| 1 | "Resubmit later" could not help: an identical submission returns its cached result, and the same operation identity reuses its record. | When the lease clock passes the receipt within a second (the same millisecond, or a small skew), the Hub waits and reads the history again. A larger gap means the clocks disagree, and the message says so and asks for a new capture once they are fixed. | `a receipt the lease clock passes within a second is read again and confirmed, not left unconfirmed` |
| 3 | The evaluator read through an unpinned reader and chose the checked record separately; a run-authorized generated record could not be pinned; an invalid second binding passed. | One shared `pinnedSources` choice per digest for the resolver and the evaluator. A run-authorized record is read unpinned and checked to be the chosen record. Every binding is verified (kind, schema, bytes), and any failure refuses grounds (`UNKNOWN_GROUND`). | `evaluation checks the record its read came from …`; `a run that bound no record reads a generated source on its own authority …`; `a binding to anything but a source artifact of these bytes …` |
| 5 | Notes alike in the same millisecond could not be told apart, and the record bound was a guess. | A new note names its upload record in `source.artifact` (model and contracts; pack 1.3.11). An older note is compared across at most 64 of the uploader's equal uploads, and more than one match is refused. | `two uploads of the same bytes at the same declared time are each annotated through their own note and record`; `an older note that two uploads wrote alike is refused …` |
| 5 | No real submission to a run on the frozen pack. | The upgrade test submits a new-shape note to the frozen run and gets `SUBMISSION_SCHEMA_VIOLATION` at `/items/0/slots/contribution/0/data/feeding`. | `a run and receipt persisted by the frozen Hub replay unchanged after upgrade` |
| Tokens | Only device and bed were checked for the current token. | Every checked request is refused when its serialized arguments hold the current token, and every proposal text is checked before `start_run` (pack 1.3.11). | `a proposal text holding the current token is refused before any request carries it`; `a token rotated after start_run into a proposal text is refused before submit_result` |

The review also found two baseline risks that main has as well. They are tracked on their own issues rather than in this
branch:

- #104: the feeding append path reads through the pool while it holds the feeding log lock.
- #105: the Hub stores a raw submission before validation, so a caller's token written into its text is persisted.

## Seventh independent review (codex, 2026-10-30)

The reviewer asked for more on items 1, 3 and 5 and on the token checks. Its full text is on issue #28. Each fix below has a
test that fails without it:

| Item | Problem | Fix | Test |
|---|---|---|---|
| 1 | After the wait, a second read can still come before the receipt, and the answer then claimed a gap of more than a second it had not measured. Other unconfirmed answers said to send the capture again, which reuses the unconfirmed record. | The answer states what the reads saw: the receipt, both lease-clock moments and the wait, or the measured gap when there was no wait. Every next action asks for a new capture made while the lease is held, and says that the same capture or submission again reuses the record. | `hub/knowledge/feeding-leases.test.ts`, with a scripted history: one read or two, a second read still unsettled, a gap of a second, a gap just under it, and no answer that says to resend |
| 3 | The exact phase reads every item's location as the judged object; a quotation in slot data citing that same location took its text without the grounds check. | A quoted reference is graded also when it is an item's own location: a `src` text already read is checked as grounds against the record the evaluation chose, any other scheme is read and graded again. | `a quotation in slot data of an item's own location is graded as grounds …` (a real submission, with a control that is supported) |
| 3 | A bound record was checked by kind, schema and bytes, not by its provenance. | A chosen record must have a known provenance, the same in its body and on the record; otherwise it is no grounds (`UNKNOWN_GROUND`), on every path. `declarationGroundRefusal` refuses a missing or unknown provenance too. | `a bound record of provenance client_captured with declared in its body …`; `… declared with synthetic-unknown …`; `a source whose provenance is missing or not a known one cannot be grounds` |
| 3 | The quote search that resolves commands read whatever record of the bytes the reader could read, not the one the run bound. | The scope and its resolver share one choice of records (`RunScope.pinned`); the quote search reads through it. | `the quote search reads the record the run bound, not another readable record of the same bytes` |
| 3 | A generated record a run reads on its own authority could not be pinned, so a newer record of the same bytes made later reads fail. | `sourceForRun` reads a named generated record of the bytes the run refers to; every read stays on the chosen record for the whole evaluation, and a new evaluation chooses again. | `a generated source a run reads on its own authority stays on the chosen record …` |
| 5 | The older-note search loaded every record of the bytes, of every user, and counted the uploader's uploads before checking who asked, so another user could tell whether someone had more than 64. | Who may annotate is checked first. The search reads only the uploader's own records, at most 2000, page by page; more than 64 uploads of the same bytes, or more records than that, are refused with a new upload as the remedy. | `who may annotate an upload is checked before the uploader's uploads are counted`; `an older note is matched among at most 64 …`; `an older note is refused, not guessed, once the uploader's records exceed the bounded read`; `a new note that names another person's upload of the same bytes is refused` |
| 5 | The frozen-pack refusal was shown with a hand-built note. | The upgrade test submits the note the current Hub writes for a new upload, checks the two slot schemas, and asserts the error object at `/items/0/slots/contribution/0/data/feeding`. | `a run and receipt persisted by the frozen Hub replay unchanged after upgrade` |
| Tokens | An upload's original was checked for the whole token only; `uploadDocument`, `initialize` and the session header were not checked. | Every request leaves through one exit, where everything it sends but the authorization header is checked against the token that header carries: method and parameters, an uploaded file's decoded bytes, and the other headers. The upload check uses the 12-character rule too (pack 1.3.12). | `a session id holding the token, whole or in part, is refused before any request leaves …`; `an uploaded document is checked in its decoded bytes …`; `a run of a token rotated in before upload is refused like the whole token` |

Known limits, not changed:

- Reading a source looks at every record of its bytes to decide the read tier, as it does on main. The older-note search no
  longer adds such a read of its own.
- The reviewer recommends fixing #104 and #105 before this branch goes into main. Both are on main as well; they will be
  fixed on main by their own changes first, and the branch synced with main before it is offered.

## Eighth independent review (codex, 2026-10-30)

The reviewer confirmed item 5 and asked for more on items 1 and 3 and on the token checks. Its full text is on issue #28.
Each fix below has a test that fails without it (checked by mutation):

| Item | Problem | Fix | Test |
|---|---|---|---|
| 1 | After the wait the answer still named a cause ("the lease clock did not advance, or the clocks disagree") that two reads do not show. A view said an undeclared capture time was "taken from the upload time", though no time is recorded. | The answer states the wait the Hub set and both readings, and leaves the cause to the administrator. The view says the capture time was not declared and the record has none. | `a second read the lease clock still has not passed …`; `the answers for a capture without a bed or without a declared capture time …`; the three wording assertions in `operation-records-leases.test.ts` |
| 3 | The exact phase and the evaluation each chose records, so an item's text could be read from one record and graded by another; a reused text skipped the access, tier and size checks. | `submit` and the effect recheck pass the exact phase's choice to the evaluation (`EvaluationInput.pinned`), which shares it when it reads as the same reader. A reused text is read again for access and tier once per digest and held to the check's byte cap; each check's cap applies in the graded view, not only the first check's. | `the evaluation grades a text the exact phase read against the record that phase chose`; `an item's own text quoted as grounds keeps the check's byte cap` |
| 3 | A pack function was given the items' own texts and could cite them as grounds without the grade. | A function's support or refutation that cites an item text or a graded reference which grades as no grounds, or whose record cannot be determined, becomes an unknown. | `an item's own location quoted in slot data, or cited by a pack function, is graded as grounds` (with the `self_cited` check of the toy pack) |
| 3 | A record that cannot be determined was answered as a refutation. | It reads as unavailable with the rule that says why: `quote@1` answers unknown, with the record as the missing fact. | the same test |
| 3 | A binding to a record without a body crashed the choice. | A malformed body is no source; the use as grounds is undetermined. | `a binding to a record without a body leaves the record undetermined …` |
| 3 | A runtime sample's provenance was taken from whichever record of the bytes was readable. | It names the record the evaluation chose; with no single complete choice there is no proof. | `a runtime sample names the record the evaluation reads …` |
| 3 | Round seven let `sourceForRun` read any generated record of the bytes by its digest. | Reverted: a run reads the newest generated record on its own authority, as before. Within one evaluation a newer record of the same bytes fails the read instead of changing the evidence; the Hub answers that the source could not be checked, and the same submission again is a new evaluation that chooses again. | `a generated source a run reads on its own authority is not switched …` (a new resolver chooses the newer record) |
| Tokens | The request target was not checked. | The exit checks the Hub address too, as written and with its path decoded (pack 1.3.13). The rule is a run of 12 characters; a token cut into shorter pieces or encoded otherwise is outside it. | `a Hub address whose path holds the token, as written or percent-encoded, sends nothing` |

Known limits, not changed:

- A bound generated record that the run reads on its own authority takes its read tier from that record alone, not from a
  newer scan of the same bytes. This is on main too; it is fixed on main by its own change and comes here with the next sync.

## Ninth independent review (codex, 2026-10-30): open, review loop stopped

The reviewer confirmed the item 1 wording, the reader-identity check for the shared choice, the unknown answer for an
undetermined record in `quote@1`, and the knowledge-contribution exemption. Its full text is on issue #28. It found eight
more items, none fixed here: on 2026-10-30 the owner decided to stop the review loop at this point. This branch is not
merged into `hub-lease-wip`.

| # | Open item |
|---|---|
| 1 | A pack function is given the items' texts without the current access, tier and byte cap; a ground that is unavailable, retain-only or too large does not turn its conclusion into an unknown. |
| 2 | A pack function that cites a source it read through its declared reads (`boundSources`) is not graded. |
| 3 | Byte caps of different checks still affect each other: a `too_large` grade is cached at the first check that grades a reference. |
| 4 | Reusing an item text bypasses the evaluation's read budget (its concurrency gate and the 16 MiB total). |
| 5 | A runtime sample gets an outside-the-author proof even when the evaluation could not read its source. |
| 6 | A bound record with `sha256` and `provenance_type` but no `origin` or `author` counts as a source; the sample proof then throws. |
| 7 | A read that fails because a newer generated record appeared is answered as `REFERENCE_UNRESOLVED`, which is cached: the same submission again may return it instead of choosing again. |
| 8 | A malformed percent escape in the Hub address makes the decoded-path check throw, so a percent-encoded token later in the path is not checked. |

The reviewer also asked for tests of the two call sites that pass the exact phase's choice (`submit`, effect recheck).

Before this branch is offered for main, these items need fixing, and so do the related main changes: #106 (#105) and
#108 (#104) are open, #107 is merged, and #109 tracks the connector read tier. Main then needs syncing into this branch.

## Tests that failed on this branch

All three are fixed; no assertion was weakened, deleted or skipped.

- The two scenario-28 acceptance tests (#37, #56) pass since main's case-compile 3.8.6 (#78) was merged in.
- `hub/runs/engine/exact-prefetch-budget.test.ts` (15 parses where 3 were expected): blocker 1's fix made a use as grounds
  skip the prefetched result and resolve the reference again, one parse and one lookup each. A prefetched source is now
  reused for grounds after the same declaration-grade check that `run()` makes (`declarationGroundRefusal` with the run's
  ground source); a `src` reference is otherwise always groundable and has no inner grounds. The source is still read again
  on every use. `hub/runs/engine/captured-ground.test.ts` still refuses the prefetched declaration-grade source, and fails
  if that check is removed. Blocker 1's review should cover this path too.
- `hub/knowledge/view-perf.test.ts` (predecessor digest): every new artifact record carried `captured_at_declared`,
  `false` for the Hub's own non-upload artifacts as well, so the 1,800 documents of the fixture changed their record bytes
  and with them the view's `listed_documents` part and the root's composition; all 49,000 entries were identical. Only an
  upload records the flag now (`true` or `false`); every reader already treats a missing flag as not declared.

The two replay tests, `hub/knowledge/operation-records-leases.test.ts` and `hub/knowledge/operation-records-upgrade.test.ts`,
no longer extract an unpublished commit (886d9f4c, which no clone has). They read committed fixtures under
`tests/fixtures/frozen/`: `knowledge-contribution@1.3.1` byte for byte from aecc1a9 (the parent of this work), and
`upgrade-records.json`, the rows and objects that the Hub at aecc1a9 wrote for one run, generated by running that tree's
code once with `hub/knowledge/testing/frozen/generate-upgrade-records.ts`.

886d9f4c is the local parent this work had before it was rebased: ef833de was authored on 2026-10-28 at 02:38 (+0900)
and committed at 23:33 the same day onto aecc1a9, and a rebase rewrites commit ids but not a commit id written inside a
test. The frozen pack is the same bytes 886d9f4c held, unless that unpublished commit carried a local pack change that no
pushed commit shows: `packs/workflow/knowledge-contribution` last changed in 5b45a24 (01:53 that day) and is identical at
aecc1a9. The upgrade fixture is the output of aecc1a9's Hub, not necessarily of 886d9f4c's: between a5f21bd (02:22, the
closest pushed commit before the work began) and aecc1a9, 14 files under `hub/knowledge`, `hub/runs`, `hub/records` and
`contracts` changed. Both predate the lease fields, which is what the test needs: records written without them replay
unchanged. Neither replay test ever pinned a digest of 886d9f4c; they check that the frozen inputs are self-consistent.

## To continue

Read `hub/knowledge/README.md` and the work-in-progress notes at the top of
`packs/workflow/knowledge-contribution/README.md`. Have the four items reviewed by a different model family, fix what it
finds, then run the complete suites, not only the affected directories.
