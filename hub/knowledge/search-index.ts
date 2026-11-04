// The background build of the knowledge search index. A search only reads what is ready (spaces.ts) and names the rest in its
// warnings; a version that appears outside a write transaction, a product root above all, is built here, in bounded batches
// that yield the event loop, as one traced round at a time (hub/telemetry). Stored rows are the whole state of a build: a
// reference that exists is never read again, so a round that stopped, or a process that restarted, goes on from where it was.
// A version that passed a limit is refused once and stays refused, in the same rows, until that limit rises.
import { RecordsError, pathKey, type SpaceIndexScope, type SpaceSearchDocument, type SpaceSearchIndex, type SpaceSearchRow } from '../records/api.ts';
import { background, setTraceStatus } from '../telemetry/api.ts';
import { KnowledgeError } from './errors.ts';

/** Rows of one batch: one transaction, a fixed handful of statements. */
export const INDEX_BATCH_ROWS = 256;
/** The longest stretch of tokenizing between two turns of the event loop. */
export const INDEX_SLICE_MS = 5;
/** How often an idle Hub looks at its pointers for a new product root; that look is all an idle round costs. */
export const INDEX_TICK_MS = 60_000;
/** A round that failed is tried again after INDEX_TICK_MS, twice as late each time, at most after this long. */
export const INDEX_RETRY_MAX_MS = 3_600_000;
/** Scopes remembered as counted in this process; past it they are counted once more. */
const VERIFIED_SCOPES = 4096;

/** One row of a batch before anything is read. `text` is there when the scope holds the content already. */
export interface IndexRow {
  space: string;
  path: string;
  entry: string;
  record?: string;
  text?: () => string;
}

/** A row ready to write: its record and, for a record without a document yet, the text to tokenize. */
export type IndexedRow = Omit<SpaceSearchRow, 'version'> & { text?: string };

export interface IndexScope extends SpaceIndexScope {
  batches(): AsyncIterable<IndexRow[]>;
  /** The rows to write; a row whose entry cannot be read is left out, or the read throws, as the scope's content requires. */
  read(rows: readonly IndexRow[]): Promise<IndexedRow[]>;
  /** Writes one batch. False: this version may no longer be indexed (its owner's content was purged) and the build stops. */
  write(rows: Array<Omit<SpaceSearchRow, 'version'> & { document?: SpaceSearchDocument }>): Promise<boolean>;
}

export interface IndexSource {
  /** The team space and its product mounts, then these members' spaces, or every member's for null. One that cannot be read goes to `failed`. */
  scopes(spaces: readonly string[] | null, failed: (error: unknown) => void): Promise<IndexScope[]>;
  /** Changes when a product's current root may have moved. */
  marker(): Promise<string>;
}

export interface IndexRoundOutcome {
  /** Scopes completed in this round. */
  built: number;
  /** Scopes that passed a limit in this round. */
  refused: number;
  /** Scopes that failed and are tried again. */
  failed: number;
}

/** Lets timers and sockets run: what keeps a request from waiting behind a build. */
export const yieldLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const keyOf = (scope: SpaceIndexScope): string => scope.version + '\0' + scope.path;
const passedLimit = (error: unknown): error is RecordsError => error instanceof RecordsError && error.code === 'SPACE_INDEX_LIMIT';

/** Writes the references one scope does not have yet. False when the scope said to stop. */
export async function buildScope(index: SpaceSearchIndex, scope: IndexScope, signal: AbortSignal): Promise<boolean> {
  for await (const batch of scope.batches()) {
    signal.throwIfAborted();
    const present = await index.present(scope.version, batch);
    const wanted = batch.filter((row) => !present.has(pathKey(row)));
    if (wanted.length > 0) {
      const rows = await scope.read(wanted);
      const prepared: Array<Omit<SpaceSearchRow, 'version'> & { document?: SpaceSearchDocument }> = [];
      let slice = performance.now();
      for (const { text, ...row } of rows) {
        prepared.push(text === undefined ? row : { ...row, document: index.document(text) });
        if (performance.now() - slice >= INDEX_SLICE_MS) {
          await yieldLoop();
          signal.throwIfAborted();
          slice = performance.now();
        }
      }
      if (!(await scope.write(prepared))) return false;
    }
    await yieldLoop();
  }
  await index.complete(scope.version, scope.path);
  return true;
}

export class SearchIndexer {
  readonly #source: IndexSource;
  readonly #index: () => SpaceSearchIndex | undefined;
  #log: (detail: string) => void = () => {};
  #controller: AbortController | null = null;
  #loop: Promise<void> | null = null;
  /** Wakes the loop from its sleep. */
  #wake: (() => void) | null = null;
  /** The next round visits every member's space. */
  #sweep = true;
  /** Members' spaces a search found not ready. */
  #spaces = new Set<string>();
  /** A request came: a round is wanted whatever the pointers say. */
  #again = false;
  /** Not zero while rounds fail: how long the loop sleeps before the next one. */
  #retryMs = 0;
  #marker: string | null = null;
  /** Rounds, the loop's and `round()`'s alike, run one at a time. */
  #turn: Promise<unknown> = Promise.resolve();
  /** Scopes whose references were counted in this process; a damaged one is found once, here and never in a search. */
  #verified = new Set<string>();
  /** Ready scopes a round proved damaged; the proof holds until a count comes out right, so a repair that failed does not end it. */
  #repairing = new Set<string>();

