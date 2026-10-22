// Placement by the typed-judgment model (K04): spans the code could not place descend from the root, one single choice per
// level among the children of the node they are at, with an explicit "none" option (the service never abstains). Choosing
// none, a tie, an unversioned answer or a probability below the chain's calibrated threshold stops at the parent; an
// uncalibrated chain never descends and keeps the answer only as a candidate. More than 254 children are narrowed by literal
// match first. Every judgment is a classify action (exact model, question, candidates, input digest, probabilities) and is
// reused while what the model saw is unchanged (K04 R[2]). Placement decides the position only, never the content.
import {
  MAX_CHOICE_OPTIONS,
  NONE_OPTION,
  askAll,
  batchRequest,
  inputDigest,
  judgmentRecord,
  planBatches,
  reuseKey,
  shouldDescend,
  topChoice,
} from '../jev/api.ts';
import type { JevBatch, JevBatchItem, JevChoiceQuestion, JevClient, JevJudgmentRecord, JevPlan, JevRequest } from '../jev/api.ts';
import type { ActionBody, IndexEntry } from '../records/api.ts';
import { pathOf } from '../refs/api.ts';
import { compareText, cutText } from './digest.ts';
import { describeError } from './errors.ts';
import { ACTION, COMPONENTS, INDEX, type KnowledgeStore } from './store.ts';

/** Real options of one question: the service takes 255, one of them is the none option. */
export const MAX_REAL_OPTIONS = MAX_CHOICE_OPTIONS - 1;
/** Longest option description of a placement question (UTF-16 units, cut on characters). */
export const MAX_DESCRIPTION = 160;
const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/;

export interface PlacementChild {
  name: string;
  /** Shown to the model beside the option, for example the first line of the child's first entry. */
  description: string | null;
}

/** The tree spans are placed into: the children of a node, in order. */
export interface PlacementTree {
  children(segments: readonly string[]): Promise<PlacementChild[]> | PlacementChild[];
}

export interface PlacementSpan {
  /** Stable identity of the span's content (an entry digest): equal content, equal key. */
  key: string;
  text: string;
  section: string;
  /** Canonical src reference of the span, recorded as the input of its judgments. */
  fragment: string;
}

export interface PlacementOutcome {
  key: string;
  /** Where the span ends: the node it is hung on, or where it stopped. */
  segments: string[];
  /** Descended at least one level: hung on the tree. */
  placed: boolean;
  model: string | null;
  /** Probability of the last choice that descended, when placed. */
  p: number | null;
  threshold: number | null;
  calibrated: boolean;
  /** Classify action digests, root first. */
  judgments: string[];
  /** The model's last named child when that choice did not descend (uncalibrated, below the threshold, a tie). */
  candidate: { segments: string[]; p: number } | null;
  /** The judge did not answer (a service failure): asking again may place the span. */
  failed: boolean;
  /** Chinese display text (K04 R[5]). */
  note: string;
}

export interface PlaceOptions {
  /** Calibrated threshold of the chain for the client's exact model; null when uncalibrated. */
  threshold: number | null;
  /** Context recorded with every judgment. */
  context: { product: string; build?: string | null };
  maxDepth?: number;
  /** Judgment time; default the clock. */
  now?: () => Date;
  /** Receives the internal detail of a question that could not be asked or answered (for the admin), never shown in a note. */
  onProblem?: (text: string) => void;
}

/** One question about one span at one node, before it is asked. */
interface Asked {
  id: string;
  piece: { text: string; section: string };
  question: JevChoiceQuestion;
  /** option -> child name */
  options: Map<string, string>;
  segments: string[];
  span: PlacementSpan;
}

interface Answered {
  record: JevJudgmentRecord;
  action: string;
}

/** A question that got no answer; `transient` when the service failed (not the question itself). */
interface Unanswered {
  error: string;
  transient: boolean;
}

/** Text of the K04 R[5] note. */
export function placementNote(model: string | null, p: number | null): string {
  return `归类判断：Jev@${model ?? '版本未知'}，p=${p === null ? '—' : p.toFixed(2)}，只影响位置`;
}

