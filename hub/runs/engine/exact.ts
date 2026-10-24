// Exact values (T04): every reference a submission cites must resolve for this reader inside the run's scope (the sources
// bound to the run, the locked root and the Hub records bound as inputs, T04 R[4]); every quotation must be verbatim in the
// fragment its reference resolves to; every command resolves against the locked catalogs or, taken verbatim from a bound
// source, as a quotation of it (T04 R[5]). A value that does not resolve keeps the whole submission from being accepted
// (T03 R[3]); a statement the catalog contradicts is not an unresolved value but a fact the checks judge.
import { CORE_VIOLATION_CODES,type ProtocolCode } from '../../../contracts/generated/protocol.ts';
import type { ProducerKind, Resolution, SourceRole } from '../../../contracts/generated/vocabulary.ts';
import type { ValueResolution } from '../../../contracts/src/claim.ts';
import type { ProtocolError } from '../../../contracts/src/common.ts';
import { SlotClaim, type ResolvedEvidence } from '../../../contracts/src/pack.ts';
import type { ItemProjection, RunRecord } from '../../../contracts/src/run.ts';
import type { CriterionChange, Submission } from '../../../contracts/src/submission.ts';
import { canonicalize, sha256Hex, type Principal } from '../../records/api.ts';
import type { LoadedWorkflow } from '../../ports.ts';
import {
  ReferenceSyntaxError,
  UNAVAILABLE_MESSAGE,
  candidatesFrom,
  findQuote,
  formatReference,
  locateQuote,
  parseReference,
  quoteMatches,
  recognize,
  resolveReference,
  withRange,
  type QuoteCandidate,
  type ReaderIdentity,
  type Reference,
  type Resolved,
} from '../../refs/api.ts';
import type { CatalogView } from '../../rules/api.ts';
import { ENGINE_COMPONENT, type EngineContext } from './deps.ts';
import { attemptEvidence } from './retry-evidence.ts';
import { HubReadFailure, retryRead } from './retry-read.ts';
import { describe, protocolError } from './errors.ts';
import { recordReader, sourceReader } from './readers.ts';
import { resultsOf } from './store.ts';
import { pointerOf, valueAt } from './util.ts';

/** What a run may cite: its bound sources by digest, the records bound as inputs, the locked root and its catalogs. */
export interface RunScope {
  reader: ReaderIdentity;
  sources: ReadonlyMap<string, SourceRole>;
  records: ReadonlyMap<string, SourceRole | null>;
  /** The judged source: the sources and records bound through the workflow's subject slot (where a statement's location lies). */
  subject: { shas: ReadonlySet<string>; records: ReadonlySet<string> };
  root: string | null;
  unversionedRoot?: string | null;
  compositions?: string[];
  catalogs: readonly CatalogView[];
  /** Quotation candidates of every bound source the consumer may read, parsed on first use. */
  candidates(): Promise<QuoteCandidate[]>;
}

/** Bytes a Hub record reference binds as a source (B03 R[4]): the canonical JSON of the record, or of the value its pointer names. */
export function recordBytes(record: { kind: string; schema: string; provenance: string; created_at: string; body: unknown }, pointer: string | undefined): Uint8Array | null {
  const value = pointer === undefined ? { kind: record.kind, schema: record.schema, provenance: record.provenance, created_at: record.created_at, body: record.body } : valueAt(record.body, pointer);
  if (value === undefined) return null;
  return new TextEncoder().encode(canonicalize(value));
}

