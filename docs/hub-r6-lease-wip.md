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
resource-key index, and batch lease actions replay per key. The `knowledge-contribution` pack moves to 1.3.11 in the public
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

A seventh review should confirm these before the branch is offered for main.

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