/** A probability in [0, 1] cut (never rounded up) to `digits` decimals. */
function cutDecimals(value: number, digits: number): string {
  const scale = 10 ** digits;
  // The small tolerance keeps binary fractions such as 0.29 * 100 = 28.999… on their decimal value.
  return (Math.floor(value * scale + 1e-9) / scale).toFixed(digits);
}

/** p and a threshold above it, with as many decimals (at least two) as it takes to show that p is lower; cut, never rounded up. */
export function belowThreshold(p: number, threshold: number): [string, string] {
  for (let digits = 2; digits <= 12; digits++) {
    const a = cutDecimals(p, digits);
    const b = cutDecimals(threshold, digits);
    if (a !== b) return [a, b];
  }
  return [String(p), String(threshold)];
}

/** Keeps children whose name appears in the span (case-insensitive) when there are more than the service takes. */
export function narrowCandidates(children: readonly PlacementChild[], text: string): PlacementChild[] | null {
  if (children.length <= MAX_REAL_OPTIONS) return [...children];
  const folded = text.normalize('NFC').toLowerCase();
  const kept = children.filter((child) => folded.includes(child.name.normalize('NFC').toLowerCase()));
  return kept.length === 0 || kept.length > MAX_REAL_OPTIONS ? null : kept;
}

/** Option names for children: the name itself when the service can take it, else child-<k>. */
export function optionNames(children: readonly PlacementChild[]): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>([NONE_OPTION]);
  children.forEach((child, index) => {
    const name = child.name;
    const usable =
      name.length <= 128 && name.trim() === name && name !== '' && name !== NONE_OPTION && !ARRAY_INDEX.test(name) && name !== '__proto__' && !/\p{Cc}/u.test(name) && name.isWellFormed();
    let option = usable ? name : `child-${index + 1}`;
    while (taken.has(option)) option = `${option}-${index + 1}`;
    taken.add(option);
    out.set(option, name);
  });
  return out;
}

/** The question about a span at a node; deterministic in the span's key, the node and its children. */
export function placementQuestion(id: string, segments: readonly string[], children: readonly PlacementChild[], options: Map<string, string>): JevChoiceQuestion {
  const where = segments.length === 0 ? 'the root of the knowledge tree' : `the knowledge tree node ${pathOf(segments)}`;
  const criteria: { [option: string]: string | null } = {};
  const byName = new Map(children.map((child) => [child.name, child]));
  for (const [option, name] of options) {
    const description = byName.get(name)?.description ?? null;
    criteria[option] = description === null ? (option === name ? null : name) : cutText(`${option === name ? '' : `${name}: `}${description}`, MAX_DESCRIPTION);
  }
  criteria[NONE_OPTION] = 'None of the listed children fits the passage, or it is about the node itself.';
  return {
    type: 'choice',
    instructions:
      `Classify the passage \`${id}\` by what it is about. Under ${where}, which child should it be filed under? ` +
      `Pick the child the passage describes; pick ${NONE_OPTION} when no child fits.`,
    criteria,
  };
}

/** Stable question id for a span at a node. */
export function questionId(key: string, segments: readonly string[]): string {
  return `q${inputDigest({ span: key, node: [...segments] }).slice(0, 40)}`;
}

/**
 * Identity of a calibration sample: the judged piece (the input digest of its judgment) at one node, since a piece is asked
 * once per level. Owner-labelled samples of recorded judgments use the same identity.
 */
export function sampleInput(pieceDigest: string, segments: readonly string[]): string {
  return inputDigest({ piece: pieceDigest, node: pathOf(segments) });
}

export interface PlacerDeps {
  jev: JevClient | null;
  store: KnowledgeStore;
  now: () => Date;
}

export class Placer {
  readonly #deps: PlacerDeps;

  constructor(deps: PlacerDeps) {
    this.#deps = deps;
  }

  get model(): string | null {
    return this.#deps.jev?.pinnedModel ?? null;
  }