/** The scope of a run for one reader. `consumer` decides what text a reader is given (functions for the boundary, model for previews). */
export async function buildScope(ctx: EngineContext, run: RunRecord, workflow: LoadedWorkflow, reader: Principal, consumer: Extract<ProducerKind, 'function' | 'model'>, attempts: Array<Record<string, unknown>> = []): Promise<RunScope> {
  const { store, artifacts } = ctx.deps.records;
  const readScope = async <T>(reference: string, read: () => Promise<T>): Promise<T> => {
    try {
      return await retryRead(read, () => null, attempt => {
        if (attempt.retry || attempt.attempt > 1) attempts.push(attemptEvidence('read', ENGINE_COMPONENT, attempt, {reference}));
      });
    } catch (error) {
      ctx.log({traceId:null,run:run.run,what:'exact scope read',detail:describe(error)});
      if (consumer === 'function') throw new HubReadFailure(reference, 'check_error', attempts);
      throw error;
    }
  };
  const sources = new Map<string, SourceRole>();
  const records = new Map<string, SourceRole | null>();
  const subject = { shas: new Set<string>(), records: new Set<string>() };
  for (const binding of run.sources) {
    let ref: Reference;
    try {
      ref = parseReference(binding.reference);
    } catch {
      continue;
    }
    const judged = binding.slot !== undefined && binding.slot === workflow.workflow.subject;
    if (ref.scheme === 'src') {
      if (!sources.has(ref.sha256)) sources.set(ref.sha256, binding.role);
      if (judged) subject.shas.add(ref.sha256);
    } else if (ref.scheme === 'rec') {
      records.set(ref.record, binding.role);
      if (judged) subject.records.add(ref.record);
      const record = await readScope(binding.reference, () => store.get(ref.record));
      const bytes = record === null ? null : recordBytes(record, ref.pointer);
      if (bytes !== null) {
        const sha = sha256Hex(bytes);
        sources.set(sha, binding.role);
        if (judged) subject.shas.add(sha);
      }
    }
  }
  // A projection may place items in another slot than the subject (FragmentRef.slot): their sources are judged too.
  for (const item of run.items) {
    try {
      const ref = parseReference(item.location);
      if (ref.scheme === 'src') subject.shas.add(ref.sha256);
    } catch {
      // the run record was checked when it was stored
    }
  }
  if (run.predecessor !== undefined) for (const result of await readScope(`run:${run.predecessor}`, () => resultsOf(store, run.predecessor!))) if (!records.has(result.digest)) records.set(result.digest, null);
  const catalogs: CatalogView[] = [];
  if (run.root !== undefined) {
    const selective=new Set(workflow.checks.filter(c=>c.catalog_select).map(c=>c.catalog));
    const ids = new Set<string>([...workflow.workflow.product.catalogs.filter(id=>!selective.has(id)), ...workflow.checks.flatMap((c) => (c.catalog&&!c.catalog_select ? [c.catalog] : []))]);
    for (const id of ids) {
      const view = await readScope(`tree:${run.root}/${id}`, () => ctx.deps.knowledge.catalog(run.root!, id));
      if (view !== null) catalogs.push(view);
    }
  }
  let candidates: Promise<QuoteCandidate[]> | undefined;
  const identity: ReaderIdentity = { user: reader.id, role: reader.role, run: run.run };
  return {
    reader: identity,
    sources,
    records,
    subject,
    root: run.root ?? null,
    unversionedRoot: run.unversioned_root ?? null,
    compositions: run.target_basis.flatMap(c => { const d=c.statement.data; return d && [run.root,run.unversioned_root].includes(d.root as string) && typeof d.composition === 'string' ? [d.composition] : []; }),
    catalogs,
    candidates: () =>
      (candidates ??= (async () => {
        const out: QuoteCandidate[] = [];
        for (const [sha, role] of sources) {
          const source = await readScope(`src:${sha}`, () => artifacts.source(reader, sha, { consumer }));
          if (source === null || source.bytes === null) continue;
          const found = recognize(ctx.parsers, source.bytes, source.mediaType);
          if (found === null) continue;
          const list = candidatesFrom(found.document, sha, { role });
          for (let i = 0; i < list.length; i++) out.push(list[i]);
        }
        return out;
      })()),
  };
}

