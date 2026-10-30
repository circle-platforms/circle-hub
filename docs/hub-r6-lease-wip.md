# Operation device and bed

This started as a hand-off of "operation device and lease binding" (#28, #40). On 2026-10-30 the owner narrowed it to the
device and bed an operation record names and moved leases out of the knowledge layer. The owner then merged it into main
(#40) without a further independent review. The main fixes it waited for, #106 and #108, had one review round each.

## Direction (owner, 2026-10-30)

- **Beds belong to the test-bed pack.** `packs/workflow/test-bed` owns the bed inventory, booking, release, force release
  and the bed surface. Hub core keeps only its generic lease primitive on resource keys: dispatch requires a run's lineage
  to hold the keys its executor needs, which makes a lease a mutex at execution time, as InfoTest's `env_pool` holds one
  per bed while a case runs.
- **Records name a device and bed; they never claim a lease.** An operation record (observation, procedure, pitfall)
  may declare `device` and `bed`. When the run, or the booking it continues, froze a bed manifest, the Hub checks both
  against it and fills in the bed when only one bed has the device; a device in several beds needs its bed. Without a
  manifest the declaration is kept as written. InfoTest's read-only probes do the same: they record their bed and leave
  the lease empty, because a lease id there would be a false claim.
- **No Windows for now.** Circle Hub and its packs support macOS and Linux only. `operation-capture` refuses its commands on
  Windows and its hook captures nothing there.
- **Tokens are masked, not hunted.** The client replaces the current Hub token in captured output with `%HUB_TOKEN%` and
  uploads the rest. A proposal holding the whole token is refused before a run starts, and `submit_result` checks the
  request with the same token read it sends. The Hub refuses a request whose body holds the caller's whole token (#106).
  There is no 12-character fragment rule.

## What it adds

- `device` and `bed` on the three operation records, checked by `hub/knowledge/operation-device.ts` and shown as
  "设备 X（台架 Y）"; the bed is part of the record's identity.
- The exact capture record in an operation record's identity: `artifact` on `src` input bindings and on the upload
  receipt, `captured_at` on `upload_file`, and `source.artifact` on the upload notes (fed-note) the Hub writes now.
- A missing capture time is recorded as such (`captured_at_declared=false`, `received_at`) and never replaced by the
  upload time; the view says so.
- Decision 73 at the edges: `start_run` refuses a client-captured input for any pack but knowledge-contribution
  (`hub/runs/engine/inputs.ts`), and `submit_result` refuses a run bound to one before that check existed
  (`hub/runs/engine/submit.ts`). The declaration-grade refusal also covers the grounds a tree entry carries
  (`declarationGroundsRefusal`).
- Client: one token read per checked call, the token passed down to the request instead of kept on the client, and the
  Windows refusal. The pack is knowledge-contribution 1.3.14.

## What was removed

Lease evidence on records (`lease`, `lease_id`, `lease_unconfirmed`, "无租约（未授权）", "租约未能确认") and everything
built to prove it: the capture-time lease history reader, its key index, the lease service's own clock and per-key replay,
the lease fields of the submit receipt, and their tests. Review rounds 4 to 9 had also added source pinning, provenance
checks of `src` grounds in the resolver and the evaluator, a credential scanner over submissions before they are stored,
the bounded search for older upload notes, and request-exit token checks on the Hub address, headers and uploaded bytes.
The two decision-73 gates above make the pinning and `src` checks redundant, #106 covers the token on the Hub side, and the
rest only served the lease proof; all of it is gone, with the open items of the ninth review that were about it.

## Open items

- The knowledge layer reads the test-bed manifest itself: the device check here, and, from before this branch, the
  reproduction lease index and the installed build of a booked bed. That belongs behind a test-bed contract (#110).
- Circle runs a skill's hooks through `cmd.exe` on Windows, where this pack's hook cannot start; skills cannot declare
  their platforms yet (circle-platforms/circle#374).
- The native Windows work (the Windows platform code and the platform matrix) lives only on the `synthetic-platform/*`
  and `docs/windows-probe-*` branches, and is frozen (owner, 2026-10-30). Main has no Windows code.
- #109 (the connector's nested reads are cached and withheld by record, not by effective tier) is on main.

## Frozen replay fixtures

`hub/knowledge/operation-device.test.ts` and `hub/knowledge/operation-records-upgrade.test.ts` read committed fixtures
under `tests/fixtures/frozen/`: `knowledge-contribution@1.3.1` byte for byte from aecc1a9 (the parent of this work), and
`upgrade-records.json`, the rows and objects that the Hub at aecc1a9 wrote for one run, generated by running that tree's
code once with `hub/knowledge/testing/frozen/generate-upgrade-records.ts`. They no longer extract 886d9f4c, the local
parent this work had before it was rebased, which no clone has. Both fixtures predate the device fields, which is what the
tests need: records written without them replay unchanged.

## Follow-ups

The open items above are the follow-ups. Read `hub/knowledge/README.md` and the 1.3.14 notes in
`packs/workflow/knowledge-contribution/README.md` first.
