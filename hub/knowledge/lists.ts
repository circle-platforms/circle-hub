import type { ActionResult, Reason } from '../../contracts/generated/vocabulary.ts';
// List slots (product@1 ProducerSource many): every external object a build lists in one role, read through the
// ExternalReaderPort with bounded concurrency in the admin's context, checked and parsed like any source, handed to the
// producer in batches. Loading has two steps: a read gives the stored record and its size without its bytes, so a batch is
// cut into calls of at most the byte cap before any bytes are fetched and parsed. A list source the package read less than
// max_age_seconds ago is used again from its stored record (every check is applied again to that record). A producer call
// is memoized under a key that covers everything the function receives: its output (or how it failed) is stored and used
// again whenever the key recurs. A call that fails in a way a smaller call could avoid is split until the document it fails
// on is found and skipped, within a budget of calls, and only while the producer is shown to work on documents.
import type { KnownBuild, Producer, ProducerOutput as ProducerOutputType } from '../../contracts/src/product.ts';
import { ProducerOutput } from '../../contracts/src/product.ts';
import type { ProductHandle } from '../ports.ts';
import { canonicalBytes, canonicalize, sha256Hex, type ActionBody, type SourceArtifact } from '../records/api.ts';
import { runProducer } from './call.ts';
import { Semaphore } from './concurrency.ts';
import type { KnowledgeContext } from './context.ts';
import { cutText } from './digest.ts';
import { describeError } from './errors.ts';
import type { ExternalLoad, Loaded, ParsedSource, SourceLoader } from './sources.ts';
import { ACTION, COMPONENTS, INDEX, type MemoDetail, type MemoFailureDetail } from './store.ts';

/** Objects per call of a list slot when the producer declares no batch size (product@1 ProducerSource batch). */
export const DEFAULT_BATCH = 50;
/** Calls one list may make to isolate failing documents besides `isolationCallsPerBatch` per batch (README decision 19). */
export const ISOLATION_BASE_BATCHES = 4;

export interface ListBatch {
  index: number;
  of: number;
  externals: string[];
}

/** The listed ids without repeats (first one kept) and how many repeats were dropped. */
export function uniqueList(list: readonly string[]): { ids: string[]; repeats: number } {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of list) {
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return { ids, repeats: list.length - ids.length };
}

/** Consecutive batches of the list in its order; an empty list is one empty batch, so the producer runs once. */
export function listBatches(ids: readonly string[], size: number): ListBatch[] {
  const step = Math.max(1, Math.floor(size));
  const of = Math.max(1, Math.ceil(ids.length / step));
  return Array.from({ length: of }, (_, index) => ({ index, of, externals: ids.slice(index * step, (index + 1) * step) }));
}

/** A read of one list element: the record the connector read returned (or a stored one), without its bytes. */
export type ElementPeek =
  | { ok: true; external: string; load: Extract<ExternalLoad, { ok: true }>; reused: boolean; startedAt: string }
  | { ok: false; external: string; reason: string };

export type ElementLoad = { ok: true; value: ParsedSource; reused: boolean } | { ok: false; reason: string };

/**
 * Loads list sources for one production (or one sync) in two steps. `peek` reads the object (a stored read younger than
 * max_age_seconds is used again, otherwise the object is read through the port and the read is recorded) and gives its
 * record and size without fetching its bytes; `materialize` fetches the bytes through Artifacts.source, applies every check
 * (visibility, read tier, scan) and parses them with the explicit source parser, or the media recognizer when undeclared. At most `concurrency` of either run
 * at a time.
 */
export class ListLoader {
  readonly #context: KnowledgeContext;
  readonly #loader: SourceLoader;
  readonly #maxAgeMs: number;
  readonly #gate: Semaphore;
  readonly #record: boolean;
  readonly #refresh:ReadonlySet<string>;
  /** Loads answered from a stored record, and reads through the port. */
  reused = 0;
  read = 0;

  /** `record: false` (a dry run) writes no read action for a fresh read. */
  constructor(context: KnowledgeContext, loader: SourceLoader, options: { maxAgeSeconds: number; concurrency: number; record?: boolean; refresh?:ReadonlySet<string> }) {
    this.#context = context;
    this.#loader = loader;
    this.#maxAgeMs = Math.max(0, options.maxAgeSeconds) * 1000;
    this.#gate = new Semaphore(options.concurrency);
    this.#record = options.record !== false;
    this.#refresh=options.refresh??new Set();
  }