export interface ResolvedValue {
  /** W10: all tree provenance fragments resolve to src bindings explicitly marked expected. */
  expectedSourceBound?: boolean;
  /** Canonical reference (the parser's canonical selector for src fragments). */
  reference: string;
  text: string | null;
  role: SourceRole | null;
  /** The digest the reference is rooted in: source bytes, tree root or record. */
  digest: string;
  /** ResolvedEvidence.source: the stored source the reference resolves into. */
  source: string | null;
}

export type ValueOutcome = { ok: true; value: ResolvedValue } | { ok: false; message: string; code?: ProtocolCode };

export interface Resolver {
  /** Resolves inside the run scope; `scoped: false` only for the predecessor's statements a carry-over brings along. */
  resolve(reference: string, options?: { scoped?: boolean; grounds?: boolean }): Promise<ValueOutcome>;
}

export function scopeProblem(ref: Reference, scope: RunScope): string | null {
  switch (ref.scheme) {
    case 'src':
      return scope.sources.has(ref.sha256) ? null : '引用的源文件没有绑定到本次运行';
    case 'tree':
      return [scope.root, scope.unversionedRoot].includes(ref.root) ? null : '引用的知识树根不是本次运行锁定的根';
    case 'rec':
      return scope.records.has(ref.record) ? null : '引用的 Hub 记录没有绑定到本次运行';
    case 'entry':
      return '知识条目不能单独引用，请写它的知识树地址 tree:<根>/<路径>@<条目>';
  }
}

export function createResolver(ctx: EngineContext, scope: RunScope, consumer: Extract<ProducerKind, 'function' | 'model'>, attempts: Array<Record<string, unknown>> = []): Resolver {
  const { store, artifacts } = ctx.deps.records;
  const cache = new Map<string, Promise<ValueOutcome>>();
  const resolving = new Set<string>();
  const context = {
    reader: scope.reader,
    parsers: ctx.parsers,
    sources: sourceReader(artifacts, consumer),
    trees: ctx.deps.knowledge.treeReader({ compositions: scope.compositions }),
    records: recordReader(store, ctx.deps.knowledge.layers?.contributions),
    consumer,
    documents: ctx.documents,
    onDiagnostic: (diagnostic: {reference:string;message:string}) => ctx.log({traceId:null,run:scope.reader.run ?? null,what:'exact source',detail:`${diagnostic.reference}: ${diagnostic.message}`}),
  } as const;
  const run = async (reference: string, scoped: boolean, grounds: boolean): Promise<ValueOutcome> => {
    let ref: Reference;
    let canonical: string;
    try {
      ref = parseReference(reference);
      canonical = formatReference(ref);
    } catch (error) {
      if (error instanceof ReferenceSyntaxError) return { ok: false, code:'REFERENCE_UNRESOLVED', message: `引用格式不对：${error.message}` };
      throw error;
    }
    if (resolving.has(canonical)) {
      return { ok: false, message: `成环的引用：${canonical}` };
    }
    resolving.add(canonical);
    try {
      if (scoped) {
        const problem = scopeProblem(ref, scope);
        if (problem !== null) return { ok: false, code:'REFERENCE_UNRESOLVED', message: problem };
      } else if (ref.scheme === 'entry') return { ok: false, message: scopeProblem(ref, scope) ?? '' };
      let result: Awaited<ReturnType<typeof resolveReference>>;
      try {
        result = await retryRead(() => resolveReference(ref, context), result => !result.resolved
          && result.reason !== undefined ? { reason: result.reason, retry: true } : null,
          attempt => { if (attempt.retry || attempt.attempt > 1) attempts.push(attemptEvidence('read', ENGINE_COMPONENT, attempt, {reference:canonical})); });
      } catch (error) {
        ctx.log({ traceId: null, run: scope.reader.run ?? null, what: 'exact source', detail: describe(error) });
        if (consumer === 'function') throw new HubReadFailure(canonical, 'check_error', attempts);
        return { ok: false, message: `引用解析不出（${UNAVAILABLE_MESSAGE}）` };
      }
      if (!result.resolved && result.reason !== undefined) {
        ctx.log({ traceId: null, run: scope.reader.run ?? null, what: 'exact source', detail: `bound source ${canonical}: ${result.reason}` });
        if (consumer === 'function') throw new HubReadFailure(canonical, result.reason, attempts);
      }
      if (!result.resolved) return { ok: false, code:result.code, message: result.code === 'SOURCE_UNAVAILABLE' ? `引用解析不出（${UNAVAILABLE_MESSAGE}）` : result.message };
      if (grounds && !result.groundable) return { ok: false, message: '这类记录不能作根据（B01 R[4]），请改引结果、动作或效果记录' };
      for (const ground of result.grounds ?? []) {
        let innerCanonical: string;
        try {
          innerCanonical = formatReference(parseReference(ground));
        } catch {
          continue;
        }
        if (resolving.has(innerCanonical)) {
          return { ok: false, message: `成环的引用：${innerCanonical}` };
        }
      }
      return { ok: true, value: valueOf(result, ref, scope) };
    } finally {
      resolving.delete(canonical);
    }
  };
  return {
    resolve(reference, options = {}) {
      const scoped = options.scoped !== false;
      const key = `${scoped ? 's' : 'u'}${options.grounds ? 'g' : 't'}\u0000${reference}`;
      let found = cache.get(key);
      if (!found) cache.set(key, (found = run(reference, scoped, options.grounds === true)));
      return found;
    },
  };
}

