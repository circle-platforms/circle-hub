import {submissionOrigin} from './independence.ts';
// Carry-over (C08 R[4], W07 F[1], F[6], acceptance scenario 10). start_run offers ItemProjection.reuse for an item the
// predecessor delivered when the predecessor is an earlier revision of the same work (same pack content and root, no handover
// of its record), its latest accepted result came from a submission (a production result holds no judgment to carry), the item
// digest is unchanged, the item's slot record was written per item with a context digest (a slot record written in one go is
// marked no_reuse and cannot be reused: decision row 18 (b)), and every source its judgments cite is unchanged: a fragment of
// the predecessor's judged source has the same text at the same selector in this run's judged source, any other source is
// bound to this run. At submit the offer is checked again and the predecessor's judgments come along with judge and model of
// their record; the checks re-run on this run's boundary.
import type { Claim } from '../../../contracts/src/claim.ts';
import type { ProtocolError } from '../../../contracts/src/common.ts';
import type { ItemProjection, RunRecord } from '../../../contracts/src/run.ts';
import { Submission, type ItemSubmission } from '../../../contracts/src/submission.ts';
import type { ItemResult, ValidationResult } from '../../../contracts/src/validation.ts';
import type { Principal, StoredRecord } from '../../records/api.ts';
import type { LoadedWorkflow } from '../../ports.ts';
import { parseReference, recReference, srcFragment, type Reference } from '../../refs/api.ts';
import type { EngineContext } from './deps.ts';
import { emptyEvidence, resolveSlots, type ItemEvidence, type QuotePlace, type Resolver, type RunScope } from './exact.ts';
import type { ProducerOrigin } from './independence.ts';
import type { CarriedItem } from './evaluate.ts';
import { actionOfSubmission, latestAccepted, runById, submissionByDigest } from './store.ts';
import { isObject, pointerOf, valueAt } from './util.ts';

/** Every reference a judgment claim cites: grounds and the referents of its exact values. */
function citedBy(claim: Claim): string[] {
  return [...claim.grounds, ...(claim.resolutions ?? []).flatMap((r) => r.references)];
}

const judgmentsOf = (item: ItemResult): Claim[] => item.requirements.flatMap((r) => r.claims.filter((c) => c.warrant.producer === 'model'));

function parsed(reference: string): Reference | null {
  try {
    return parseReference(reference);
  } catch {
    return null;
  }
}

/** A workflow whose items carry judgments a model fills: only then is there anything to carry over. */
export function hasItemJudgments(workflow: LoadedWorkflow): boolean {
  const keys = new Set(Object.keys(workflow.slots.item));
  return workflow.requirements.some((t) => t.target === 'item' && t.accepted_producer !== 'fact' && keys.has(t.key));
}

export interface OfferContext {
  ctx: EngineContext;
  user: Principal;
  predecessor: RunRecord;
  workflow: LoadedWorkflow;
  packDigest: string;
  root: string | null;
  unversionedRoot?: string | null;
  /** Digests of the sources bound to the new run (inputs and expected sources), and its subject sources. */
  boundShas: ReadonlySet<string>;
  boundRecords: ReadonlySet<string>;
  subjectShas: readonly string[];
  /** The text of a fragment for the boundary (consumer function), or null. */
  fragmentText: (reference: string) => Promise<string | null>;
}

/** The same fragment in the new judged source (one source in the subject slot), by parser, selector and range. */
function moved(reference: Extract<Reference, { scheme: 'src' }>, to: readonly string[]): string | null {
  if (to.length !== 1 || reference.parser === undefined || reference.selector === undefined) return null;
  return srcFragment(to[0], reference.parser, reference.selector, reference.range);
}

/**
 * Whether every source a set of judgments cites is unchanged for the new run: a source still bound to it, or a fragment whose
 * text is the same at the same place of the new judged source (a revision of the target, also several carry-overs back); a
 * tree reference into the same root; a record bound to the new run.
 */
