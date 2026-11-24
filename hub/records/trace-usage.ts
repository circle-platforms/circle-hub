import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { StepLevel, StepType, TraceOrigin } from '../../contracts/generated/vocabulary.ts';
import { ACCOUNTED_USAGE, type StepName, type UsageName } from './trace-names.ts';

export type Usage = Partial<Record<UsageName, number>>;

export interface SpanRow {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  is_root: boolean;
  name: StepName;
  type: StepType;
  started_at: string;
  ended_at: string;
  level: StepLevel;
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
  held: Step[] | null;
  dropped: number;
}

interface Step {
  trace: Trace;
  parent: Step | null;
  spanId: string;
  name: StepName;
  type: StepType;
  startedAt: number;
  started: number;
  durationMs: number;
  usage: Usage;
  level: StepLevel;
  status: string | null;
  ended: boolean;
}

export const SLOW_QUERY_MS = 1000;
export const MAX_TRACE_STEPS = 2000;
export const MAX_STATUS_LENGTH = 1000;
const FAILED_STEP = '步骤出错';
const CODE = /^[A-Za-z0-9_.:-]{1,100}$/;

const storage = new AsyncLocalStorage<Step>();
let installed: TraceSink | null = null;

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

function open(): Step | null {
  let current = storage.getStore() ?? null;
  while (current !== null && current.ended) current = current.parent;
  return current;
}

const rootOf = (current: Step): Step => current.trace.root ?? current;

export const tracing = (): boolean => open() !== null;

export function currentTrace(): { traceId: string; rootSpanId: string } | null {
  const current = open();
  return current === null ? null : { traceId: current.trace.id, rootSpanId: rootOf(current).spanId };
}

const add = (usage: Usage, name: UsageName, value: number): void => {
  usage[name] = (usage[name] ?? 0) + value;
};

export function addUsage(name: UsageName, value: number): void {
  const current = open();
  if (current !== null) add(current.usage, name, value);
}

function begin(trace: Trace, parent: Step | null, name: StepName, type: StepType, startedAt = Date.now()): Step {
  return { trace, parent, spanId: randomHex(8), name, type, startedAt, started: performance.now(), durationMs: 0, usage: {}, level: 'default', status: null, ended: false };
}

const rounded = (value: number): number => Math.round(value * 1000) / 1000;

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
  }
}

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
  traceId?: string | null;
  parentSpanId?: string | null;
}

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

export function background<T>(name: StepName, work: () => T): T {
  return startTrace({ name, origin: 'background' }, work);
}

export function step<T>(name: StepName, work: () => T, options: { type?: StepType } = {}): T {
  const parent = open();
  if (parent === null) return work();
  return enter(begin(parent.trace, parent, name, options.type ?? 'span'), work);
}

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

export function setTraceStatus(level: StepLevel, message: string): void {
  const current = open();
  if (current === null) return;
  const root = rootOf(current);
  if (root.status !== null) return;
  root.level = level;
  root.status = safeText(message);
}

export function withoutTrace<T>(work: () => T): T {
  return storage.exit(work);
}

function statementOf(text: string): string {
  return text.replace(/'(?:[^']|'')*'/g, "'?'").replace(/\s+/g, ' ').trim();
}

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

export function recordSourceRead(bytes: number, ms: number): void {
  const current = open();
  if (current === null) return;
  add(current.usage, 'source.reads', 1);
  add(current.usage, 'source.bytes', bytes);
  add(current.usage, 'source.ms', ms);
}
