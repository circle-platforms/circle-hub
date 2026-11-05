# telemetry

Runtime observability of the Hub, step 1 of [the design](../../docs/hub-r4-tasks/observability.md) (decision 146, model B08): every
request that enters the Hub and every round of a background task is a trace; a trace is a tree of named steps; each step
carries what it used. The rows are diagnostic data: kept 14 days, outside the record chain, no digest, never grounds (B08
R[5]). They hold no inputs, outputs, arguments or business text.

## Files

| File | What it holds | Who imports it |
| --- | --- | --- |
| `usage.ts` | the trace context on `AsyncLocalStorage`: `startTrace`, `background`, `step`, `addUsage`, `recordQuery`, `recordSourceRead`, `addEvent`, `updateTrace`, `setTraceStatus` | everyone, also `hub/records`, `hub/refs` and `hub/rules`: it depends on Node and on types only |
| `names.ts` | `STEP_NAMES` and `USAGE_NAMES`, the one list of names, and the mapping of what arrives to an entry of it | `usage.ts` (types), `api.ts` |
| `writer.ts` | `TraceWriter`: the bounded queue and the batch insert | `api.ts` |
| `retention.ts` | `purgeExpired`, `scheduleRetention` | `api.ts` |
| `reader.ts` | `TraceReader`: `list`, `show`, `top` with the permission rule; `background`, `clients`, `releases` for the console's 运行状况 page, administrators only | `api.ts` |
| `api.ts` | the public surface, `startTelemetry`, `openTraceReader` | everything above records |

Dependency direction: `hub/records/db.ts`, `hub/records/objects.ts`, `hub/refs/parser.ts` and `hub/rules/sandbox` call
`usage.ts` and nothing else of this package, so they never pull in the writer. `writer.ts` and `reader.ts` sit above
records: they use its `createPool` and `Database`. `usage.ts` imports neither.

## How a trace works

Outside a trace, or in a process with no sink installed (`startTelemetry` installs one), every function is a no-op that runs
what it was given: code and tests that never start a trace behave as before. Nothing here throws into observed code, and
nothing on a request path waits.

- A step's usage **includes its children's**, added when the child ends. The root row alone totals the trace, and a tree
  read top down shows where the total went. Lines of `trace top` for names nested in each other therefore overlap.
- `self.ms` is derived: the step's duration less `db.ms`, `db.wait_ms`, `sandbox.wait_ms`, `sandbox.ms` and `source.ms`,
  never below zero. It is not CPU time. Work that ran side by side can exceed the wall time, which is why it is clamped.
- The rows of a trace stay in memory until its root ends, at most `MAX_TRACE_STEPS` (2,000) of them; the rest still count
  in their parent's usage and in `steps.dropped` on the root. So what is known late (the user after authentication, the
  run after `start_run`, a trace id from `_meta`) reaches every row. A step that ends after its root is written on its own,
  and a console action that runs on after its request is exactly that.
- `step` passes results and failures through unchanged. A step that fails is marked `error` with the failure's `code`
  when it is a code, else a fixed sentence; the message is never stored, since it can quote a document.
- A process that dies loses its open traces. What it was doing then is the question of step 2 (the in-flight log).

