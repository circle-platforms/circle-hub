// Live updates of the console (the interface doc's 用语与实时更新): GET /console/api/stream answers server-sent events on the
// session of the pages. An event names what changed by id only, never its content, and reaches a stream only when its
// account may see the object, by the rules of the pages: the run (RunsService.getRun), the pack and resource catalogs, the
// readable product lines, administrators for knowledge imports, the member and administrators for a first connection.
// One poller, running only while a stream is open, reads what the database already holds, so a change made by a command in
// another process is seen too: the records appended since the last watermark, by kind, and the tokens of the accounts whose
// MCP calls just appeared in the call log (a token used for the first time is a Circle that completed its connection).
// Knowledge imports of this process signal their start and end directly. A read manifest (a read of a business system
// ended, changing its reads and response times of the last day) is system.status for that system. The state the records hold of a business system
// or a runtime environment is its configuration (added, changed, enabled, disabled: resource_config decisions on its res_
// or executor. id): a later decision is system.status, any decision on an executor environment.status, for administrators.
// Occupancy and freezing come from the dispatch journal: a journal record that can change them (a reservation, an intent,
// an end, a request left uncertain or answered, a disposition, a bed hold) is environment.status for the job's executor,
// read from its reservation. An explicitly timed executor response also changes that environment's call statistics.
// A new business system waits
// until the resource catalog of this process has read it (connectors keeps its list up to 5 s). Every tick checks the session
// without counting as activity and a heartbeat re-authenticates its token: a closed or expired session, a revoked token, a
// disabled account, a reader too far behind or close() ends the stream.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EffectOutcome, PermissionKind } from '../../../contracts/generated/vocabulary.ts';
import { dispatchCallTiming } from '../../dispatch/api.ts';
import { cursorAfter, type Page, type Principal, type RecordKind, type RecordsKit, type StoredRecord } from '../../records/api.ts';
import { setCommonHeaders } from '../http.ts';
import { describeError } from '../notes.ts';
import { background } from '../../telemetry/api.ts';
import { readableLines, type PageContext } from './pages.ts';
import type { ConsoleSession, SessionStore } from './session.ts';

export const LIVE_EVENTS = ['task.updated', 'request.updated', 'environment.status', 'system.status', 'import.progress', 'member.connected', 'system.added', 'pack.published', 'knowledge.published'] as const;
export type LiveEventName = (typeof LIVE_EVENTS)[number];

export interface LiveEvent {
  name: LiveEventName;
  /** Ids only. */
  data: Readonly<Record<string, string | null>>;
}

export interface LiveOptions {
  /** How often the poller checks the sessions and reads the database. */
  pollMs: number;
  /** How often a stream re-authenticates its token and sends a comment line. */
  heartbeatMs: number;
  /** Open streams at most, in total and per session. */
  maxStreams: number;
  maxPerSession: number;
}

export const DEFAULT_LIVE_OPTIONS: LiveOptions = { pollMs: 2_000, heartbeatMs: 25_000, maxStreams: 200, maxPerSession: 4 };

