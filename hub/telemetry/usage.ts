// The trace context of this process (B08, decision 146): which trace and step the running code belongs to, on
// AsyncLocalStorage, and the usage added to that step. Every package may import this file, the lowest ones included
// (hub/records/db.ts, hub/rules/sandbox): it depends on Node and on types only, never on the writer. Outside a trace, or
// with no sink installed, every function here is a no-op that runs what it was given, so code and tests that never start a
// trace behave as before. Nothing here throws into the code it observes, and nothing waits: a finished trace is handed to
// the sink, which queues it.
//
// A step's usage includes its children's (added when a child ends), so the root row alone totals the trace. The rows of a
// trace stay here until its root ends, so that what is only known late (the user, the run, a trace id from the request
// body) reaches every row; a step that ends after its root is handed over on its own. A process that dies takes the open
// traces with it: what it was doing then is the in-flight log's question (design section 5), not this file's.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { StepLevel, StepType, TraceOrigin } from '../../contracts/generated/vocabulary.ts';
import { ACCOUNTED_USAGE, type StepName, type UsageName } from './names.ts';

export type Usage = Partial<Record<UsageName, number>>;

/** One row of trace_spans, without what the writer stamps on every row of this process (release, environment). */
export interface SpanRow {
  trace_id: string;
  span_id: string;
  /** The enclosing step; on a root the client's span from `traceparent`, when it sent one. */
  parent_span_id: string | null;
  is_root: boolean;
  name: StepName;
  type: StepType;
  started_at: string;
  ended_at: string;
  level: StepLevel;
  /** An error code or a fixed sentence, never business text; a slow query's statement text. */
  status_message: string | null;
  origin: TraceOrigin;
  user_id: string | null;
  session_id: string | null;
  run_id: string | null;
  client_name: string | null;
  client_version: string | null;
  client_platform: string | null;
  usage: Usage;
}

/** Where finished rows go. `push` must not wait and must not throw; the writer's bounded queue is one. */
export interface TraceSink {
  push(row: SpanRow): void;
}

interface Trace {
  id: string;
  remoteParent: string | null;
  origin: TraceOrigin;
  sink: TraceSink;
  userId: string | null;
  sessionId: string | null;
  runId: string | null;
  clientName: string | null;
  clientVersion: string | null;
  clientPlatform: string | null;
  root: Step | null;
  /** Finished steps waiting for the root; null once the root has ended. */
  held: Step[] | null;
  dropped: number;
}

interface Step {
  trace: Trace;
  parent: Step | null;
  spanId: string;
  name: StepName;
  type: StepType;
  /** Epoch milliseconds. */
  startedAt: number;
  /** performance.now() at the start. */
  started: number;
  durationMs: number;
  usage: Usage;
  level: StepLevel;
  status: string | null;
  ended: boolean;
}

/** A query that took longer is also an `event` row. */
export const SLOW_QUERY_MS = 1000;
/** Steps one trace keeps; the rest still count in their parent's usage and in `steps.dropped`. */
export const MAX_TRACE_STEPS = 2000;
export const MAX_STATUS_LENGTH = 1000;
const FAILED_STEP = '步骤出错';
const CODE = /^[A-Za-z0-9_.:-]{1,100}$/;

const storage = new AsyncLocalStorage<Step>();
let installed: TraceSink | null = null;

/** Sends the traces of this process to `sink` from now on; the function it returns takes it away again. */
export function installTraceSink(sink: TraceSink): () => void {
  installed = sink;
  return () => {
    if (installed === sink) installed = null;
  };
}

export const traceSinkInstalled = (): boolean => installed !== null;

function randomHex(bytes: number): string {
  for (;;) {
    const id = randomBytes(bytes).toString('hex');
    if (!/^0+$/.test(id)) return id;
  }
}

/** The step usage goes to now: the current one, or its nearest ancestor still open (what outlives its step). */
function open(): Step | null {
  let current = storage.getStore() ?? null;
  while (current !== null && current.ended) current = current.parent;
  return current;
}

const rootOf = (current: Step): Step => current.trace.root ?? current;

/** True inside a trace: a measurement outside one is not worth taking. */
export const tracing = (): boolean => open() !== null;

/** The ids of the running trace and of its root step, null outside a trace. */
export function currentTrace(): { traceId: string; rootSpanId: string } | null {
  const current = open();
  return current === null ? null : { traceId: current.trace.id, rootSpanId: rootOf(current).spanId };
}

const add = (usage: Usage, name: UsageName, value: number): void => {
  usage[name] = (usage[name] ?? 0) + value;
};