function valueOf(result: Resolved, ref: Reference, scope: RunScope): ResolvedValue {
  switch (ref.scheme) {
    case 'src':
      return { reference: result.reference, text: result.text, role: scope.sources.get(ref.sha256) ?? null, digest: ref.sha256, source: ref.sha256 };
    case 'tree': {
      const originals = result.grounds.map(parseReference);
      const sources = originals.flatMap(origin => origin.scheme === 'src' ? [origin.sha256] : []);
      const expectedSourceBound = originals.length > 0 && originals.every(origin => origin.scheme === 'src' && scope.sources.get(origin.sha256) === 'expected');
      return { reference: result.reference, text: result.text, role: 'expected', digest: ref.root, source: sources[0] ?? null, expectedSourceBound };
    }
    case 'rec':
      return { reference: result.reference, text: result.text, role: scope.records.get(ref.record) ?? null, digest: ref.record, source: ref.record };
    case 'entry':
      return { reference: result.reference, text: result.text, role: 'expected', digest: ref.entry, source: null };
  }
}

/** A src fragment narrowed to where the quotation sits in it; other references as they are. */
export function pinned(reference: string, text: string, quote: string): string {
  try {
    const ref = parseReference(reference);
    if (ref.scheme !== 'src' || ref.selector === undefined || ref.range !== undefined) return reference;
    const at = locateQuote(text, quote);
    return at === null ? reference : withRange(reference, [at.from, at.to]);
  } catch {
    return reference;
  }
}

// ---------------------------------------------------------------- commands

export interface CommandResolution {
  resolution: Resolution;
  references: string[];
  /** Command heads the text could mean, when it is ambiguous. */
  options: string[];
}

/** A place a command phrase may be quoted from: the item's own fragment and the claim's quotations. */
export interface QuotePlace {
  reference: string;
  text: string;
}

/**
 * T04 DEF and R[5]: a command taken verbatim from a bound source resolves as a quotation of it (the item's own fragment and
 * the statement's quotations first, then every bound source); the longest catalog head names it (its arguments are judged
 * later by the catalog check); a catalog menu of several heads found in no bound source is ambiguous; a text found nowhere
 * is unresolved.
 */
