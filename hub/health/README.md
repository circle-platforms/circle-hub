# hub/health

What the running process reads about itself, and how it ended (decision 146, step 2 of `docs/hub-r4-tasks/observability.md`,
its "资源" and "进程事件" parts). Two production crashes (JS heap exhausted) could not be tied to a request; this package is
why the next one can.

Everything here is diagnostic data (B08): not part of the record chain, no digest, no ground for anything, kept 14 days. No
business text, no arguments. `api.ts` is the only file other packages import.

## What is here

| File | What it does |
| --- | --- |
| `api.ts` | `createHealth` (the process side), `healthReader` (what administrators read), the types |
| `inflight.ts` | the in-flight log, `inflight.jsonl`: `begin(info) -> end()` |
| `sampler.ts` | the loop: one wide row every 10 s; a reading that fails leaves its fields null and goes on |
| `readings.ts` | one function per source |
| `sessions.ts` | open MCP sessions by declared client name |
| `reports.ts` | Node's crash reports: read once, reduced to a summary, bounded |
| `lifecycle.ts` | start, stop, and how a process's ending is established at the next start |
| `store.ts` | the two tables of migration 28, retention |
| `reader.ts`, `text.ts` | what `circle-hub health`, `circle-hub crashes` and the console's 运行状况 page read; what the commands print |

`serve` (`hub/server/main.ts`) creates it with a connection of its own, hands `requests` and `sessions` to the app, calls
`start` once it holds the port and `stop` after the requests have ended.

## Tables (migration 28)

`resource_samples`: one row every 10 s. `sampled_at`, `boot` (the process), `interval_ms`, then by resource:

| Resource | Utilisation | Queueing | Errors |
| --- | --- | --- | --- |
| main thread | `process_cpu_ratio`, `event_loop_utilization` | `event_loop_delay_p50_ms`, `_p99_ms`, `_max_ms` | |
| memory | `heap_used_bytes`, `heap_limit_bytes`, `rss_bytes`, `external_bytes`, `array_buffers_bytes` | `gc_pause_ms` | a crash: `process_events` |
| sandbox | `sandbox_running`, `sandbox_limit` | `sandbox_waiting` | `sandbox_timeouts`, `sandbox_queue_full` |
| pool | `pool_limit`, `pool_total`, `pool_idle` | `pool_waiting` | `pool_connection_failures` |
| database (every 60 s) | `pg_active_connections`, `pg_cache_hit_ratio` | `pg_waiting_locks` | `pg_deadlocks` |
| disk | `data_free_bytes` | `io_wait_ratio` (Linux) | |
| connections | `mcp_sessions`, `mcp_sessions_by_client`, `console_streams` | | |
| requests | `requests_in_flight` | | |

And `failed_reads` (names of the readings that failed for this sample, plus `inflight-log` when the log could not be written
since the last one) and `dropped_samples` (earlier samples of this process that could not be written). `process_cpu_ratio` is CPU
time of the process, all threads, per wall-clock time: 1 is one core busy, and pack functions (child processes) are not in it.
It shows what utilisation does not, garbage collection and thread-pool work. Delays, utilisation, CPU, GC pause, cache hit
ratio and I/O wait are per interval; `sandbox_timeouts`, `sandbox_queue_full` and `pool_connection_failures`
are counts since the process started, `pg_deadlocks` since PostgreSQL's statistics began.

`process_events`: `at`, `kind` (`start`, `stop`, `abnormal_exit`), `boot`, `pid`, `release`, `node_version`, `heap_limit_bytes`,
`uptime_ms`, `last_seen_at`, `requests`, `requests_omitted`, `reports`. Two partial unique indexes allow one start and one
ending per process, so two starts cannot report the same crash. The runtime role has SELECT, INSERT and DELETE on both tables,
no UPDATE.

**Null is unknown**: a reading that failed, one not due at this tick (PostgreSQL in five samples of six), a platform without
the value (I/O wait on macOS), the first sample of a delta. Never 0. `failed_reads` tells a failure from the rest. On
`process_events`, `requests` null means the log says nothing about that process, and `[]` means it says nothing was running.