/** Adds to the current step's usage; a no-op outside a trace. */
export function addUsage(name: UsageName, value: number): void {
  const current = open();
  if (current !== null) add(current.usage, name, value);
}

function begin(trace: Trace, parent: Step | null, name: StepName, type: StepType, startedAt = Date.now()): Step {
  return { trace, parent, spanId: randomHex(8), name, type, startedAt, started: performance.now(), durationMs: 0, usage: {}, level: 'default', status: null, ended: false };
}

const rounded = (value: number): number => Math.round(value * 1000) / 1000;

/** Text jsonb can carry, so that one row cannot lose the batch it is written with: well-formed, no NUL, bounded. */
const safeText = (text: string): string => text.slice(0, MAX_STATUS_LENGTH).toWellFormed().replaceAll('\0', '');

function rowOf(trace: Trace, finished: Step): SpanRow {
  const isRoot = finished === trace.root;
  const usage: Usage = {};
  for (const [name, value] of Object.entries(finished.usage) as [UsageName, number][]) usage[name] = rounded(value);
  return {
    trace_id: trace.id,
    span_id: finished.spanId,
    parent_span_id: isRoot ? trace.remoteParent : finished.parent?.spanId ?? null,
    is_root: isRoot,
    name: finished.name,
    type: finished.type,
    started_at: new Date(finished.startedAt).toISOString(),
    ended_at: new Date(finished.startedAt + finished.durationMs).toISOString(),
    level: finished.level,
    status_message: finished.status,
    origin: trace.origin,
    user_id: trace.userId,
    session_id: trace.sessionId,
    run_id: trace.runId,
    client_name: trace.clientName,
    client_version: trace.clientVersion,
    client_platform: trace.clientPlatform,
    usage,
  };
}

function hand(trace: Trace, rows: readonly Step[]): void {
  try {
    for (const row of rows) trace.sink.push(rowOf(trace, row));
  } catch {
    // Observation never changes the observed: a sink that fails loses these rows and nothing else.
  }
}

/** Keeps a finished step for its root, or hands it over when the root has already gone. */
function keep(finished: Step): void {
  const { trace } = finished;
  if (trace.held === null) hand(trace, [finished]);
  else if (trace.held.length < MAX_TRACE_STEPS) trace.held.push(finished);
  else trace.dropped += 1;
}

function finish(current: Step): void {
  if (current.ended) return;
  current.ended = true;
  current.durationMs = performance.now() - current.started;
  let accounted = 0;
  for (const name of ACCOUNTED_USAGE) accounted += current.usage[name] ?? 0;
  current.usage['self.ms'] = Math.max(0, current.durationMs - accounted);
  let above = current.parent;
  while (above !== null && above.ended) above = above.parent;
  if (above !== null) {
    for (const [name, value] of Object.entries(current.usage) as [UsageName, number][]) if (name !== 'self.ms') add(above.usage, name, value);
  }
  const { trace } = current;
  if (current !== trace.root) return keep(current);
  if (trace.dropped > 0) current.usage['steps.dropped'] = trace.dropped;
  const held = trace.held ?? [];
  trace.held = null;
  hand(trace, [...held, current]);
}

function failed(current: Step, error: unknown): void {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  current.level = 'error';
  current.status ??= typeof code === 'string' && CODE.test(code) ? code : FAILED_STEP;
}

/** Runs `work` as `current`, ending it when `work` returns or, for a promise, settles; the result is `work`'s own. */
function enter<T>(current: Step, work: () => T): T {
  let result: T;
  try {
    result = storage.run(current, work);
  } catch (error) {
    failed(current, error);
    finish(current);
    throw error;
  }
  if (typeof (result as { then?: unknown } | null | undefined)?.then === 'function') {
    (result as PromiseLike<unknown>).then(
      () => finish(current),
      (error: unknown) => {
        failed(current, error);
        finish(current);
      },
    );
  } else {
    finish(current);
  }
  return result;
}

export interface TraceOptions {
  name: StepName;
  origin: TraceOrigin;
  /** A W3C trace id and the client's span, when the caller sent them; else a new trace id. */
  traceId?: string | null;
  parentSpanId?: string | null;
}

/** Runs `work` as a new trace, inside a trace too: that one stays as it was. Without a sink it only runs `work`. */
export function startTrace<T>(options: TraceOptions, work: () => T): T {
  const sink = installed;
  if (sink === null) return work();
  const trace: Trace = {
    id: options.traceId ?? randomHex(16), remoteParent: options.parentSpanId ?? null, origin: options.origin, sink,
    userId: null, sessionId: null, runId: null, clientName: null, clientVersion: null, clientPlatform: null, root: null, held: [], dropped: 0,
  };
  trace.root = begin(trace, null, options.name, 'span');
  return enter(trace.root, work);
}