  /** Never rejects: an object that cannot be read is a failed peek the caller skips. */
  peek(external: string, options: { maxAgeSeconds?: number;slot?:string } = {}): Promise<ElementPeek> {
    const maxAgeMs = options.maxAgeSeconds === undefined ? this.#maxAgeMs : Math.max(0, options.maxAgeSeconds) * 1000;
    return this.#gate.run(async () => {
      if (maxAgeMs > 0 && !this.#refresh.has(external)) {
        const stored = await this.#stored(external, maxAgeMs).catch(() => null);
        if (stored !== null) return { ok: true, external, load: stored, reused: true, startedAt: this.#context.now().toISOString() };
      }
      return this.#fresh(external,options.slot);
    });
  }

  /**
   * The bytes of a peeked element, checked and parsed. A stored read that no longer passes a check now (the record became
   * unreadable after withdrawal or its policy changed) is read again through the port. Never rejects.
   */
  materialize(peek: Extract<ElementPeek, { ok: true }>, maxBytes: number,slot?:string,parser?:string): Promise<ElementLoad> {
    return this.#gate.run(async () => {
      const first = await this.#check(peek.load, maxBytes,slot,parser);
      if (first.ok) {
        if (peek.reused) this.reused++;
        return { ok: true, value: first.value, reused: peek.reused };
      }
      if (!peek.reused) return { ok: false, reason: first.reason };
      const again = await this.#fresh(peek.external,slot);
      if (!again.ok) return { ok: false, reason: again.reason };
      const second = await this.#check(again.load, maxBytes,slot,parser);
      return second.ok ? { ok: true, value: second.value, reused: false } : { ok: false, reason: second.reason };
    });
  }

  /** Peek and materialize in one step. */
  async load(external: string, maxBytes: number, options: { maxAgeSeconds?: number } = {}): Promise<ElementLoad> {
    const peek = await this.peek(external, options);
    if (!peek.ok) return { ok: false, reason: peek.reason };
    return this.materialize(peek, maxBytes);
  }

  async #check(load: Extract<ExternalLoad, { ok: true }>, maxBytes: number,slot?:string,parser?:string): Promise<Loaded<ParsedSource>> {
    try {
      const readable = await this.#loader.readable(load, maxBytes,{slot});
      if (!readable.ok) return readable;
      return this.#loader.parse(readable.value,parser);
    } catch (error) {
      return { ok: false, sha256: load.artifact.body.sha256, reason: `${load.id}：读取或核对时出错（${describeError(error)}）` };
    }
  }

  /** A read through the port, recorded (unless a dry run) so that the next load within max_age_seconds uses it again. */
  async #fresh(external: string,slot?:string): Promise<ElementPeek> {
    const startedAt = this.#context.now().toISOString();
    this.read++;
    let load: ExternalLoad;
    try {
      load = await this.#loader.read(external,slot);
    } catch (error) {
      return { ok: false, external, reason: `${external}：读取或核对时出错（${describeError(error)}）` };
    }
    if (!load.ok) return { ok: false, external, reason: `${external}：${load.reason}` };
    if (this.#record) {
      const body = load.artifact.body;
      try {
        await this.#loader.recordReadOnce(external,load.artifact.digest,()=>this.#context.store.putRead(
          { external, revision: load.revision, artifact: load.artifact.digest, sha256: body.sha256, size: body.size, media_type: body.media_type },
          startedAt,
          this.#context.now().toISOString(),
        ));
      } catch {
        // Without the record the next production reads the object again; the read itself stands.
      }
    }
    return { ok: true, external, load, reused: false, startedAt };
  }

  /** The stored read of an external id when it is young enough and its record is there; null otherwise. */
  async #stored(external: string, maxAgeMs: number): Promise<Extract<ExternalLoad, { ok: true }> | null> {
    const found = await this.#context.store.latestRead(external);
    if (found === null) return null;
    const age = this.#context.now().getTime() - Date.parse(found.at);
    if (!(age >= 0 && age < maxAgeMs)) return null;
    const record = await this.#context.records.store.get<SourceArtifact['body']>(found.detail.artifact);
    if (record === null || record.kind !== 'source_artifact' || record.body.sha256 !== found.detail.sha256) return null;
    return { ok: true, id: external, revision: found.detail.revision, artifact: record as SourceArtifact };
  }
}

/** One element of a memo key: the source digest, the media type, the parser, and the external id the function receives. */
const elementKey = (source: ParsedSource): { sha256: string; media_type: string; parser: string; external: string } => ({
  sha256: source.sha256,
  media_type: source.mediaType,
  parser: source.parser,
  external: source.external,
});