## Decisions

1. **The sampler never touches the business pool.** One connection of its own (`createPool(config.database, 1)`), as section 6
   of the design asks. Every read and write is bounded in time. A reading still pending from an earlier tick is not started
   again: a stuck `statfs` must not fill the libuv thread pool the requests' file reads use.
2. **The in-flight log writes synchronously, to memory where the host offers it.** The line has to be in the operating system's
   hands before the request runs: under heap exhaustion nothing else runs, and an asynchronous write may still be queued.
   Surviving the process, not the machine, is what is asked, so nothing fsyncs. A synchronous write on the main thread
   stalls every request, though, and on a disk it waits for the file system: on the owner's ext4 on a rotational disk,
   measured over 28,000 appends of 150 bytes, a median of 10 µs, but a journal commit held one write 10 to 30 ms every 5 s, on
   an idle machine. On tmpfs the same writes reached 76 µs at most. So the unit gets a runtime directory
   (`RuntimeDirectory=`, `RuntimeDirectoryPreserve=yes`) and `serve` puts the log in `$RUNTIME_DIRECTORY`; a process with none
   (launchd, a manual `serve`) uses `<data root>/logs`. A reboot loses the file: the next start then says it does not know what
   was running. A write that fails is counted (`inflight-log` in `failed_reads`), never reaches the request, and the log reopens
   by itself.
3. **Every line carries the process's `boot`.** So a start can tell the earlier process's lines from the requests already
   arriving at it, and what it recovers does not depend on when it reads.
4. **A process records its start after it holds the port.** A second `serve` on the same data root (a manual start beside the
   service) fails to bind, so it neither calls the running process crashed nor rotates its log. The price: a crash before
   `listen` has no start event. Its crash report still becomes an abnormal-exit event, with `boot` null. `start` holds nothing
   up: it runs beside the wait for a stop signal, so a slow database never delays the rejection guard or the signal handlers of
   `serve`, and `stop` waits for it, bounded.
5. **The clean-stop marker is in the log as well as in the table.** `stop` writes the marker before anything else, since it needs
   no database, and a rotation keeps it. If the event is then refused or hangs (the database going down in the same shutdown),
   the next start writes it late instead of reporting a crash that did not happen.
6. **The log and the reports are retired only after the events are written.** A database that refuses at the start leaves them
   for the next start.
7. **One entry per request.** The HTTP entry begins it for every request, because that is the only place that sees all of them
   and a request can crash the process before its body is parsed. MCP then completes it (`end.identify`) with the caller and
   trace after authentication, and the tool once the body is parsed. So a request is one entry, however far it got: a crash
   while parsing a huge body shows `POST /mcp` and the caller.
8. **A name is a route, never a value.** `hub/server/request-entry.ts` keeps a path up to its first segment that is not a plain
   lowercase word, at most three segments, never the query: `/console/login/<secret>` (a console login link carries its secret in
   the path) is `GET /console/login`. A tool name is logged only if it passes the call log's own rule.
9. **Live console streams are not requests.** A stream stays open as long as a page does and does no work of its own; it is
   counted in `console_streams` and left out of the log and of `requests_in_flight`.
10. **An MCP session is open until DELETE or 15 minutes of silence.** The endpoint is stateless and a client may just go away, so
    nothing else ends one. A DELETE is answered 405 as before, and the specification allows a client to send it anyway. After a
    restart a session reappears at its next request without a name; `mcp_sessions` minus the sum of `mcp_sessions_by_client` is
    sessions that declared none (or a name past the 20 kept). `console_streams` is a plain count: a browser declares no client.
11. **Retention keeps the running process's own events**, however old. A Hub up for more than 14 days would otherwise lose its
    start row, and its crash would go unnoticed at the next start.
12. **`header.dumpEventTimeStamp`, not `header.dumpEventTime`.** Measured on Node 24.17: the latter is local time marked `Z`.
13. **The cache hit ratio is of the last interval.** Since the statistics began it would barely move whatever happens now.

## Limits

