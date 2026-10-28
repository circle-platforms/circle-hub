# testing

Part of the records package; see [../records/README.md](../records/README.md).

```ts
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { openTestRecords } from '../testing/records.ts';

let postgres: TemporaryPostgres;
before(async () => { postgres = await startPostgres(); });   // one cluster per test file
after(() => postgres?.stop());

test('something', async (t) => {
  const kit = await openTestRecords({ postgres });            // fresh database, temp data dir, vault key created
  t.after(() => kit.close());
});
```

- `startPostgres({ socket?, passwordless?, timeoutMs? })`: a temporary cluster from the embedded-postgres binaries in
  `node_modules` (no shared server): temp data directory, random port, `127.0.0.1` only or a Unix socket only, SCRAM with a
  random password, or (`socket` + `passwordless`) local trust on a private 0700 socket directory so a Hub child process can be
  configured from `CIRCLE_HUB_*` variables alone. `stop()` shuts it down and removes the directory. A process that exits
  normally without calling it, or is ended by SIGTERM, SIGINT or SIGHUP (node --test sends SIGTERM to a timed-out or
  cancelled file), still stops the cluster and removes its directory, then re-raises the signal. SIGKILL cannot be caught:
  a cluster left by it keeps running until removed by hand (`circle-hub-pg-*` in the temp directory).
- `openTestRecords({ postgres?, now?, limits?, initKey? })`: a ready `RecordsKit`; without `postgres` it starts and stops its
  own cluster. `close()` removes the database, the cluster it started and the temp directory.
- `assertLinearGrowth(label, make, run, { small, factor?, runs?, maxRatio?, noiseFloorMs? })` (`growth.ts`): checks that
  the cost of `run` grows linearly with the input, instead of a fixed millisecond budget that a slow or busy runner
  breaks. It times `make(small)` and `make(factor × small)` (factor 8 by default) on the calling thread's CPU time,
  interleaved, after a warm-up pair and a full collection before each run, keeps the fastest of `runs` (3), and fails
  when the ratio exceeds `maxRatio` (2 × factor): linear and n log n work pass with margin, quadratic work fails. A large
  run under `noiseFloorMs` (25) is not judged. Pair it with a generous wall-clock ceiling that only catches a hang.