  /** Places every span; spans with the same key are placed once. */
  async place(spans: readonly PlacementSpan[], tree: PlacementTree, options: PlaceOptions): Promise<Map<string, PlacementOutcome>> {
    const out = new Map<string, PlacementOutcome>();
    const unique = new Map<string, PlacementSpan>();
    for (const span of spans) if (!unique.has(span.key)) unique.set(span.key, span);
    const jev = this.#deps.jev;
    if (jev === null) {
      for (const span of unique.values()) out.set(span.key, stopped(span, [], null, options.threshold, [], null, '没有归位器（Hub 不调用任何模型），片段留在根下、标为未归位'));
      return out;
    }
    const model = jev.pinnedModel;
    const maxDepth = options.maxDepth ?? 64;
    type State = { span: PlacementSpan; segments: string[]; judgments: string[]; p: number | null };
    let active: State[] = [...unique.values()].sort((a, b) => compareText(a.key, b.key)).map((span) => ({ span, segments: [], judgments: [], p: null }));
    const finish = (state: State, outcome: PlacementOutcome): void => void out.set(state.span.key, outcome);
    // Ends a span where it is; `why` is shown unless the span simply reached a leaf.
    const reached = (state: State, why: string | null, failed = false): void => {
      if (state.segments.length === 0) finish(state, { ...stopped(state.span, [], model, options.threshold, state.judgments, null, why ?? '树里没有可选的子节点'), failed });
      else {
        const outcome = placed(state.span, state.segments, model, state.p, options.threshold, state.judgments);
        finish(state, why === null ? outcome : { ...outcome, failed, note: `${outcome.note}；${why}，停在 ${pathOf(state.segments)}` });
      }
    };
    for (let depth = 0; depth < maxDepth && active.length > 0; depth++) {
      const asked: Asked[] = [];
      for (const state of active) {
        const children = await tree.children(state.segments);
        if (children.length === 0) {
          reached(state, state.segments.length === 0 ? '树里没有可选的子节点' : null);
          continue;
        }
        const candidates = narrowCandidates(children, state.span.text);
        if (candidates === null) {
          reached(state, `可选子节点有 ${children.length} 个，超过 ${MAX_REAL_OPTIONS} 个，按字面缩小后仍无法提问`);
          continue;
        }
        const names = optionNames(candidates);
        const id = questionId(state.span.key, state.segments);
        asked.push({ id, piece: { text: state.span.text, section: state.span.section }, question: placementQuestion(id, state.segments, candidates, names), options: names, segments: state.segments, span: state.span });
      }
      const answers = await this.#judge(asked, options);
      const askedBySpan = new Map(asked.map((a) => [a.span.key, a]));
      const next: State[] = [];
      for (const state of active) {
        if (out.has(state.span.key)) continue;
        const item = askedBySpan.get(state.span.key);
        if (item === undefined) continue;
        const answer = answers.get(item.id);
        if (answer === undefined || 'error' in answer) {
          if (answer === undefined) reached(state, '归类判断没有回答', true);
          else reached(state, answer.error, answer.transient);
          continue;
        }
        state.judgments.push(answer.action);
        const record = answer.record;
        const top = topChoice(record.answer);
        const child = top.isNone ? null : (item.options.get(top.choice) ?? null);
        const exact = record.exact_model;
        const calibrated = options.threshold !== null && exact !== null && exact === model;
        if (calibrated && child !== null && shouldDescend(record.answer, options.threshold)) {
          state.segments = [...state.segments, child];
          state.p = top.p;
          next.push(state);
          continue;
        }
        const candidate = child === null || !Number.isFinite(top.p) ? null : { segments: [...state.segments, child], p: top.p };
        const where = pathOf(state.segments);
        let why: string;
        if (!calibrated) why = `本链尚未校准（Jev@${exact ?? '版本未知'}），回答只作候选，停在 ${where}`;
        else if (top.isNone) why = `模型选了“都不合适”（弃权），停在 ${where}`;
        else if (!Number.isFinite(top.p) || !Number.isFinite(top.margin)) why = `回答里的概率不是有限数，停在 ${where}`;
        else if (!(top.margin > 0)) why = `最高的两个选项概率相同，停在 ${where}`;
        else {
          const [p, threshold] = belowThreshold(top.p, options.threshold as number);
          why = `p=${p} 低于本链的校准阈值 ${threshold}，停在 ${where}`;
        }
        const answeredP = Number.isFinite(top.p) ? top.p : null;
        if (state.segments.length === 0) finish(state, stopped(state.span, [], model, options.threshold, state.judgments, candidate, why, calibrated, record.exact_model, answeredP));
        else finish(state, { ...placed(state.span, state.segments, model, state.p, options.threshold, state.judgments), candidate, note: `${placementNote(model, state.p)}；${why}` });
      }
      active = next;
    }
    for (const state of active) if (!out.has(state.span.key)) reached(state, `超过 ${maxDepth} 层，停止`);
    return out;
  }

