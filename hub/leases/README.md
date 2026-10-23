# hub/leases

The lease service (D04 R[0], device-pack core step C2): one row per key in the `leases` table (migration 2), acquisition atomic by the key's unique constraint, an expired or released row taken over in place with the fencing token incremented, every change appending its `lease` action record (B05 F[0], the C1 action kind) in the same transaction.

The vocabulary stays neutral (the core names no device, bench or product): a key is a string under a prefix a workflow declares; who holds a lease is a user and a run.

## Decisions

- **One clock.** Expiry is decided everywhere by the service's clock, `now` (D04 changes5 kept this out of the model text): the default asks the database (`SELECT clock_timestamp()`), tests inject a fixed one. The takeover `WHERE`, the `view` filter and the orphan rule all compare through the same injected moment — two clocks (SQL `now()` here, a process clock there) would answer differently under drift, and the review's answer to that was one clock: the database's.
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
- `view(prefix)` lists active rows with run, since and nullable expiry. Trusted callers can ask for user ids; the engine filters identities by registered ownership and administrator role. Tokens stay internal.
- The action records this service writes go straight into `records` with the digest of the canonical envelope; `actionLog(prefix)` reads them back (the audit line, and the replay test rebuilds the table from them).

## How it is tested

`service.test.ts` runs on a temporary PostgreSQL (`hub/testing/postgres.ts`): 50 rounds of two connections acquiring one key (exactly one winner each round), all-or-nothing on a busy second key, prefix and TTL refusal touching nothing, take-over of an expired row (token increments, new lease identity), re-acquire of a released row, extend within and beyond the cumulative cap (holder, stranger, expired), view at several clock moments, force release with a reason, orphan reclaim, state across a new service object, and the action-record replay (the live rows equal the replayed state).

## Trusted holder snapshots

`LeaseService.holderSnapshot(keys)` returns current rows with key, lease identity, fencing token, holder user/run, release state and expiry. It is read-only, deduplicates and sorts keys, and omits absent keys. Tokens are for trusted enforcement code only, never client or model output. Existing acquire, extend, release and force-release semantics are unchanged; callers still check expiry against their trusted clock and re-read at the effect boundary. A returned array is a snapshot, not a held database lock. Tests: `node --test --test-concurrency=1 hub/leases/*.test.ts`.

Lease actions appended by this version store the RFC 8785 canonical body text used for their digest, with a UTF-8 byte size. A regression reads acquire/release actions back through the ordinary integrity-checked records API. Historical records and applied migrations are not rewritten, and integrity verification is not relaxed; the integrator audits any historical noncanonical lease rows separately.

All new lease actions now go through `RecordStore.put` inside the lease transaction, including record byte limits, canonicalization and indexes. `ServiceOptions.records` accepts the deployment's configured store; otherwise a store over the same database uses the standard record limit. The public records factory `createRecordStore` supplies this boundary. A record-store refusal rolls back the lease row change. Action replay also uses integrity-checked record reads, including unindexed historical rows. This changes neither lease ownership nor fencing semantics.

Snapshots reject fences outside JavaScript's safe integer range rather than round two distinct database tokens into the same value. The service signatures use the generated LeaseOp type. Additional regressions cover configured UTF-8 audit limits and rollback of an oversized Unicode force-release reason; ordinary ownership, expiry and fencing transitions remain unchanged.

租约动作的取值类型统一来自生成词表 `LeaseOp`；内部续租/释放共用路径使用其 `Extract` 子集，
不另写租约操作轴。

A workflow may omit `max_ttl_seconds`: its acquisitions have `until: null`, with no wall-clock expiry.
Every active-row query, trusted snapshot, orphan cleanup and release treats null as unbounded.
Extending such rows is refused before mutation; a lineage releases them explicitly. Capped workflows keep their TTL
and cumulative extension rules. Migration 4 only removes the expiry NOT NULL constraint; applied migrations stay fixed.

Ownership is independent of holding: `register` assigns a strictly nested slash-terminated prefix to its first user.
Registrations may never contain each other. Administrators may reassign an exact existing prefix with a reason;
ordinary users cannot reveal or overwrite its owner. `unregister` requires the owner or an administrator and refuses
while any active row remains below it. A database advisory lock serializes overlap checks, registration changes and
acquisition, including two connections registering overlapping prefixes. Migration 5 adds only the current ownership
table and its runtime grant; each mutation appends its registration action atomically. `actionLog` includes owner,
previous owner, actor, reason and prefix so the current table can be rebuilt. Public run views filter these trusted rows.

Every current row view now includes the acquisition moment (`since`), holder run and nullable expiry. Trusted callers
may request the user id. The engine separately decides identity visibility using the registration table: registered
owners and administrators see holder id/name; everyone sees the run, since, mine and unfinished job ids. Registration
rows expose only prefix/mine except in administrator runs. Fences never enter either frozen view.

Reservation insertion and guarded force-release share a durable advisory lock. `withMutationLock` hands its existing
transaction to the trusted snapshot check, so it does not borrow another lease-pool connection while holding the lock.
Force-release runs its job guard under the same lock immediately before changing rows. A reservation that wins first
blocks release; a release that wins first changes fences and blocks reservation. No network operation holds this lock.
The default database clock also uses the mutation transaction's connection, preventing starvation in a two-connection pool.

The mutation clock is database wall time after lock acquisition, rather than the BEGIN timestamp, so a queued capped
acquisition cannot start already backdated by the time spent waiting for another mutation.