Any code that keeps a waiting line and starts work from another call's context must bind the context of the call that
asked (`AsyncLocalStorage.snapshot()`), or that work runs in the wrong trace. `hub/rules/sandbox/slots.ts` and
`hub/records/staging-slots.ts` do; a line that `await`s a promise (`Semaphore`, the connectors' `Limiter`) needs nothing.

## Entry points

| Entry | Origin | Root name |
| --- | --- | --- |
| `/mcp`, a request that gets a call-log line | `mcp` | the tool, `initialize`, `list-tools` or `handle-mcp` (a ping, a tool nobody has, a refusal at the transport) |
| `/mcp`, an exchange that gets none (a GET, a notification, a request refused before it was identified) | `mcp` | `serve-http` |
| anything under `/console` | `console` | `serve-<first path segment>` when that is a page area, else `serve-console`; `stream-console` for the live updates |
| `/api/sync/…` | `sync` | `sync-<route>`, `serve-sync` before a route is known |
| any other path (`/healthz`, OAuth, local tools, run export) | `console` | `serve-http` |
| CLI commands, platform commands included | `cli` | `run-<command>`, `run-command` for a name the CLI does not know |
| maintenance pass, citation index, knowledge search index, scheduled knowledge sync, console live tick, staging cleanup, lease heartbeat, document projection job, trace retention | `background` | `maintain-runs`, `index-citations`, `index-knowledge`, `sync-knowledge`, `poll-console`, `clean-staging`, `renew-lease`, `project-document`, `purge-traces` |

An HTTP trace starts in `createApp`'s handler, around everything the request does, the last-resort 500 included. The root of
an MCP request has the call log line's trace id and span id, one call one span. `traceparent` is read from the header and,
when no valid header came, from `params._meta.traceparent`; the client's span becomes the root's `parent_span_id`, so
`is_root` says what a root is. A CLI command in a process of its own opens its own connection and has written its trace
when `main` returns; run by the console's bridge inside `serve` it is a step of what the console is doing. Without a
configuration, or with a database it cannot reach, a command runs as it would have and costs only the row.

Not traced, on purpose: the sandbox's resident-size poll (ten rounds a second, measures child processes, reads no database),
the time-to-live of read replies (drops one entry of a map), the deadline in `close()` and the MCP keepalive ticker (both
inside a request or a stop). One-time work before `serve` listens is not a trace either: step 2's process events cover it.

Each row carries the user, session, run, client name, version and platform, release and environment. Client name and version
are what MCP `initialize` declared (decision 137), read through `declaredClient`, else `latestDeclaredClient` for a connection
without a session, and kept per connection in memory (`hub/server/declared-clients.ts`), so a call costs no extra read once
its connection is known; a sync request takes what the same token declared. A request refused before any handler ran (a
DELETE, a 415, a body that never arrived) is read the same way: it is a call of the client that declared itself, and only a
connection that declared nothing has no name. They are declarations and nothing more. The
release is the process's `release.json`, the environment the class in the deployment settings; a data root without
settings has none.

The platform is `clientInfo.platform` of the same `initialize` (decision 147), cleaned and bounded like the name and version
and null when absent. It is diagnostic data and nothing else: it is not in `ClientDeclaration`, so no record holds it and it
binds nothing. So it lives in that memory only, and a connection that outlives a restart has no platform until its next
`initialize`, where its name and version come back from the records.

## Usage

The names are the design's table, plus `steps.dropped`.

- `db.*` at `Database.query`, transactions included (their `BEGIN`, `COMMIT` and `ROLLBACK` count as queries). `db.rows` is
  rows returned, not rows changed. `db.bytes` is the summed length of the top-level strings of the returned rows, in UTF-16
  units: no deep walk, no JSON. A `jsonb` column reaches the code as an object and does not count; `records.body` is text and
  does. `db.wait_ms` needs the wait apart from the query, so inside a trace a pooled query takes its connection itself, with
  the same rule as `pool.query` (a connection whose query fails is dropped); outside a trace `pool.query` runs as before.
  `Database.pool` used directly (`RecordStore.tryHold`, the writer) is not measured.
- A query of a second or more is also an `event` row, `slow-query`, with the statement in `status_message`: never the
  parameters, and quoted literals in the statement replaced. It is the one `status_message` that is not a code or a fixed
  sentence.
- `sandbox.*` per attempt: `sandbox.wait_ms` for the slot, `sandbox.ms` from getting the slot to the end, so that the pack
  scan and the input's serialization are not lost in `self.ms`.
- `source.*` at the two places bytes of a source arrive: `FileObjectStore.get` (per caller: one read may serve several
  traces) and `HttpSource` (each exchange, a failed one too). Bytes read from the database by `get` also count in `db.*`.
- `answer.bytes` from the `content-length` of the response, or the body of an MCP call whose head went out early. A
  response without one (an event stream) has none.

Step names and types: `authenticate` and `check-permission`, `validate-submission` (guardrail), `read-source`,
`compute-view` (retriever), `run-function` (tool), `run-check` (evaluator), `parse-document`, `append-record` (span),
`slow-query` (event). Only meaningful steps: `append-record` wraps the call log line, the stored submission and the
validation result, not every record, and a database query is never a step.

The phases of the two costliest requests are spans too, so a slow one says where it went: `load-workflow`, `freeze-skills`,
`resolve-target`, `bind-inputs`, `read-context`, `project-items`, `bind-expected`, `evaluate-run` and `list-packs` in
`start_run`, and `list-runs`, `load-tasks`, `list-requests`, `read-call-log`, `read-systems`, `read-lines` and `read-storage`
in `serve-overview`.

## Storage and writer

Migration 27, table `trace_spans`, one row per step; primary key `(trace_id, span_id)`. Indexes: `trace_spans_started`
(`started_at`, retention and totals), and three partial ones over roots for the list: `trace_spans_roots` (newest first),
`trace_spans_root_names` and `trace_spans_root_users`. Migration 31 adds `client_platform` and `trace_spans_mcp_releases`, the
MCP roots by release. No enumeration in SQL: rows come only from typed code, and a CHECK
that a new vocabulary value failed would lose whole batches. The runtime role has SELECT, INSERT and DELETE, and no
append-only trigger applies.

The writer queues at most 10,000 rows and writes every 5 seconds or at 500 rows, on a connection of its own, one `INSERT`
per batch (the rows travel as one JSON parameter). A full queue drops the new row and counts it; a batch the database refuses
is lost and counted, and the operator's log hears about it at most once a minute, with the driver's code only, since the
message of a refused statement can quote a row. `stats()` gives queued, written, dropped and failed for the console's 运行状况
page, with the p95 of how long the latest 1,000 rows written waited in the queue and how long the latest batch took: both
measured when a batch is written, and null before the first. `close()` writes what is left, bounded at 5 seconds: `serve` calls
it on a clean stop, a CLI command before it returns.

Retention: `scheduleRetention` runs a traced pass (`purge-traces`) a minute after start and then every hour, deleting rows
that started before the last 14 days, 5,000 at a time.

## Reading

`TraceReader` applies the rule of B08 R[4]: an administrator sees all, a member only rows with their own `user_id`, steps
and usage included. The stored account decides, as in the call log. The rule holds per row: a client may reuse a trace id,
so `show` of an id two members used gives each their own rows. A trace the reader may not see and one that does not exist
give the same null.

```
circle-hub trace list [--origin <入口>] [--name <名字>] [--user <用户>] [--since <ISO时间>] [--min-ms <毫秒>] [--limit <条数>] [--json] [--as <管理员>]
circle-hub trace show <追踪号> [--json] [--as <管理员>]
circle-hub trace top [--by <用量名>] [--since <ISO时间>] [--limit <条数>] [--json] [--as <管理员>]
```

`trace` is an administrator command (`hub/server/cli-trace.ts`): a member's token is refused. `top` defaults to `db.rows` over
the last 24 hours. It sums all steps by name, not only roots, so an expensive inner step ranks too.

The console's 运行状况 page reads three totals, for administrators only (the stored account decides, as above). Each aggregates
in SQL and reads the newest rows up to a bound, because traffic decides how many rows a window holds, and says when it stopped
there (`capped`):

| Read | Runs off | Bound | Returns |
| --- | --- | --- | --- |
| `background` | `trace_spans_root_names`, a range per task | a window, `MAX_ROUNDS_READ` a task, the closed list of tasks | at most one row a task |
| `clients` | `trace_spans_roots` | a window, `MAX_ROOTS_READ` | at most `limit` rows, and how many groups there were |
| `releases` | `trace_spans_mcp_releases` | the retention, the times of each run and its last `windowMs`, `MAX_RELEASE_CALLS_READ` a run | one row a run asked for |

`clients` leaves out what no client calls: background rounds, CLI commands, `stream-console` (it lasts as long as a page stays
open) and `serve-http`. `releases` leaves out `serve-http` too, so on the MCP entry both count the lines of the call log and
nothing else (decision 147: all MCP calls, not per tool). A task's gap is the median of its round starts, so hours with no page open do not stretch the tick of
`poll-console`. `TIMED_BACKGROUND_STEPS` names the rounds a timer starts; the others run when asked and have no interval.

## Decisions and limits

- `is_root` is a column beyond the design's field table: a root's `parent_span_id` holds the client's span, so that the
  client's and the Hub's traces stay joined when forwarding comes (step 4), and the list needs an indexable test for roots.
- CLI, console and sync root names are closed lists like the tool names. A new command or page area falls back to
  `run-command` or `serve-console` until it is added; `names.test.ts` keeps the commands complete.
- Field names follow OpenTelemetry where one exists (`trace_id`, `span_id`, `parent_span_id`, `name`, `status_message`).
- Timestamps come from the system clock, not `deps.now`: a trace says when something really happened, and retention is
  relative to it. Durations come from `performance.now()`; `ended_at` is `started_at` plus that duration.
- Deleting a member leaves their rows until retention: they hold ids and sizes, as the call log does.
- Backups include the table; a restored Hub deletes what is too old at its next pass.

## Needs from other packages

- **contracts**: the display names of the background tasks are local to `hub/server/console/health.ts`, in the words of the
  approved draft, until the model has them. Step and usage names themselves are not vocabulary (`names.ts`).

## Tests

`node --test "hub/telemetry/**/*.test.ts"`: `usage.test.ts`, `names.test.ts` and `writer.test.ts` need no database,
`store.test.ts` uses a temporary PostgreSQL. The entry points are tested where they live: `hub/server/trace.test.ts`,
`hub/server/assemble/cli-trace.test.ts`, `hub/rules/sandbox/usage.test.ts`, `hub/runs/engine/trace-steps.test.ts` and one
test each in `hub/connectors/http.test.ts`, `hub/knowledge/sync-schedule.test.ts`, `hub/knowledge/feeding-bounds.test.ts`,
`hub/dispatch/results.test.ts` and `hub/server/console/staging.test.ts`. No test asserts a duration.