  /**
   * Asks the questions, reusing a recorded judgment when every question of a planned request has one under the reuse key
   * of the very state it would be asked with. New judgments are recorded as classify actions.
   */
  async #judge(asked: Asked[], options: PlaceOptions): Promise<Map<string, Answered | Unanswered>> {
    const out = new Map<string, Answered | Unanswered>();
    const jev = this.#deps.jev;
    if (jev === null || asked.length === 0) return out;
    const model = jev.pinnedModel;
    const byId = new Map(asked.map((item) => [item.id, item]));
    let items: JevBatchItem[] = [...asked].sort((a, b) => compareText(a.id, b.id)).map((item) => ({ id: item.id, piece: item.piece, question: item.question }));
    const refuse = (item: JevBatchItem, error: unknown): void => {
      // Counted as a failure (transient), so that a later sync asks again once the Hub is fixed; the detail is for the admin.
      options.onProblem?.(`问题 ${item.id} 没能组成：${describeError(error)}`);
      out.set(item.id, { error: '归类问题没能组成（Hub 内部的问题），这一层没有提问', transient: true });
    };
    let plan: JevPlan;
    try {
      plan = planBatches(items);
    } catch {
      // One question the service would refuse fails only itself: find it by planning each alone, then plan the rest together.
      items = items.filter((item) => {
        try {
          planBatches([item]);
          return true;
        } catch (error) {
          refuse(item, error);
          return false;
        }
      });
      try {
        plan = planBatches(items);
      } catch (error) {
        for (const item of items) refuse(item, error);
        return out;
      }
    }
    for (const over of plan.oversized) out.set(over.item.id, { error: '片段太长，超过一次判断能带的内容，无法提问', transient: false });
    const toAsk: JevBatch[] = [];
    for (const batch of plan.batches) {
      const request = batchRequest(model, plan, batch.items);
      const stateDigest = inputDigest(request.state);
      const found = new Map<string, Answered>();
      for (const item of batch.items) {
        const key = reuseKey({ model, question: item.question, stateDigest });
        const stored = key === null ? null : await this.#deps.store.judgment(key);
        const judgment = stored === null ? null : ((stored.body.detail as { judgment?: JevJudgmentRecord }).judgment ?? null);
        if (stored !== null && judgment !== null) found.set(item.id, { record: judgment, action: stored.digest });
      }
      if (found.size === batch.items.length) for (const [id, answered] of found) out.set(id, answered);
      else toAsk.push(batch);
    }
    if (toAsk.length === 0) return out;
    const startedAt = (options.now ?? this.#deps.now)().toISOString();
    const result = await askAll(jev, { ...plan, batches: toAsk, oversized: [] });
    for (const batch of toAsk) {
      for (const item of batch.items) {
        const asked = byId.get(item.id) as Asked;
        const answered = result.answered.get(item.id);
        if (answered === undefined) {
          const error = result.failed.get(item.id);
          const reason = cutText(`归类判断失败：${error === undefined ? '没有回答' : `${error.code} ${error.message}`}`, 500);
          await this.#record(asked, null, null, startedAt, options, reason);
          options.onProblem?.(`问题 ${item.id}：${reason}`);
          out.set(item.id, { error: '归类判断服务没有回答（下次同步会再问）', transient: true });
          continue;
        }
        const record = judgmentRecord({ request: answered.request, response: answered.response, questionId: item.id, input: item.piece, at: (options.now ?? this.#deps.now)().toISOString() });
        const action = await this.#record(asked, record, answered.request, startedAt, options, null);
        out.set(item.id, { record, action });
      }
    }
    return out;
  }

  async #record(asked: Asked, record: JevJudgmentRecord | null, request: JevRequest | null, startedAt: string, options: PlaceOptions, failure: string | null): Promise<string> {
    const endedAt = (options.now ?? this.#deps.now)().toISOString();
    const body: ActionBody = {
      action: ACTION.classify,
      run: null,
      item: null,
      inputs: [asked.span.fragment],
      component: COMPONENTS.placement,
      lease: null,
      started_at: startedAt,
      ended_at: endedAt,
      result: record === null ? 'error' : 'completed',
      error_code: null,
      acceptance: null,
      codes: [],
      detail: {
        product: options.context.product,
        build: options.context.build ?? null,
        span: asked.span.key,
        node: pathOf(asked.segments),
        options: Object.fromEntries(asked.options),
        request_questions: request === null ? null : Object.keys(request.questions).length,
        judgment: record,
        failure,
      },
    };
    const index: IndexEntry[] = [];
    if (record !== null && record.reuse_key !== null) index.push({ key: INDEX.reuse, value: record.reuse_key });
    if (record !== null) index.push({ key: INDEX.judgmentInput, value: record.input_digest });
    const stored = await this.#deps.store.putAction(body, index);
    return stored.digest;
  }

  /**
   * Asks the placement question for prepared calibration pieces (masked spans with a known right answer: a child, or null
   * when none of the children is right because the piece belongs to the node itself) and returns the samples: expected
   * option, chosen option and its probability.
   */
  async sample(
    questions: Array<{ key: string; text: string; section: string; fragment: string; segments: string[]; children: PlacementChild[]; expected: string | null }>,
    context: PlaceOptions['context'],
  ): Promise<Array<{ input: string; expected: string; chosen: string; probability: number }>> {
    const asked: Asked[] = [];
    const expectedOf = new Map<string, string>();
    for (const q of questions) {
      const candidates = narrowCandidates(q.children, q.text);
      if (candidates === null || candidates.length === 0) continue;
      if (q.expected !== null && !candidates.some((child) => child.name === q.expected)) continue;
      const names = optionNames(candidates);
      const option = q.expected === null ? NONE_OPTION : [...names].find(([, name]) => name === q.expected)?.[0];
      if (option === undefined) continue;
      const id = questionId(`calibration:${q.key}`, q.segments);
      if (expectedOf.has(id)) continue;
      expectedOf.set(id, option);
      asked.push({ id, piece: { text: q.text, section: q.section }, question: placementQuestion(id, q.segments, candidates, names), options: names, segments: q.segments, span: { key: q.key, text: q.text, section: q.section, fragment: q.fragment } });
    }
    const answers = await this.#judge(asked, { threshold: null, context });
    const samples: Array<{ input: string; expected: string; chosen: string; probability: number }> = [];
    for (const item of asked) {
      const answer = answers.get(item.id);
      if (answer === undefined || 'error' in answer) continue;
      const top = topChoice(answer.record.answer);
      if (!Number.isFinite(top.p)) continue;
      // One piece is asked at every level of its path: a sample is the piece at one node.
      samples.push({ input: sampleInput(answer.record.input_digest, item.segments), expected: expectedOf.get(item.id) as string, chosen: top.choice, probability: top.p });
    }
    return samples;
  }
}

function stopped(
  span: PlacementSpan,
  segments: string[],
  model: string | null,
  threshold: number | null,
  judgments: string[],
  candidate: PlacementOutcome['candidate'],
  why: string,
  calibrated = false,
  exact: string | null = null,
  answered: number | null = null,
): PlacementOutcome {
  const p = answered ?? candidate?.p ?? null;
  // Without any judgment there is no model answer to quote, only the reason.
  const note = model === null || judgments.length === 0 ? why : `${placementNote(exact ?? model, p)}；${why}`;
  return { key: span.key, segments, placed: false, model, p: null, threshold, calibrated, judgments: [...judgments], candidate, failed: false, note };
}

function placed(span: PlacementSpan, segments: string[], model: string | null, p: number | null, threshold: number | null, judgments: string[]): PlacementOutcome {
  return { key: span.key, segments: [...segments], placed: true, model, p, threshold, calibrated: true, judgments: [...judgments], candidate: null, failed: false, note: placementNote(model, p) };
}