/** The record kinds each event is read from; the other events have no record. */
const SOURCES: Readonly<Partial<Record<LiveEventName, readonly RecordKind[]>>> = {
  'task.updated': ['call_log', 'run', 'submission', 'validation_result', 'effect', 'action', 'claim', 'request'],
  'request.updated': ['request', 'action'],
  'member.connected': ['call_log'],
  'system.added': ['authorization'],
  'system.status': ['authorization', 'action'],
  'environment.status': ['authorization', 'action'],
  'pack.published': ['pack_version'],
  'knowledge.published': ['root_pointer'],
};
/** Records read per kind and tick: pages of PAGE, at most PAGES of them. */
const PAGE = 200;
const PAGES = 5;
/** A tick reads again from this many append positions below the last watermark: a transaction may commit after a later one. */
const MARGIN = 200;
/** Ticks after the last change that still read the margin, so a late commit below an unchanged watermark is seen. */
const SETTLE = 3;
/** Digests already read, for the overlap of the margin. */
const SEEN = 4_000;
/** A reader with this much unsent is dropped; its browser connects again. */
const BACKLOG_BYTES = 64 * 1024;
/** Visibility of a run to an account, kept this long. */
const VERDICT_MS = 30_000;
const RETRY_MS = 5_000;
const QUEUED = 1_000;
/** Held back this long: the resource catalog of this process keeps its list up to 5 s (connectors cacheMs). */
const HOLD_MS: Readonly<Partial<Record<LiveEventName, number>>> = { 'system.added': 6_000, 'system.status': 6_000, 'environment.status': 6_000 };
const LOG_EVERY_MS = 60_000;
const RUN_ID = /^run_[0-9a-z]{26}$/;
const USER_ID = /^usr_[0-9a-z]{26}$/;
const RESOURCE_ID = /^res_[0-9a-z]{26}$/;
/** A runtime environment's configuration object: `executor.<id>` (hub/dispatch). */
const EXECUTOR_OBJECT = /^executor\.([A-Za-z0-9._-]{1,128})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const EXECUTOR_ID = /^exe_[0-9a-hjkmnp-tv-z]{26}$/;
/** The effect outcome of a result nobody could confirm: a job in that state keeps its environment frozen. */
const UNKNOWN_OUTCOME: EffectOutcome = 'unknown';
/** Jobs whose executor this process already read from their reservation. */
const JOB_EXECUTORS = 2_000;
const RESOURCE_CONFIG: PermissionKind = 'resource_config';

/** The events a stream asks for (`?events=a,b`; all when absent); null when one of them is not an event. */
export function wantedEvents(param: string | null): ReadonlySet<LiveEventName> | null {
  if (param === null || param.trim() === '') return new Set(LIVE_EVENTS);
  const names = param.split(',').map((name) => name.trim()).filter(Boolean);
  if (names.length === 0 || names.length > LIVE_EVENTS.length) return null;
  const known: readonly string[] = LIVE_EVENTS;
  return names.every((name) => known.includes(name)) ? new Set(names as LiveEventName[]) : null;
}

const object = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** What one appended record changed. */
export function eventsOf(record: Pick<StoredRecord, 'kind' | 'digest' | 'body'>): LiveEvent[] {
  const body = object(record.body);
  const run = typeof body.run === 'string' && RUN_ID.test(body.run) ? body.run : null;
  const task: LiveEvent[] = run === null ? [] : [{ name: 'task.updated', data: { run } }];
  switch (record.kind) {
    case 'call_log':
    case 'run':
    case 'submission':
    case 'validation_result':
    case 'effect':
    case 'claim':
      return task;
    case 'request':
      return run === null ? [] : [...task, { name: 'request.updated', data: { run, request: record.digest } }];
    case 'action': {
      // A read of a business system ended (its read manifest, hub/connectors): its reads and response times changed.
      const read: LiveEvent[] = typeof body.resource === 'string' && RESOURCE_ID.test(body.resource) && typeof body.started_at === 'string'
        ? [{ name: 'system.status', data: { system: body.resource } }]
        : [];
      // An answer to a request is a validate action naming the request (hub/requests).
      const answered = object(body.detail).request;
      return run !== null && typeof answered === 'string' && SHA256.test(answered) ? [...task, ...read, { name: 'request.updated', data: { run, request: answered } }] : [...task, ...read];
    }
    case 'pack_version':
      return typeof body.pack === 'string' && typeof body.version === 'string' ? [{ name: 'pack.published', data: { pack: body.pack, version: body.version } }] : [];
    case 'root_pointer':
      return typeof body.product === 'string' ? [{ name: 'knowledge.published', data: { product: body.product, line: typeof body.line === 'string' ? body.line : null } }] : [];
    case 'authorization': {
      // A business system is a resource configuration of the whole Hub: the first decision for its id adds it, a later
      // one changes it (enabled, disabled, changed). A runtime environment is the configuration of an executor.
      if (body.permission !== RESOURCE_CONFIG || typeof body.object !== 'string') return [];
      if (RESOURCE_ID.test(body.object)) {
        return body.revoked === false && body.supersedes === null
          ? [{ name: 'system.added', data: { system: body.object } }]
          : [{ name: 'system.status', data: { system: body.object } }];
      }
      const executor = EXECUTOR_OBJECT.exec(body.object);
      return executor === null ? [] : [{ name: 'environment.status', data: { environment: executor[1] } }];
    }
    default:
      return [];
  }
}

