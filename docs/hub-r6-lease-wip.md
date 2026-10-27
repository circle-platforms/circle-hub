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
resource-key index, and batch lease actions replay per key. The `knowledge-contribution` pack moves to 1.3.2 in the public
numbering, and three entries of `contracts/model.json` gain optional fields only.

## Known blockers (see issue #28)

1. A prefetched source can skip the declaration-grade check when it is later used as grounds. Prefetch may cache only the
   parse result; every use as grounds must check provenance again.
2. The current Hub token can leak inside the `device` or `bed` field of a proposal: only an exact match is refused. Refuse
   any substring and check the current token again just before sending.
3. When the client omits the capture time, the upload time can be mistaken for it in the record's `at`.
4. A lease timestamp is taken before the row lock; the history read and the commit do not share one lock, so an action
   that arrives later can be missed inside the interval.

Each has an implementation and a targeted counter-example on this branch, but none has been independently reviewed, and
the lease concurrency test covers one code path only.

## Tests that fail on this branch

All are carried as they are; no assertion was weakened, deleted or skipped.

- Two scenario-28 acceptance tests, the same pair as on main (#37).
- `hub/knowledge/operation-records-leases.test.ts` and `hub/knowledge/operation-records-upgrade.test.ts` replay old
  runs by extracting objects of earlier commits with `git archive`. A public clone does not contain those objects, so both
  fail before the replay starts. They need a frozen, public fixture of the old format.
- `hub/knowledge/view-perf.test.ts`: the predecessor byte digest differs from the expected one. The cause is not known.
- `hub/runs/engine/exact-prefetch-budget.test.ts`: 15 parses (3 batches and 12 single reads) where 3 parses in 3 batches are
  expected. It may come from blocker 1's fix; this is not established.

## To continue

Read `hub/knowledge/README.md` and the work-in-progress notes at the top of
`packs/workflow/knowledge-contribution/README.md`. Have the four items reviewed by a different model family, fix what it
finds, then run the complete suites, not only the affected directories.