  constructor(source: IndexSource, index: () => SpaceSearchIndex | undefined) {
    this.#source = source;
    this.#index = index;
  }

  /** From the server's start: a first round over every space, then rounds as versions appear. */
  start(log?: (detail: string) => void): void {
    if (this.#controller !== null) return;
    if (log !== undefined) this.#log = log;
    this.#controller = new AbortController();
    this.#sweep = true;
    this.#loop = this.#run(this.#controller.signal);
  }

  /** Stops at the next batch and waits for that; what is written stays and the next start goes on from there. */
  async stop(): Promise<void> {
    this.#controller?.abort();
    this.#wake?.();
    await this.#loop;
    this.#controller = null;
    this.#loop = null;
  }

  /**
   * Asks for a round; it never waits and does no work here. The loop runs in the context it started in, so the round is
   * nobody's request. A space named is visited even when the round is not a sweep. Rounds that fail keep their own pace.
   */
  request(space?: string): void {
    if (space !== undefined) this.#spaces.add(space);
    this.#again = true;
    if (this.#retryMs === 0) this.#wake?.();
  }

  /** True from the round that proved a ready scope damaged until a repair succeeds: a search does not rely on it meanwhile. */
  repairing(scope: SpaceIndexScope): boolean {
    return this.#repairing.has(keyOf(scope));
  }

  /** One round over every space, now, as its own trace. For a test or a measurement; a request never waits for this. */
  round(): Promise<IndexRoundOutcome> {
    return this.#once(null, new AbortController().signal);
  }

  #once(spaces: readonly string[] | null, signal: AbortSignal): Promise<IndexRoundOutcome> {
    const round = this.#turn.then(() => background('index-knowledge', () => this.#round(spaces, signal)));
    this.#turn = round.catch(() => {});
    return round;
  }

  async #run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const marker = await this.#source.marker();
        if (this.#sweep || this.#again || this.#spaces.size > 0 || marker !== this.#marker) {
          const spaces = this.#sweep ? null : [...this.#spaces];
          this.#spaces.clear();
          this.#again = false;
          this.#sweep = false;
          const outcome = await this.#once(spaces, signal);
          this.#marker = marker;
          if (outcome.built + outcome.refused + outcome.failed > 0) this.#log(`built ${outcome.built} scopes, refused ${outcome.refused} over a limit, ${outcome.failed} failed`);
          this.#settled(outcome.failed > 0);
        }
      } catch (error) {
        if (signal.aborted) return;
        this.#log(`round failed: ${error instanceof Error ? error.message : String(error)}`);
        this.#settled(true);
      }
      await this.#sleep(signal);
    }
  }

  /** A round that failed is followed by one over everything: what failed may be a member's space no round would visit again. */
  #settled(failed: boolean): void {
    this.#sweep ||= failed;
    this.#retryMs = failed ? Math.min(Math.max(this.#retryMs * 2, INDEX_TICK_MS), INDEX_RETRY_MAX_MS) : 0;
  }

  /** Until the next tick, or at once when a request came during the round. */
  #sleep(signal: AbortSignal): Promise<void> {
    if (signal.aborted || (this.#again && this.#retryMs === 0)) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.#wake?.(), this.#retryMs || INDEX_TICK_MS);
      timer.unref();
      this.#wake = () => {
        clearTimeout(timer);
        this.#wake = null;
        resolve();
      };
    });
  }

  async #round(spaces: readonly string[] | null, signal: AbortSignal): Promise<IndexRoundOutcome> {
    const outcome: IndexRoundOutcome = { built: 0, refused: 0, failed: 0 };
    const index = this.#index();
    signal.throwIfAborted();
    if (index === undefined) return outcome;
    const failed = (error: unknown, what = 'a scope'): void => {
      outcome.failed += 1;
      this.#log(`${what}: ${error instanceof Error ? error.message : String(error)}`);
      setTraceStatus('error', (error as { code?: string }).code ?? '知识搜索索引有范围没有建完');
    };
    const scopes = await this.#source.scopes(spaces, failed);
    const states = await index.states(scopes);
    for (const [at, scope] of scopes.entries()) {
      const key = keyOf(scope);
      const state = states[at];
      signal.throwIfAborted();
      if (state.refused !== null && !state.ready) continue;
      if (state.ready && this.#verified.has(key)) continue;
      try {
        if (state.ready) {
          if (await index.ready(scope.version, scope.path)) {
            this.#remember(key);
            continue;
          }
          this.#repairing.add(key);
          // A repair would only pass that limit again; a search names it.
          if (state.refused !== null) continue;
        }
        if (!(await buildScope(index, scope, signal))) continue;
        // The count `complete` kept can differ only when a scope's rows did: repaired or not, that is not ready.
        if (!(await index.ready(scope.version, scope.path))) throw new KnowledgeError('知识搜索索引建完后，引用数与完成记录不一致');
        this.#remember(key);
        outcome.built += 1;
      } catch (error) {
        if (signal.aborted) throw error;
        if (passedLimit(error)) {
          await index.refuse(scope.version, scope.quotaSpace, error);
          outcome.refused += 1;
        } else failed(error, `${scope.path} of ${scope.version}`);
      }
    }
    return outcome;
  }

  #remember(key: string): void {
    this.#repairing.delete(key);
    if (this.#verified.size >= VERIFIED_SCOPES) this.#verified.clear();
    this.#verified.add(key);
  }
}