/**
 * The job of a dispatch journal record (hub/dispatch, an action of component dispatch@1) that can change its environment's
 * occupancy or freezing (holdsPhysicalTarget, isFrozen), with the executor when the record itself names it (a
 * reservation); null for any other record.
 */
export function environmentTransition(record: Pick<StoredRecord, 'kind' | 'body'>): { job: string; executor: string | null } | null {
  const body = object(record.body);
  if (record.kind !== 'action' || body.component !== 'dispatch@1') return null;
  const detail = object(body.detail);
  const job = typeof detail.job === 'string' && SHA256.test(detail.job) ? detail.job : null;
  if (job === null) return null;
  const phase = detail.phase;
  const changes = phase === 'reservation' || phase === 'intent' || phase === 'probe_intent' || phase === 'bed_hold' || phase === 'dispose'
    || detail.done === true || detail.uncertain === true || detail.unfreeze === true || detail.outcome === UNKNOWN_OUTCOME || dispatchCallTiming(body) !== null;
  if (!changes) return null;
  const executor = object(detail.binding).executor;
  return { job, executor: typeof executor === 'string' && EXECUTOR_ID.test(executor) ? executor : null };
}

/** Whether the account of `ctx` may see what `event` names, by the rules of the pages that show it. */
export async function visibleTo(ctx: PageContext, event: LiveEvent, runVisible: (run: string) => Promise<boolean> = async (run) => (await ctx.deps.runs.getRun(ctx.principal, run)) !== null): Promise<boolean> {
  const data = event.data;
  switch (event.name) {
    case 'task.updated':
    case 'request.updated':
      return typeof data.run === 'string' && runVisible(data.run);
    case 'import.progress':
      return ctx.admin;
    case 'member.connected':
      return ctx.admin || ctx.principal.id === data.user;
    case 'system.added':
    case 'system.status':
      return ctx.admin && (await ctx.deps.resources.list(ctx.principal)).some((system) => system.id === data.system);
    case 'environment.status':
      return ctx.admin;
    case 'pack.published':
      return (await ctx.deps.packs.list(ctx.principal)).some((pack) => pack.id === data.pack);
    case 'knowledge.published':
      return (await readableLines(ctx)).some((line) => line.id === data.product);
    default:
      return false;
  }
}

export interface LiveDeps {
  records: Pick<RecordsKit, 'store' | 'principals'>;
  sessions: SessionStore;
  log: (line: string) => void;
}

export interface StreamInput {
  session: ConsoleSession;
  secure: boolean;
  principal: Principal;
  /** The page context of the session for an account as it authenticates now. */
  context: (principal: Principal) => PageContext;
  wants: ReadonlySet<LiveEventName>;
}

interface Stream {
  session: string;
  secure: boolean;
  token: string;
  wants: ReadonlySet<LiveEventName>;
  context: (principal: Principal) => PageContext;
  ctx: PageContext;
  response: ServerResponse;
  beat: number;
  ended: boolean;
  done: () => void;
}

export class LiveEvents {
  readonly #deps: LiveDeps;
  readonly #options: LiveOptions;
  readonly #streams = new Set<Stream>();
  readonly #seen = new Set<string>();
  readonly #verdicts = new Map<string, { visible: boolean; at: number }>();
  #queue: LiveEvent[] = [];
  #held: { at: number; event: LiveEvent }[] = [];
  #timer: NodeJS.Timeout | null = null;
  #closed = false;
  /** Watermark of the last read, and the one polling started at (nothing at or below it is new); null while idle. */
  #mark: number | null = null;
  #floor = 0;
  #settle = 0;
  /** Whether each token had been used, from when member.connected was first wanted; null until then. */
  #tokens: Map<string, boolean> | null = null;
  /** The executor of each dispatch job seen, from its reservation (bounded). */
  readonly #executors = new Map<string, string | null>();
  /** The first tick after idle runs at once, so the baselines are taken when the first stream opens. */
  #fresh = true;
  /** Counts the idle resets: a tick that began before one writes nothing after it. */
  #generation = 0;
  #logged = 0;