export async function resolveCommand(scope: RunScope, text: string, places: readonly QuotePlace[], how: { search?: boolean } = {}): Promise<CommandResolution> {
  const words = text.normalize('NFC').trim().split(/\s+/u).filter(Boolean);
  const references: string[] = [];
  const options: string[] = [];
  for (const place of places) {
    if (quoteMatches(place.text, text)) {
      references.push(pinned(place.reference, place.text, text));
      break;
    }
  }
  for (const catalog of scope.catalogs) {
    if (words.length === 0) break;
    const match = catalog.lookup(words);
    if (match) {
      references.unshift(match.entry.reference);
      break;
    }
    const heads = catalog.heads(words, { limit: 11 });
    if (heads.length === 1) {
      const entry = catalog.get(heads[0]);
      if (entry) {
        references.unshift(entry.reference);
        break;
      }
    } else if (heads.length > 1) options.push(...heads.map((h) => h.join(' ')));
  }
  if (references.length > 0) return { resolution: 'resolved', references: [...new Set(references)], options: [] };
  if (how.search !== false) {
    const found = findQuote(await scope.candidates(), text, { limit: 5 });
    if (found.total > 0) return { resolution: 'resolved', references: [...new Set(found.matches.map((m) => m.ranged))], options: [] };
  }
  if (options.length > 1) {
    const refs = scope.catalogs.flatMap((c) => options.map((o) => c.get(o.split(' '))?.reference).filter((r): r is string => r !== undefined));
    if (refs.length > 1) return { resolution: 'ambiguous', references: [...new Set(refs)], options };
  }
  return { resolution: 'unresolved', references: [], options };
}

// ---------------------------------------------------------------- the submission

/**
 * What the resolution of one statement gives its claim: value resolutions, cited roles and digests, its grounds in canonical
 * form (as written where a value did not resolve), and the statement with every resolved reference in canonical form.
 */
export interface ClaimEvidence {
  resolutions: ValueResolution[];
  roles: SourceRole[];
  bound: string[];
  grounds: string[];
  canonical: SlotClaim;
}

/**
 * What the checks of one item get: the resolved evidence of its slot record, the fragment texts by reference (canonical and as
 * written), and the slot record with its resolved references in canonical form (null until a slot record was resolved), so a
 * check that pairs the statements' references with the evidence meets one spelling per fragment whatever alias the model used.
 */
export interface ItemEvidence {
  evidence: ResolvedEvidence[];
  texts: Map<string, string>;
  claims: Map<string, ClaimEvidence>;
  slots: Record<string, unknown> | null;
}

export interface ExactResult {
  criterionChanges?:Array<{index:number;change:CriterionChange}>;
  criterionRefusals?:ProtocolError[];
  errors: ProtocolError[];
  items: Map<string, ItemEvidence>;
  cross: Map<string, ClaimEvidence>;
  /** The cross-item entries with their resolved grounds in canonical form, for the default run subject. */
  crossEntries: unknown[];
  /** Items whose slot records hold a value that did not resolve. */
  failedItems: Set<string>;
}

export function emptyEvidence(): ItemEvidence {
  return { evidence: [], texts: new Map(), claims: new Map(), slots: null };
}

function addEvidence(ev: ItemEvidence, value: ResolvedValue): void {
  if (!ev.evidence.some((e) => e.reference === value.reference)) {
    ev.evidence.push({ reference: value.reference, resolved: true, source: value.source, role: value.role, text: value.text });
  }
  if (value.text !== null) ev.texts.set(value.reference, value.text);
}

const LOCATION_FIX = '把 location 写成被判对象里的片段引用（例如条目自己的位置）；期望来源、线索和知识树的原文写在 grounds 或 quotes 里';

/**
 * Why a statement's location is not in the judged source, or null. SlotClaim.location says where in the judged source the
 * statement applies: a fragment of a source bound through the subject slot (or a record bound there), never an expected
 * source, a hint, the knowledge tree or another record (scenario 16: such a location does not exist in the target).
 */
function locationProblem(location: string, scope: RunScope): string | null {
  let ref: Reference;
  try {
    ref = parseReference(location);
  } catch {
    return null; // the resolver reports the syntax
  }
  if (ref.scheme === 'src' && scope.subject.shas.has(ref.sha256)) return null;
  if (ref.scheme === 'rec' && scope.subject.records.has(ref.record)) return null;
  return '位置不在被判对象里：location 说的是陈述落在被判对象的哪个片段';
}