/** SHA-256 of the canonical JSON of the build exactly as a producer receives it (ProducerInput.build). */
export function buildDigest(build: KnownBuild | null): string {
  return sha256Hex(canonicalize(build));
}

export interface MemoKeyInput {
  known_builds?:readonly string[];
  pack: string;
  producer: Producer;
  /** The build as the function receives it. */
  build: KnownBuild | null;
  list: string;
  batch: { index: number; of: number };
  elements: readonly ParsedSource[];
  slots: ReadonlyMap<string, ParsedSource | null>;
}

/**
 * The memo key of one producer call: SHA-256 of the canonical JSON of the production component, the pack digest, the
 * producer id, its function reference and params, the build as the function receives it (by its digest), the list slot with
 * the batch position and the call's elements in order, and the other slots. It covers everything the function receives, so
 * a stored output stands for exactly this call.
 */
export function memoKey(input: MemoKeyInput): string {
  return memoKeyOf({ ...input, build: buildDigest(input.build) });
}

function memoKeyOf(input: Omit<MemoKeyInput, 'build'> & { build: string }): string {
  const slots: Record<string, ReturnType<typeof elementKey> | null> = {};
  for (const [name, source] of [...input.slots].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) slots[name] = source === null ? null : elementKey(source);
  return sha256Hex(
    canonicalize({
      component: COMPONENTS.producer,
      pack: input.pack,
      producer: input.producer.id,
      function: input.producer.function,
      params: input.producer.params ?? {},
      ...(input.known_builds?{known_builds:input.known_builds}:{}),
      build: input.build,
      list: input.list,
      batch: { index: input.batch.index, of: input.batch.of },
      elements: input.elements.map(elementKey),
      slots,
    }),
  );
}

/** What a batch's calls gave: one output per call that succeeded (with its elements), the documents isolated as failing. */
export interface BatchCalls {
  outputs: Array<{ elements: ParsedSource[]; output: ProducerOutputType }>;
  failed: Array<{ element: ParsedSource; reason: string; reason_code:Reason }>;
}

export type BatchOutcome = ({ ok: true } & BatchCalls) | { ok: false; reason: string };

/** Producer calls of one production: made in the sandbox, answered from a stored outcome; timeouts; warnings about storing. */
export interface CallTotals {
  made: number;
  reused: number;
  /** Calls that ran past the sandbox's time limit (made, not answered from a stored failure). */
  timeouts: number;
  warnings: string[];
}

/** What one list producer's calls showed so far in this production (README decision 19). */
export interface ListState {
  /** A call with at least one document succeeded (made or answered from a stored output). */
  succeeded: boolean;
  /** Calls made to isolate failing documents (the empty probe and every part of a failed call) and the budget for them. */
  isolationCalls: number;
  isolationBudget: number;
  /** The reason the production fails, once one is known: later batches stop. */
  failure: string | null;
}

export interface ListCallContext {
  context: KnowledgeContext;
  product: ProductHandle;
  producer: Producer;
  /** The build as the function receives it, and its digest. */
  build: KnownBuild | null;
  buildDigest: string;
  slots: ReadonlyMap<string, ParsedSource | null>;
  list: string;
  totals: CallTotals;
  state: ListState;
  retryFailures?:boolean;
}

/** The producer limits of this production as a canonical record: stored failures stand only for the same limits. */
const limitsOf = (context: KnowledgeContext): Record<string, unknown> => JSON.parse(canonicalize(context.sandbox.producer)) as Record<string, unknown>;

type StoredOutcome = { ok: true; output: ProducerOutputType } | { ok: false; reason: string } | null;

/** The stored outcome under a memo key: an output that reads back and validates, or a failure under these limits; else null. */
async function storedOutcome(context: KnowledgeContext, key: string): Promise<StoredOutcome> {
  try {
    const memo = await context.store.memoOutcome(key);
    if (memo === null) return null;
    if (!memo.ok && memo.detail.failure.reason_code!=='check_error')return null;
    if (!memo.ok) return canonicalize(memo.detail.failure.limits) === canonicalize(limitsOf(context)) ? { ok: false, reason: memo.detail.failure.reason } : null;
    const bytes = await context.records.objects.get(memo.detail.output.sha256);
    if (bytes === null) return null;
    const parsed = ProducerOutput.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return parsed.success ? { ok: true, output: parsed.data } : null;
  } catch {
    return null;
  }
}