async function unchanged(offer: OfferContext, claims: readonly Claim[]): Promise<boolean> {
  for (const reference of new Set(claims.flatMap(citedBy))) {
    const ref = parsed(reference);
    if (ref === null) return false;
    if (ref.scheme === 'src') {
      if (offer.boundShas.has(ref.sha256)) continue;
      const target = moved(ref, offer.subjectShas);
      if (target === null) return false;
      const [old, now] = await Promise.all([offer.fragmentText(reference), offer.fragmentText(target)]);
      if (old === null || now === null || old !== now) return false;
    } else if (ref.scheme === 'tree') {
      if (![offer.root, offer.unversionedRoot].includes(ref.root)) return false;
    } else if (ref.scheme === 'rec') {
      if (!offer.boundRecords.has(ref.record)) return false;
    } else return false;
  }
  return true;
}

/** ItemProjection.reuse for each item the predecessor delivered unchanged (by item id). */
export async function reuseOffers(offer: OfferContext, items: readonly ItemProjection[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const p = offer.predecessor;
  if (!hasItemJudgments(offer.workflow)) return out;
  if (p.pack_digest !== offer.packDigest || (p.root ?? null) !== offer.root || (p.unversioned_root ?? null) !== (offer.unversionedRoot ?? null)) return out;
  const latest = await latestAccepted(offer.ctx.deps.records.store, p.run);
  if (latest === null) return out;
  const views: SubmissionViews = new Map();
  if ((await submissionView(offer.ctx, latest, views)) === null) return out;
  const previous = new Map(p.items.map((it) => [it.id, it]));
  const delivered = latest.body.partitions.delivered;
  for (const item of items) {
    const before = previous.get(item.id);
    if (before === undefined || before.digest === undefined || before.digest !== item.digest) continue;
    const n = delivered.findIndex((d) => d.item === item.id);
    if (n < 0) continue;
    const original = await originalSlots(offer.ctx, latest, item.id, views);
    if (original === null || original.context === null) continue;
    if (!(await unchanged(offer, judgmentsOf(delivered[n])))) continue;
    out.set(item.id, recReference(latest.digest, pointerOf('partitions', 'delivered', n)));
  }
  return out;
}

/** The parsed submission behind a validation result, with its producer origin; memoized per result within one call. */
interface SubmissionView {
  entries: Map<string, ItemSubmission>;
  origin: ProducerOrigin;
}
type SubmissionViews = Map<string, Promise<SubmissionView | null>>;

function submissionView(ctx: EngineContext, result: StoredRecord<ValidationResult>, views: SubmissionViews): Promise<SubmissionView | null> {
  let view = views.get(result.digest);
  if (view === undefined) {
    view = (async () => {
      const store = ctx.deps.records.store;
      const submission = await submissionByDigest(store, result.body.run, result.body.submission);
      if (submission === null) return null;
      const parsedSubmission = Submission.safeParse(submission.body);
      if (!parsedSubmission.success) return null;
      const action = await actionOfSubmission(store, submission.digest);
      const detail = isObject(action?.body.detail) ? action.body.detail : {};
      const run = await runById(store, result.body.run);
      const sessions = [run?.body.session ?? null, typeof detail.session === 'string' ? detail.session : null];
      return { entries: new Map(parsedSubmission.data.items.map((e) => [e.item, e])), origin: submissionOrigin(parsedSubmission.data,sessions) };
    })();
    views.set(result.digest, view);
  }
  return view;
}

/**
 * The slot record an item was judged with in a run: its own slots, or, for an item carried over, those of the run it came
 * from; with the producer of that record and the context digest it was written with (null: written in one go).
 */
async function originalSlots(
  ctx: EngineContext,
  result: StoredRecord<ValidationResult>,
  itemId: string,
  views: SubmissionViews,
  depth = 0,
): Promise<{ slots: Record<string, unknown>; origin: ProducerOrigin; context: string | null } | null> {
  if (depth > 20) return null;
  const view = await submissionView(ctx, result, views);
  const entry = view?.entries.get(itemId);
  if (view === null || entry === undefined || entry.handling !== 'handled') return null;
  if (entry.slots !== undefined) return { slots: entry.slots, origin: view.origin, context: entry.context ?? null };
  if (entry.reuse === undefined) return null;
  const ref = parsed(entry.reuse);
  if (ref === null || ref.scheme !== 'rec') return null;
  const earlier = await ctx.deps.records.store.get<ValidationResult>(ref.record);
  if (earlier === null || earlier.kind !== 'validation_result') return null;
  return originalSlots(ctx, earlier, itemId, views, depth + 1);
}

/**
 * The carried items of a submission: each reuse equal to the offer, its fragment read back from the predecessor's result,
 * the judgments it carries, the original slot record (for the re-run checks, references in canonical form) with the evidence
 * of its values. A reuse that no longer reads back is reported in `problems` (path, message), never silently dropped.
 */
export async function carriedItems(
  ctx: EngineContext,
  scope: RunScope,
  resolver: Resolver,
  workflow: LoadedWorkflow,
  run: RunRecord,
  submission: Submission,
): Promise<{ carried: Map<string, CarriedItem>; problems: { path: string; item: string; message: string }[] }> {
  const carried = new Map<string, CarriedItem>();
  const problems: { path: string; item: string; message: string }[] = [];
  const byId = new Map(run.items.map((it) => [it.id, it]));
  const store = ctx.deps.records.store;
  const views: SubmissionViews = new Map();
  for (const [i, entry] of submission.items.entries()) {
    if (entry.handling !== 'handled' || entry.reuse === undefined) continue;
    const item = byId.get(entry.item);
    const path = pointerOf('items', i, 'reuse');
    const fail = (message: string): void => {
      problems.push({ path, item: entry.item, message });
    };
    if (item === undefined || item.reuse !== entry.reuse) continue; // reported by the structure check
    const ref = parsed(entry.reuse);
    if (ref === null || ref.scheme !== 'rec' || ref.pointer === undefined) {
      fail('沿用引用读不回来');
      continue;
    }
    const record = await store.get<ValidationResult>(ref.record);
    const fragment = record === null ? undefined : valueAt(record.body, ref.pointer);
    if (record === null || record.kind !== 'validation_result' || !isObject(fragment) || fragment.item !== entry.item) {
      fail('沿用引用读不回来：前驱的校验结果里没有这个条目');
      continue;
    }
    const original = await originalSlots(ctx, record, entry.item, views);
    if (original === null) {
      fail('沿用引用读不回来：找不到前驱提交里这个条目的槽位记录');
      continue;
    }
    const claims = new Map<string, Claim[]>();
    for (const requirement of (fragment as unknown as ItemResult).requirements) {
      claims.set(requirement.requirement, requirement.claims.filter((c) => c.warrant.producer === 'model'));
    }
    // The original values are re-resolved without the scope check: they are the predecessor's, cited as they were.
    const evidence: ItemEvidence = emptyEvidence();
    const places: QuotePlace[] = [];
    const own = await resolver.resolve(item.location);
    if (own.ok && own.value.text !== null) {
      evidence.texts.set(item.location, own.value.text);
      places.push({ reference: item.location, text: own.value.text });
    }
    const errors: ProtocolError[] = [];
    evidence.slots = await resolveSlots(scope, resolver, workflow, original.slots, i, entry.item, evidence, places, errors, false);
    if (errors.length > 0) {
      fail(`沿用的陈述现在解析不出：${errors[0].message}`);
      continue;
    }
    carried.set(entry.item, { reuse: entry.reuse, slots: original.slots, claims, evidence, origin: original.origin });
  }
  return { carried, problems };
}