/** Resolves every exact value of one slot statement; problems go to `errors`. */
export async function resolveStatement(
  scope: RunScope,
  resolver: Resolver,
  claim: SlotClaim,
  at: string,
  ev: ItemEvidence,
  places: readonly QuotePlace[],
  errors: ProtocolError[],
  extra: { item?: string; requirement?: string },
  scoped = true,
): Promise<ClaimEvidence> {
  const canonical: SlotClaim = structuredClone(claim);
  const out: ClaimEvidence = { resolutions: [], roles: [], bound: [], grounds: [], canonical };
  const fail = (code: 'REFERENCE_UNRESOLVED' | 'REFERENCE_AMBIGUOUS' | 'QUOTE_MISMATCH', path: string, message: string, options?: string[], fix?: string) =>
    errors.push(protocolError(code, message, { path, ...extra, ...(options && options.length > 0 ? { options } : {}), ...(fix !== undefined ? { fix } : {}) }));
  const take = (pointer: string, text: string, value: ResolvedValue, cites: boolean, reference = value.reference): void => {
    out.resolutions.push({ pointer, text, resolution: 'resolved', references: [reference] });
    out.bound.push(value.digest);
    if (cites && value.role !== null) out.roles.push(value.role);
    addEvidence(ev, value);
  };
  if (claim.location !== undefined) {
    // The predecessor's statements a carry-over brings (scoped false) were placed in their own judged source.
    const outside = scoped ? locationProblem(claim.location, scope) : null;
    if (outside !== null) fail('REFERENCE_UNRESOLVED', `${at}/location`, outside, undefined, LOCATION_FIX);
    else {
      const r = await resolver.resolve(claim.location, { scoped });
      if (r.ok) {
        take(`${at}/location`, claim.location, r.value, false);
        canonical.location = r.value.reference;
      } else {
        const isCycle = r.message.startsWith('成环的引用：');
        fail('REFERENCE_UNRESOLVED', `${at}/location`, `位置解析不出：${r.message}`, undefined, isCycle ? r.message : LOCATION_FIX);
      }
    }
  }
  for (const [k, ground] of (claim.grounds ?? []).entries()) {
    const r = await resolver.resolve(ground, { scoped, grounds: true });
    if (r.ok) {
      take(`${at}/grounds/${k}`, ground, r.value, true);
      out.grounds.push(r.value.reference);
      canonical.grounds![k] = r.value.reference;
    } else {
      const isCycle = r.message.startsWith('成环的引用：');
      fail('REFERENCE_UNRESOLVED', `${at}/grounds/${k}`, `根据解析不出：${r.message}`, undefined, isCycle ? r.message : undefined);
      out.grounds.push(ground);
    }
  }
  const quoted: QuotePlace[] = [];
  for (const [k, quote] of (claim.quotes ?? []).entries()) {
    const r = await resolver.resolve(quote.reference, { scoped, grounds: true });
    if (!r.ok) {
      const isCycle = r.message.startsWith('成环的引用：');
      fail('REFERENCE_UNRESOLVED', `${at}/quotes/${k}/reference`, `引文的引用解析不出：${r.message}`, undefined, isCycle ? r.message : undefined);
      continue;
    }
    if (r.value.text === null) {
      fail('REFERENCE_UNRESOLVED', `${at}/quotes/${k}`, '引用的原文读不到，无法核对这段引文');
      continue;
    }
    if (!quoteMatches(r.value.text, quote.text)) {
      fail('QUOTE_MISMATCH', `${at}/quotes/${k}/text`, `引文不在所引片段里：“${[...quote.text].slice(0, 60).join('')}”`);
      continue;
    }
    const narrowed = pinned(r.value.reference, r.value.text, quote.text);
    take(`${at}/quotes/${k}`, quote.text, r.value, true, narrowed);
    out.grounds.push(narrowed);
    ev.texts.set(quote.reference, r.value.text);
    canonical.quotes![k] = { reference: r.value.reference, text: quote.text };
    quoted.push({ reference: r.value.reference, text: r.value.text });
  }
  for (const [k, command] of (claim.commands ?? []).entries()) {
    // A statement that a command is absent is judged by the catalog check, not resolved (T04 R[5]).
    if (command.present === false) continue;
    const found = await resolveCommand(scope, command.command, [...places, ...quoted]);
    const pointer = `${at}/commands/${k}`;
    if (found.resolution === 'resolved') {
      out.resolutions.push({ pointer, text: command.command, resolution: 'resolved', references: found.references });
      for (const reference of found.references) {
        const digest = /^(?:src|tree|rec):([0-9a-f]{64})/.exec(reference)?.[1];
        if (digest !== undefined) out.bound.push(digest);
      }
    } else if (found.resolution === 'ambiguous') {
      fail('REFERENCE_AMBIGUOUS', `${pointer}/command`, `命令“${command.command}”可能指 ${found.options.length} 个命令`, found.options.slice(0, 10));
    } else {
      fail('REFERENCE_UNRESOLVED', `${pointer}/command`, `命令“${command.command}”在锁定的目录里找不到，也不在已绑定的原文里`, found.options.slice(0, 10));
    }
  }
  return out;
}

