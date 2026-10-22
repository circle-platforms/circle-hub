# hub/leases

The lease service (D04 R[0], device-pack core step C2): one row per key in the `leases` table (migration 2), acquisition atomic by the key's unique constraint, an expired or released row taken over in place with the fencing token incremented, every change appending its `lease` action record (B05 F[0], the C1 action kind) in the same transaction.

The vocabulary stays neutral (the core names no device, bench or product): a key is a string under a prefix a workflow declares; who holds a lease is a user and a run.

## Decisions

- **One clock.** Expiry is decided everywhere by the service's clock, `now` (D04 changes5 kept this out of the model text): the default asks the database (`SELECT now()`), tests inject a fixed one. The takeover `WHERE`, the `view` filter and the orphan rule all compare through the same injected moment — two clocks (SQL `now()` here, a process clock there) would answer differently under drift, and the review's answer to that was one clock: the database's.
- **Acquire is all or nothing.** Every key of one request is taken in one transaction; a busy key aborts the transaction (a `RefusedLease` thrown inside rolls it back, the outcome survives at the call's edge), so the keys taken over before the busy one leave no trace. The race loser reads the earliest free moment for its refusal (`LEASE_UNAVAILABLE`).
- **No CAS retry loop.** The unique constraint decides the winner of two acquirers of one key (`INSERT ... ON CONFLICT (key) DO NOTHING`, so the transaction stays usable to read the busy row — an errored-out transaction can run no further statement). `ON CONFLICT DO NOTHING` against an uncommitted concurrent insert blocks until that transaction commits, then misses — exactly one winner, verified by 50 rounds of two connections.
- **Take-over, not delete.** An expired or released row is `UPDATE`d in place (`expires_at <= now OR released_at IS NOT NULL`) with `token + 1`: the row never disappears, so a key's fencing token never repeats. The take-over mints a new lease identity — the old lease ended.
- **Cumulative cap.** `extend` refuses an until moment past `acquired_at + max_ttl_seconds` (`LEASE_TTL`); the caller (start_run wiring, C3) reads the cap from the workflow's declaration.
- **Orphans.** `reclaimOrphans` frees rows whose run record no longer exists (checked against the records table) once they were acquired over 60 seconds ago, writing a `take_over` action with the reason; a crash between acquire and putRun is the case this covers (review answer to design §2).
- **State in the table only.** The service object holds no state; a new instance over the same database sees the same rows (tested). The fencing token lives in the row and in the Hub's own action records, never in what a client sees (D04 R[0]).

## Operations by lineage (C6)

A projection's `lease_requests` carry an operation: `acquire` (the default, the behavior above), `extend` and `release`. The two latter are **checked before anything is executed**: the run's user must equal the row's user, and the row's run must sit in this run's lineage — the run itself and up to 20 predecessors of `RunRecord.predecessor`. A holder deeper than 20 predecessors is treated as not holding (the same `LEASE_UNAVAILABLE`; the message says 血缘). Execution then runs the extends and releases first (irreversible: a release is never undone when the run later fails), then the acquires (each failure compensates the acquires already granted). `holders(keys)` reads the rows for the check phase; `RunRecord.leases` records what this run did (with `op`), and the frozen `lease_context` rows carry `mine` for the rows held by the lineage — frozen at start_run, so the projection of a successor sees which keys it may operate on.

## Limits

- Keys are `[a-z0-9][a-z0-9:._/-]{0,199}` (the same shape the pointers table allows); a lease identity is `lse_` plus a 26-character Crockford base32 id.
- `view(prefix)` lists the unexpired, unreleased rows with their until moments only — no tokens, no holders' names (visibility is an open question in D04 changes5; the run context carries `mine` only).
- The action records this service writes go straight into `records` with the digest of the canonical envelope; `actionLog(prefix)` reads them back (the audit line, and the replay test rebuilds the table from them).

## How it is tested

`service.test.ts` runs on a temporary PostgreSQL (`hub/testing/postgres.ts`): 50 rounds of two connections acquiring one key (exactly one winner each round), all-or-nothing on a busy second key, prefix and TTL refusal touching nothing, take-over of an expired row (token increments, new lease identity), re-acquire of a released row, extend within and beyond the cumulative cap (holder, stranger, expired), view at several clock moments, force release with a reason, orphan reclaim, state across a new service object, and the action-record replay (the live rows equal the replayed state).
