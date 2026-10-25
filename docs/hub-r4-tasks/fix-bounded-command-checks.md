# Bound command checks and interrupted validation recovery

Owner request: repair the catalog expansion, source connection fan-out and unbounded restart recovery introduced with plan command resolution.

Scope: contracts/src/pack.ts and its generated schemas; Hub knowledge catalog selection/ports; runs engine selection, source budgets and recovery; pack validation of selector entry points; case-compile selection, version, signed manifest and synthetic fixtures/tests; package README.

The pack derives complete device CLI lines solely from the frozen contract/profile argument roles. Before building subjects, Hub follows exact tree edges along those tokens in the locked catalog, reads only command nodes on those paths, and shares that selected view across the item's checks. Ancestor signatures on the actual token path remain available to detect ambiguity; this is grammar traversal, not abbreviation or prefix acceptance. No recursive subtree scan or full-catalog fallback is permitted. The complete typed parser still decides whether the whole line is a command.

Limits: 128 lines, 8192 bytes and 128 tokens per line, 4096 visited nodes / 8 MiB, 512 selected entries / 1 MiB. Entry content batches contain at most 128 records. Source resolution across evaluations shares four concurrent reads. One evaluation admits at most 256 distinct source references and 16 MiB of retained source text; excess reports an unfinished check with a split-input/admin recovery, without charging model repair rounds.

Automatic recovery reserves a durable attempt before executing interrupted submissions, fact production, management projection and parent-check recovery. A killed process consumes the reservation. Three attempts exhaust automatic re-entry and hand the missing result and next action to an administrator; original inputs and historical outcomes remain append-only.

Synthetic tests cover a 12000-command tree with repeated and absent paths, exact persisted catalog selection, complete plan checks without authored identities, process-wide read concurrency, reference/byte budgets and restart recovery with three reservations but no completion. The large-tree test runs with a 192 MiB V8 heap limit, asserts peak RSS below 384 MiB and selection-phase RSS increase below 64 MiB. These are synthetic limits, not production memory evidence.