/**
 * Resolves every statement of one slot record into `ev` and returns the record with the statements in canonical form
 * (statements that are no SlotClaim stay as written: they are structure violations already).
 */
export async function resolveSlots(
  scope: RunScope,
  resolver: Resolver,
  workflow: LoadedWorkflow,
  slots: Record<string, unknown>,
  index: number,
  item: string,
  ev: ItemEvidence,
  places: readonly QuotePlace[],
  errors: ProtocolError[],
  scoped = true,
): Promise<Record<string, unknown>> {
  const copy: Record<string, unknown> = structuredClone(slots);
  for (const key of Object.keys(workflow.slots.item)) {
    const list = slots[key];
    if (!Array.isArray(list)) continue;
    const target = copy[key] as unknown[];
    for (const [j, raw] of list.entries()) {
      const claim = SlotClaim.safeParse(raw);
      if (!claim.success) continue;
      const at = pointerOf('items', index, 'slots', key, j);
      const ce = await resolveStatement(scope, resolver, claim.data, at, ev, places, errors, { item, requirement: key }, scoped);
      ev.claims.set(at, ce);
      target[j] = ce.canonical;
    }
  }
  return copy;
}

/** T04 over a parsed submission: the whole-rejection errors and, per item, the evidence and canonical slot record the checks get. */
export async function resolveSubmission(
  scope: RunScope,
  resolver: Resolver,
  workflow: LoadedWorkflow,
  items: readonly ItemProjection[],
  submission: Submission,
): Promise<ExactResult> {
  const result: ExactResult = { errors: [], items: new Map(), cross: new Map(), crossEntries: [], failedItems: new Set() };
  const byId = new Map(items.map((it) => [it.id, it]));
  for (const [i, entry] of submission.items.entries()) {
    const item = byId.get(entry.item);
    if (item === undefined || entry.handling !== 'handled' || entry.slots === undefined) continue;
    const ev = emptyEvidence();
    const places: QuotePlace[] = [];
    const own = await resolver.resolve(item.location);
    if (own.ok && own.value.text !== null) {
      ev.texts.set(item.location, own.value.text);
      places.push({ reference: item.location, text: own.value.text });
    }
    const before = result.errors.length;
    ev.slots = await resolveSlots(scope, resolver, workflow, entry.slots, i, entry.item, ev, places, result.errors);
    if (result.errors.length > before) result.failedItems.add(entry.item);
    result.items.set(entry.item, ev);
  }
  for (const [j, entry] of (submission.cross_item ?? []).entries()) {
    const at = pointerOf('cross_item', j);
    const out: ClaimEvidence = { resolutions: [], roles: [], bound: [], grounds: [], canonical: { text: entry.statement } };
    const copy = structuredClone(entry);
    for (const [k, ground] of entry.grounds.entries()) {
      const r = await resolver.resolve(ground, { grounds: true });
      if (r.ok) {
        out.resolutions.push({ pointer: `${at}/grounds/${k}`, text: ground, resolution: 'resolved', references: [r.value.reference] });
        out.bound.push(r.value.digest);
        if (r.value.role !== null) out.roles.push(r.value.role);
        out.grounds.push(r.value.reference);
        copy.grounds[k] = r.value.reference;
      } else {
        const isCycle = r.message.startsWith('成环的引用：');
        result.errors.push(protocolError('REFERENCE_UNRESOLVED', `根据解析不出：${r.message}`, { path: `${at}/grounds/${k}`, ...(isCycle ? { fix: r.message } : {}) }));
        out.grounds.push(ground);
      }
    }
    result.cross.set(at, out);
    result.crossEntries.push(copy);
  }
  const criteria=await resolveCriterionChanges(resolver,items,submission.criterion_changes??[]);
  result.errors.push(...criteria.errors);
  result.criterionChanges=criteria.accepted;result.criterionRefusals=criteria.refused;
  return result;
}