function memoAction(ctx: ListCallContext, startedAt: string, elements: readonly ParsedSource[], result: Extract<ActionResult, 'completed' | 'error'>, detail: MemoDetail | MemoFailureDetail): ActionBody {
  const inputs = [...new Set([...elements.map((e) => `src:${e.sha256}`), ...[...ctx.slots.values()].flatMap((s) => (s === null ? [] : [`src:${s.sha256}`]))])];
  return {
    action: ACTION.generate,
    run: null,
    item: null,
    inputs,
    component: COMPONENTS.producer,
    lease: null,
    started_at: startedAt,
    ended_at: ctx.context.now().toISOString(),
    result,
    error_code: null,
    acceptance: null,
    codes: [],
    detail: detail as unknown as Record<string, unknown>,
  };
}

/** Stores a call's output under its memo key; false when it could not be stored (too large, a store failure). */
async function storeOutput(ctx: ListCallContext, key: string, startedAt: string, batch: { index: number; of: number }, elements: readonly ParsedSource[], output: ProducerOutputType): Promise<boolean> {
  const { context, product, producer } = ctx;
  try {
    const object = await context.records.objects.put(canonicalBytes(output), 'application/json');
    const detail: MemoDetail = {
      key,
      product: product.product.id,
      pack: { id: product.id, version: product.version, digest: product.digest },
      producer: producer.id,
      batch,
      elements: elements.length,
      output: { sha256: object.sha256, size: object.size, entries: output.entries.length, unplaced: (output.unplaced ?? []).length, warnings: output.warnings.length },
    };
    await context.store.putAction(memoAction(ctx, startedAt, elements, 'completed', detail), [{ key: INDEX.memo, value: key }]);
    return true;
  } catch {
    return false;
  }
}

/** Stores how a call failed under its memo key, so that the next production does not run it again under the same limits. */
async function storeFailure(ctx: ListCallContext, key: string, startedAt: string, batch: { index: number; of: number }, elements: readonly ParsedSource[], reason: string): Promise<void> {
  const { context, product, producer } = ctx;
  const detail: MemoFailureDetail = {
    key,
    product: product.product.id,
    pack: { id: product.id, version: product.version, digest: product.digest },
    producer: producer.id,
    batch,
    elements: elements.length,
    failure: { reason: cutText(reason, 1000), reason_code:'check_error', limits: limitsOf(context) },
  };
  try {
    await context.store.putAction(memoAction(ctx, startedAt, elements, 'error', detail), [{ key: INDEX.memo, value: key }]);
  } catch {
    // Without the record the next production runs the call again.
  }
}

type CallResult = { ok: true; output: ProducerOutputType } | { ok: false; reason: string; isolatable: boolean; timeout:boolean };

/** One call for exactly these elements: the stored outcome when the memo key recurs, else the sandbox (its outcome is stored). */
async function callOnce(ctx: ListCallContext, batch: { index: number; of: number }, part: readonly ParsedSource[]): Promise<CallResult> {
  const key = memoKeyOf({ known_builds:ctx.context.knownBuildInventory?.map(v=>v.name),pack: ctx.product.digest, producer: ctx.producer, build: ctx.buildDigest, list: ctx.list, batch, elements: part, slots: ctx.slots });
  const stored = await storedOutcome(ctx.context, key);
  if (stored !== null && (stored.ok || !ctx.retryFailures)) {
    ctx.totals.reused++;
    if (!stored.ok) return { ok: false, reason: stored.reason, isolatable: true, timeout:false };
    if (part.length > 0) ctx.state.succeeded = true;
    return { ok: true, output: stored.output };
  }
  ctx.totals.made++;
  const startedAt = ctx.context.now().toISOString();
  const run = await runProducer(ctx.context, ctx.product, ctx.producer, {
    build: ctx.build,
    slots: ctx.slots,
    params: ctx.producer.params ?? {},
    list: { slot: ctx.list, elements: part, batch },
  });
  if (!run.ok) {
    if (run.timeout && ++ctx.totals.timeouts > ctx.context.limits.maxTimedOutCalls) {
      return { ok: false, reason: `生产器 ${ctx.producer.id} 在这次生产里已经有 ${ctx.totals.timeouts} 次调用超过时间上限（最多 ${ctx.context.limits.maxTimedOutCalls} 次）：${run.reason}`, isolatable: false, timeout:run.timeout };
    }
    if (run.isolatable && !run.timeout) await storeFailure(ctx, key, startedAt, batch, part, run.reason);
    return { ok: false, reason: run.reason, isolatable: run.isolatable, timeout:run.timeout };
  }
  if (part.length > 0) ctx.state.succeeded = true;
  if (!(await storeOutput(ctx, key, startedAt, batch, part, run.value))) ctx.totals.warnings.push(`生产器 ${ctx.producer.id} 第 ${batch.index + 1} 批的输出没能存下复用，下次生产会再算一遍`);
  return { ok: true, output: run.value };
}