- The delay histogram loses what spans its `reset()`. Measured on Node 24.17: a 300 ms stall that began right after a reset was
  not recorded at all, because the reset also forgets when the timer last fired. So a stall that starts within one resolution
  (20 ms) after a tick is missing from the delay of that sample: 0.2 % of the time. Utilisation still shows it.
- The histogram's values include its timer period; that comes off, and a quiet loop then reads about 2 ms, not 0.
- p99 over 10 s at a 20 ms resolution is over about 500 points: one long stall shows in `_max_ms`, not in `_p99_ms`.
- `pool_*` is the records pool; the small lease pool of the assembly is not in it. `pool_connection_failures` counts every pool
  of the process.
- `pg_active_connections` sees sessions of the runtime role only: `pg_stat_activity` hides the state of other roles (a backup's
  session) from it. That is every session of the Hub.
- `io_wait_ratio` is what `/proc/stat` says for the whole machine, or the host of a container.
- A console or sync request carries its account from the moment it is authenticated, and a trace id only if it sent a
  `traceparent`: the rows of a trace die with the process, so an id the Hub made up would lead nowhere after a crash.
- A backup holds these tables without their rows (`DIAGNOSTIC_TABLES` in `hub/platform/sql.ts`): a restored Hub starts with
  empty ones, and its first start has nothing to report.
- An uncaught exception ends the process without a report (`--report-on-fatalerror` covers fatal errors): it is an abnormal
  exit with the in-flight requests and `reports: []`. Its stack is in `hub.err.log`.

## Reading it

`circle-hub health [--since 30m|6h|7d|<time>] [--json] [--as <admin>]`, `circle-hub crashes [--limit <N>] [--json] [--as <admin>]`
(`hub/server/cli.ts`), administrators only, in the reader too. `circle-hub db top` is a platform command in
`hub/platform/statements.ts`: `pg_stat_statements` exists only in the `postgres` maintenance database, which the runtime role
cannot reach, so the console page only names that command.

The console's 运行状况 page (`hub/server/console/health.ts`) reads through the same `HealthReader`, on a connection `serve` gives
it for that alone. `summary` over the last 24 hours gives the values now and the failed readings. `curve` is what draws: fixed
intervals aggregated in SQL off `resource_samples_sampled_at` (or `resource_samples_boot` for one process), exactly the points
asked for, each the most its interval held, free disk the least, and null where nothing was read; a window of 24 hours is at
most 8,640 samples per process whatever the table holds. `events` and `eventCount` are bounded by their limits, `releases` by
its latest events. A row of `releases` is one run of a release, which is what a deploy starts: a deploy of an older commit
reuses the release, so its id can run twice with another between, and only the order of the processes tells the runs apart. A
restart goes on with its run. A process is read from what is left of it, in the order they began: retention takes the start of
a process that ran 14 days and keeps its ending until that ages out too, and an ending says when its process began
(`uptime_ms`), so the release after it still has what ran before. An ending can also come after the next start, which is why
that order is not `seq`. The starts of two runs are what tell their calls apart: `hub/telemetry` reads each run by them.

## How to test

`node --test "hub/health/**/*.test.ts"`, and `hub/server/health-wiring.test.ts` for what the server does with it (real HTTP and
MCP requests, `serve` as the runtime role, the commands). Clock and readings are injected; nothing asserts on wall-clock time.
`lifecycle.test.ts` includes a real heap exhaustion: `fixtures/crash-child.ts` runs with the service's report flags, and the
next start must name its running request and report. `fixtures/report.synthetic.json` is synthetic, in the shape Node 24 writes.

## Needs from other packages

- **contracts**: `process_events.kind` (`start`, `stop`, `abnormal_exit`) has no vocabulary axis; `PROCESS_EVENT_KINDS` in
  `store.ts` and their labels in `text.ts` (`KIND_TEXT`, which the console page uses too) are local until it does. The model is
  outside this task. A request's origin uses the codes of the `trace_origin` axis, and the same rule for which path is which as
  a trace's root.
- **server**: `DeclaredClients` could name a session a restart forgot.