/** W10 exact boundary: role errors refuse one declaration; missing values and non-verbatim text refuse the submission. */
export async function resolveCriterionChanges(resolver:Resolver,items:readonly {id:string}[],changes:NonNullable<Submission['criterion_changes']>):Promise<{errors:ProtocolError[];refused:ProtocolError[];accepted:Array<{index:number;change:CriterionChange}>}>{
  const errors:ProtocolError[]=[],refused:ProtocolError[]=[];
  const accepted:Array<{index:number;change:CriterionChange}>=[],seen=new Set<string>();
  for(const [index,change] of changes.entries()){
    const at=pointerOf('criterion_changes',index),before=errors.length;
    if(!items.some(item=>item.id===change.item)){errors.push(protocolError('SUBMISSION_SCHEMA_VIOLATION','判据变更声明的条目不在本运行中',{path:at+'/item',item:change.item}));continue;}
    let expected=true;const canonical=structuredClone(change);
    const locate=async(reference:string,quote:string,path:string,quotePath:string)=>{
      const result=await resolver.resolve(reference,{grounds:true});
      if(!result.ok||result.value.text===null){errors.push(protocolError('REFERENCE_UNRESOLVED',result.ok?'判据片段没有可核对的原文':result.message,{path,item:change.item}));return null;}
      if(!quoteMatches(result.value.text,quote))errors.push(protocolError('QUOTE_MISMATCH','判据变更声明的原文或引文不逐字',{path:quotePath,item:change.item}));
      if(result.value.role!=='expected'||parseReference(result.value.reference).scheme==='tree'&&result.value.expectedSourceBound!==true)expected=false;
      return result.value.reference;
    };
    const reference=await locate(change.criterion,change.old,at+'/criterion',at+'/old');
    if(reference)canonical.criterion=reference;
    for(const [j,ground] of change.grounds.entries()){
      const ref=await locate(ground.reference,ground.quote,at+`/grounds/${j}/reference`,at+`/grounds/${j}/quote`);
      if(ref)canonical.grounds[j]!.reference=ref;
    }
    const key=JSON.stringify([change.item,canonical.criterion]);
    if(seen.has(key))errors.push(protocolError('SUBMISSION_SCHEMA_VIOLATION','同一条目的同一处判据只许一条声明',{path:at+'/criterion',item:change.item}));
    if(reference)seen.add(key);
    if(errors.length>before)continue;
    if(!expected){const code='core.criterion.source_role_mismatch' satisfies import('../../../contracts/generated/protocol.ts').CoreViolationCode;refused.push({code,message:'判据变更声明不是期望来源的片段',path:at,item:change.item,fix:CORE_VIOLATION_CODES[code].fix});continue;}
    accepted.push({index,change:canonical});
  }
  return {errors,refused,accepted};
}