  constructor(deps: LiveDeps, options: Partial<LiveOptions> = {}) {
    this.#deps = deps;
    this.#options = { ...DEFAULT_LIVE_OPTIONS, ...options };
  }

  /** Open streams, for the Hub's own resource sampling. */
  get streams(): number {
    return this.#streams.size;
  }

  /** Why a new stream of `session` is refused, or null. */
  refusal(session: string): { status: number; message: string; fix: string } | null {
    if (this.#closed) return { status: 503, message: 'Hub 正在停止，实时更新暂不可用', fix: '服务恢复后刷新页面' };
    let own = 0;
    for (const stream of this.#streams) if (stream.session === session) own += 1;
    if (own >= this.#options.maxPerSession || this.#streams.size >= this.#options.maxStreams) {
      return { status: 429, message: '实时更新的连接数已达上限', fix: '关闭不用的控制台页面后重试；页面内容仍可刷新查看' };
    }
    return null;
  }

  /** Answers the stream and resolves when it ends. */
  serve(request: IncomingMessage, response: ServerResponse, input: StreamInput): Promise<void> {
    request.resume();
    setCommonHeaders(response);
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      'x-accel-buffering': 'no',
    });
    if (request.method === 'HEAD') {
      response.end();
      return Promise.resolve();
    }
    response.write(`retry: ${RETRY_MS}\n\n`);
    return new Promise<void>((resolve) => {
      const stream: Stream = {
        session: input.session.id,
        secure: input.secure,
        token: input.session.token,
        wants: input.wants,
        context: input.context,
        ctx: input.context(input.principal),
        response,
        beat: Date.now(),
        ended: false,
        done: resolve,
      };
      this.#streams.add(stream);
      response.on('close', () => this.#end(stream));
      // A reader that left before the stream was registered ends it at once.
      if (response.destroyed) return this.#end(stream);
      this.#schedule();
    });
  }

  /** An event of this process (knowledge imports), sent with the next tick. */
  publish(event: LiveEvent): void {
    if (this.#streams.size === 0) return;
    this.#queue.push(event);
    if (this.#queue.length > QUEUED) this.#queue.splice(0, this.#queue.length - QUEUED);
  }

  /** Ends every stream and stops the poller; later streams are refused. */
  close(): void {
    this.#closed = true;
    for (const stream of [...this.#streams]) this.#end(stream);
    this.#idle();
  }

  #end(stream: Stream): void {
    if (stream.ended) return;
    stream.ended = true;
    this.#streams.delete(stream);
    if (!stream.response.writableEnded) stream.response.end();
    stream.done();
    if (this.#streams.size === 0) this.#idle();
  }

  #idle(): void {
    this.#generation += 1;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#mark = null;
    this.#tokens = null;
    this.#settle = 0;
    this.#fresh = true;
    this.#seen.clear();
    this.#verdicts.clear();
    this.#queue = [];
    this.#held = [];
  }

  #schedule(): void {
    if (this.#timer !== null || this.#closed || this.#streams.size === 0) return;
    const timer = setTimeout(() => {
      void background('poll-console', () => this.#tick())
        .catch((error: unknown) => this.#problem(error))
        .finally(() => {
          if (this.#timer === timer) this.#timer = null;
          this.#schedule();
        });
    }, this.#fresh ? 0 : this.#options.pollMs);
    this.#fresh = false;
    timer.unref();
    this.#timer = timer;
  }

  #problem(error: unknown): void {
    const now = Date.now();
    if (now - this.#logged < LOG_EVERY_MS) return;
    this.#logged = now;
    this.#deps.log(`实时更新读取失败：${describeError(error)}`);
  }

  #send(stream: Stream, text: string): void {
    if (stream.ended) return;
    if (stream.response.destroyed || stream.response.writableLength > BACKLOG_BYTES) return this.#end(stream);
    stream.response.write(text);
  }

  async #tick(): Promise<void> {
    const now = Date.now();
    const generation = this.#generation;
    for (const stream of [...this.#streams]) {
      if (this.#deps.sessions.peek(stream.session, stream.secure) === null) {
        this.#end(stream);
        continue;
      }
      if (now - stream.beat < this.#options.heartbeatMs) continue;
      stream.beat = now;
      const principal = await this.#deps.records.principals.authenticate(`Bearer ${stream.token}`);
      if (stream.ended) continue;
      if (principal === null) {
        // As a page does: a token that stopped working ends the session.
        this.#deps.sessions.close(stream.session);
        this.#end(stream);
        continue;
      }
      stream.ctx = stream.context(principal);
      this.#send(stream, ': ping\n\n');
    }
    if (this.#streams.size === 0 || generation !== this.#generation) return;
    const wants = new Set<LiveEventName>();
    for (const stream of this.#streams) for (const name of stream.wants) wants.add(name);
    const read = await this.#read(wants, generation);
    if (generation !== this.#generation) return;
    const events = this.#queue.splice(0);
    for (const event of read) {
      const hold = HOLD_MS[event.name];
      if (hold === undefined) events.push(event);
      // A busy system ends many reads a second: one held event per system is enough.
      else if (!this.#held.some((entry) => entry.event.name === event.name && JSON.stringify(entry.event.data) === JSON.stringify(event.data))) this.#held.push({ at: now + hold, event });
    }
    const due = this.#held.filter((entry) => entry.at <= now);
    this.#held = this.#held.filter((entry) => entry.at > now);
    events.push(...due.map((entry) => entry.event));
    await this.#deliver(events);
  }

  /** New records of the wanted kinds since the last tick, and the first connections of the accounts that called. */
  async #read(wants: ReadonlySet<LiveEventName>, generation: number): Promise<LiveEvent[]> {
    const kinds = new Set<RecordKind>();
    for (const name of wants) for (const kind of SOURCES[name] ?? []) kinds.add(kind);
    const store = this.#deps.records.store;
    if (kinds.size === 0 || store.watermark === undefined) return [];
    const connections = wants.has('member.connected');
    const mark = await store.watermark();
    const use = this.#tokens === null && connections ? await this.#tokenUse() : null;
    if (generation !== this.#generation) return [];
    if (use !== null) this.#tokens = use;
    if (this.#mark === null) {
      this.#mark = mark;
      this.#floor = mark;
      return [];
    }
    if (mark !== this.#mark) this.#settle = SETTLE;
    else if (this.#settle > 0) this.#settle -= 1;
    else return [];
    const after = Math.max(this.#floor, this.#mark - MARGIN);
    this.#mark = mark;
    const events: LiveEvent[] = [];
    const callers = new Set<string>();
    const environments = wants.has('environment.status');
    const transitions: { job: string; executor: string | null }[] = [];
    for (const kind of kinds) {
      let cursor: string | null = cursorAfter(after);
      for (let page = 0; page < PAGES && cursor !== null; page += 1) {
        const listed: Page<StoredRecord> = await store.list({ kind, cursor, limit: PAGE });
        if (generation !== this.#generation) return [];
        for (const record of listed.items) {
          if (this.#seen.has(record.digest)) continue;
          this.#seen.add(record.digest);
          if (this.#seen.size > SEEN) this.#seen.delete(this.#seen.values().next().value!);
          events.push(...eventsOf(record));
          const transition = environments ? environmentTransition(record) : null;
          if (transition !== null) {
            transitions.push(transition);
            // A reservation names its executor: the job's later records are resolved without reading it again.
            if (transition.executor !== null) this.#remember(transition.job, transition.executor);
          }
          const user = object(record.body).user;
          if (record.kind === 'call_log' && typeof user === 'string' && USER_ID.test(user)) callers.add(user);
        }
        cursor = listed.next;
      }
    }
    if (connections && this.#tokens !== null) {
      for (const user of callers) if (await this.#connected(this.#tokens, user)) events.push({ name: 'member.connected', data: { user } });
    }
    const changed = new Set<string>();
    for (const transition of transitions) {
      const executor = transition.executor ?? (await this.#executorOf(transition.job));
      if (generation !== this.#generation) return [];
      if (executor !== null) changed.add(executor);
    }
    for (const environment of changed) events.push({ name: 'environment.status', data: { environment } });
    return events;
  }

  /** The executor a dispatch job was reserved on, from its reservation record; null when none names one. */
  async #executorOf(job: string): Promise<string | null> {
    if (this.#executors.has(job)) return this.#executors.get(job)!;
    let executor: string | null = null;
    try {
      const events = await this.#deps.records.store.findMany<{ detail?: unknown }>({ kind: 'action', key: 'dispatch.job', values: [job] });
      for (const event of events) {
        const named = environmentTransition({ kind: 'action', body: event.body })?.executor ?? null;
        if (named !== null) {
          executor = named;
          break;
        }
      }
    } catch {
      return null;
    }
    this.#remember(job, executor);
    return executor;
  }

  #remember(job: string, executor: string | null): void {
    this.#executors.set(job, executor);
    if (this.#executors.size > JOB_EXECUTORS) this.#executors.delete(this.#executors.keys().next().value!);
  }

  async #tokenUse(): Promise<Map<string, boolean>> {
    const principals = this.#deps.records.principals;
    const use = new Map<string, boolean>();
    for (const user of await principals.list()) for (const token of await principals.tokens(user.id)) use.set(token.id, token.last_used_at !== null);
    return use;
  }

  /** True when a live token of `user` has been used since it was last seen unused (or since it was issued). */
  async #connected(use: Map<string, boolean>, user: string): Promise<boolean> {
    let first = false;
    for (const token of await this.#deps.records.principals.tokens(user)) {
      const used = token.last_used_at !== null;
      if (used && token.revoked_at === null && use.get(token.id) !== true) first = true;
      use.set(token.id, used);
    }
    return first;
  }

  async #deliver(events: readonly LiveEvent[]): Promise<void> {
    const unique = new Map<string, LiveEvent>();
    for (const event of events) unique.set(`${event.name} ${JSON.stringify(event.data)}`, event);
    if (unique.size === 0) return;
    const verdicts = new Map<string, Promise<boolean>>();
    for (const stream of [...this.#streams]) {
      for (const [key, event] of unique) {
        if (stream.ended || !stream.wants.has(event.name)) continue;
        const principal = stream.ctx.principal;
        const asked = `${principal.id} ${principal.role} ${key}`;
        let verdict = verdicts.get(asked);
        if (verdict === undefined) {
          const ctx = stream.ctx;
          verdict = visibleTo(ctx, event, (run) => this.#runVisible(ctx, run)).catch((error: unknown) => {
            this.#problem(error);
            return false;
          });
          verdicts.set(asked, verdict);
        }
        if (await verdict) this.#send(stream, `event: ${event.name}\ndata: ${JSON.stringify(event.data)}\n\n`);
      }
    }
  }

  async #runVisible(ctx: PageContext, run: string): Promise<boolean> {
    const key = `${ctx.principal.id} ${ctx.principal.role} ${run}`;
    const now = Date.now();
    const kept = this.#verdicts.get(key);
    if (kept !== undefined && now - kept.at < VERDICT_MS) return kept.visible;
    const visible = (await ctx.deps.runs.getRun(ctx.principal, run)) !== null;
    this.#verdicts.set(key, { visible, at: now });
    if (this.#verdicts.size > SEEN) this.#verdicts.delete(this.#verdicts.keys().next().value!);
    return visible;
  }
}