/**
 * A probe of the producer on an empty batch, made at most once per production: a producer that fails without any document
 * is broken, whatever its documents.
 */
export function emptyProbe(ctx: ListCallContext): () => Promise<{ ok: true } | { ok: false; reason: string }> {
  let pending: Promise<{ ok: true } | { ok: false; reason: string }> | null = null;
  return () =>
    (pending ??= callOnce(ctx, { index: 0, of: 1 }, []).then(
      (result) => (result.ok ? { ok: true as const } : { ok: false as const, reason: result.reason }),
      (error: unknown) => ({ ok: false as const, reason: describeError(error) }),
    ));
}

/**
 * Calls the producer for the elements of one batch (or one part of it within the byte cap). A failure a smaller call could
 * avoid splits the elements in halves, down to the single document it fails on, which is then skipped; the empty probe
 * must pass first, every call made to isolate counts against the list's budget, and the calls that time out against the
 * production's limit. Any other failure fails the batch, and with it the production.
 */
export async function callBatch(ctx: ListCallContext, batch: { index: number; of: number }, elements: ParsedSource[], probe: () => Promise<{ ok: true } | { ok: false; reason: string }>): Promise<BatchOutcome> {
  const { producer, state } = ctx;
  const stop = (reason: string): BatchOutcome => {
    state.failure ??= reason;
    return { ok: false, reason };
  };
  const attempt = async (part: ParsedSource[], isolating: boolean): Promise<BatchOutcome> => {
    if (state.failure !== null) return { ok: false, reason: state.failure };
    if (isolating) {
      if (state.isolationCalls >= state.isolationBudget) {
        return stop(`为找出生产器 ${producer.id} 处理不了的源文件，这次生产已经调用了 ${state.isolationCalls} 次（上限 ${state.isolationBudget} 次）：有问题的源文件太多，或是生产器本身的问题`);
      }
      state.isolationCalls++;
    }
    const run = await callOnce(ctx, batch, part);
    if (run.ok) return { ok: true, outputs: [{ elements: part, output: run.output }], failed: [] };
    if (!run.isolatable || part.length === 0) return stop(run.reason);
    const proof = await probe();
    if (!proof.ok) return stop(`${run.reason}；空的一批也失败（${proof.reason}），是生产器本身的问题`);
    if (part.length === 1) return { ok: true, outputs: [], failed: [{ element: part[0], reason_code:run.timeout?'timeout':'check_error', reason: cutText(`生产器 ${producer.id} 处理这份源文件时失败：${run.reason}`, 1000) }] };
    const middle = Math.ceil(part.length / 2);
    const left = await attempt(part.slice(0, middle), true);
    if (!left.ok) return left;
    const right = await attempt(part.slice(middle), true);
    if (!right.ok) return right;
    return { ok: true, outputs: [...left.outputs, ...right.outputs], failed: [...left.failed, ...right.failed] };
  };
  try {
    return await attempt(elements, false);
  } catch (error) {
    return stop(`生产器 ${producer.id} 第 ${batch.index + 1} 批出错：${describeError(error)}`);
  }
}


/** Single-slot calls of variable-consuming products reuse the same verified output store as list batches. */
export async function callSingleProducer(context:KnowledgeContext,product:ProductHandle,producer:Producer,build:KnownBuild | null,slots:ReadonlyMap<string,ParsedSource|null>,totals:CallTotals):Promise<{ok:true;value:ProducerOutputType}|{ok:false;reason:string}>{
  // Empty cannot be a slot name, so this key cannot collide with a list call.
  const batch={index:0,of:1};
  const key=memoKey({known_builds:context.knownBuildInventory?.map(v=>v.name),pack:product.digest,producer,build,list:'',batch,elements:[],slots});
  const stored=await storedOutcome(context,key);
  if(stored?.ok){totals.reused++;return {ok:true,value:stored.output};}
  totals.made++;
  const startedAt=context.now().toISOString();
  const run=await runProducer(context,product,producer,{build,slots,params:producer.params??{}});
  if(!run.ok)return {ok:false,reason:run.reason};
  const state:ListState={succeeded:true,isolationCalls:0,isolationBudget:0,failure:null};
  const ctx:ListCallContext={context,product,producer,build,buildDigest:buildDigest(build),slots,list:'',totals,state};
  if(!await storeOutput(ctx,key,startedAt,batch,[],run.value))totals.warnings.push(`生产器 ${producer.id} 的输出没能存下复用，下次生产会再算一遍`);
  return {ok:true,value:run.value};
}