/** One round of a background task: a trace of its own, whatever context the timer that started it inherited. */
export function background<T>(name: StepName, work: () => T): T {
  return startTrace({ name, origin: 'background' }, work);
}

/** Runs `work` as a step of the current trace; outside a trace it only runs `work`. Failures pass through unchanged. */
export function step<T>(name: StepName, work: () => T, options: { type?: StepType } = {}): T {
  const parent = open();
  if (parent === null) return work();
  return enter(begin(parent.trace, parent, name, options.type ?? 'span'), work);
}

/** A row that says something happened in the current step: type `event`, its duration given, `message` in status_message. */
export function addEvent(name: StepName, level: StepLevel, message: string, durationMs = 0): void {
  const parent = open();
  if (parent === null) return;
  const row = begin(parent.trace, parent, name, 'event', Date.now() - Math.round(durationMs));
  row.durationMs = durationMs;
  row.level = level;
  row.status = safeText(message);
  row.ended = true;
  keep(row);
}

export interface TraceFields {
  /** A root step's name, once the request says what it is. */
  name?: StepName;
  traceId?: string;
  parentSpanId?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  clientName?: string | null;
  clientVersion?: string | null;
  clientPlatform?: string | null;
}

/** Sets what only became known on the way; it reaches every row of the trace. A no-op outside a trace. */
export function updateTrace(fields: TraceFields): void {
  const current = open();
  if (current === null) return;
  const { trace } = current;
  if (fields.name !== undefined) rootOf(current).name = fields.name;
  if (fields.traceId !== undefined) trace.id = fields.traceId;
  if (fields.parentSpanId !== undefined) trace.remoteParent = fields.parentSpanId;
  if (fields.userId !== undefined) trace.userId = fields.userId;
  if (fields.sessionId !== undefined) trace.sessionId = fields.sessionId;
  if (fields.runId !== undefined) trace.runId = fields.runId;
  if (fields.clientName !== undefined) trace.clientName = fields.clientName === null ? null : safeText(fields.clientName);
  if (fields.clientVersion !== undefined) trace.clientVersion = fields.clientVersion === null ? null : safeText(fields.clientVersion);
  if (fields.clientPlatform !== undefined) trace.clientPlatform = fields.clientPlatform === null ? null : safeText(fields.clientPlatform);
}

/** Marks the root step: `message` is an error code or a fixed sentence. The first mark stays. */
export function setTraceStatus(level: StepLevel, message: string): void {
  const current = open();
  if (current === null) return;
  const root = rootOf(current);
  if (root.status !== null) return;
  root.level = level;
  root.status = safeText(message);
}

/** Runs `work` outside any trace: the writer's own work is not usage of whoever filled its queue. */
export function withoutTrace<T>(work: () => T): T {
  return storage.exit(work);
}

/** The statement of a query as a row may show it: never parameters, and no quoted literal the statement itself holds. */
function statementOf(text: string): string {
  return text.replace(/'(?:[^']|'')*'/g, "'?'").replace(/\s+/g, ' ').trim();
}

/** Rows are read as they are: the length of their top-level strings. A jsonb column is an object here and not walked. */
function stringLength(rows: readonly object[]): number {
  let total = 0;
  for (const row of rows) {
    for (const key in row) {
      const value = (row as Record<string, unknown>)[key];
      if (typeof value === 'string') total += value.length;
    }
  }
  return total;
}

/** The usage of one database query: `rows` is what it returned, absent when it failed. */
export function recordQuery(text: string, rows: readonly object[] | undefined, ms: number, waitMs: number): void {
  const current = open();
  if (current === null) return;
  const { usage } = current;
  add(usage, 'db.queries', 1);
  add(usage, 'db.ms', ms);
  if (waitMs > 0) add(usage, 'db.wait_ms', waitMs);
  if (Array.isArray(rows)) {
    add(usage, 'db.rows', rows.length);
    add(usage, 'db.bytes', stringLength(rows));
  }
  if (ms >= SLOW_QUERY_MS) addEvent('slow-query', 'warning', statementOf(text), ms);
}

/** The usage of one read of source bytes. */
export function recordSourceRead(bytes: number, ms: number): void {
  const current = open();
  if (current === null) return;
  add(current.usage, 'source.reads', 1);
  add(current.usage, 'source.bytes', bytes);
  add(current.usage, 'source.ms', ms);
}
