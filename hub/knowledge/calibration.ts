// Calibration of a typed-judgment chain (K04 R[1]): frozen samples per chain and exact model version; the threshold gates
// descents, so it is the lowest probability at which the precision of the descents at or above it (answers that chose a
// child; an abstention never descends and does not count) has a Wilson lower bound of at least 0.95 over at least 30 of
// them. Below that, or without samples, the chain is uncalibrated and nothing is placed below the parent.
import type { CalibrationSample, KnowledgeCalibrationBody } from '../../contracts/src/knowledge.ts';
import { CalibrationSample as CalibrationSampleShape } from '../../contracts/src/knowledge.ts';
import { NONE_OPTION } from '../jev/api.ts';
import type { Principal, Principals } from '../records/api.ts';
import { compareText, cutText } from './digest.ts';
import { KnowledgeError } from './errors.ts';
import { INDEX, SCHEMAS, type KnowledgeStore } from './store.ts';

/** The calibration rule: required precision, smallest sample, and z of the two-sided 95 % Wilson interval. */
export const CALIBRATION = { precision: 0.95, minSamples: 30, z: 1.959963984540054 } as const;

/** The chain of hierarchical single-choice placement (K04). */
export const PLACEMENT_CHAIN = 'placement.choice';

/** Lower end of the Wilson score interval for `correct` successes in `total` trials; 0 for no trials. */
export function wilsonLowerBound(correct: number, total: number, z: number = CALIBRATION.z): number {
  if (!Number.isSafeInteger(correct) || !Number.isSafeInteger(total) || correct < 0 || total < 0 || correct > total) {
    throw new RangeError('correct and total are integers with 0 <= correct <= total');
  }
  if (total === 0) return 0;
  const p = correct / total;
  const z2 = z * z;
  const centre = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));
  return Math.max(0, (centre - margin) / (1 + z2 / total));
}

export interface ThresholdResult {
  /** Null when no probability qualifies: the chain is uncalibrated. */
  threshold: number | null;
  /** Descents at or above the threshold, how many chose the right child, and their Wilson lower bound (null when uncalibrated). */
  samples: number;
  correct: number;
  lower: number | null;
}

/**
 * The lowest sample probability whose descents at or above it reach the precision bound with enough of them. A descent is
 * a sample whose chosen option is a child (not the none option); it is right when that child is the expected option, so a
 * child chosen where none was expected is a wrong descent. Abstentions are left out: they never descend.
 */
export function thresholdOf(samples: readonly CalibrationSample[], rule: { precision?: number; minSamples?: number; z?: number } = {}): ThresholdResult {
  const precision = rule.precision ?? CALIBRATION.precision;
  const minSamples = rule.minSamples ?? CALIBRATION.minSamples;
  const z = rule.z ?? CALIBRATION.z;
  const sorted = samples.filter((s) => s.chosen !== NONE_OPTION).sort((a, b) => a.probability - b.probability);
  let correctAbove = sorted.filter((s) => s.chosen === s.expected).length;
  for (let i = 0; i < sorted.length; ) {
    const t = sorted[i].probability;
    const n = sorted.length - i;
    if (n < minSamples) break;
    const lower = wilsonLowerBound(correctAbove, n, z);
    if (lower >= precision) return { threshold: t, samples: n, correct: correctAbove, lower };
    // Skip every sample at this probability: they all leave the set together when the threshold rises above t.
    while (i < sorted.length && sorted[i].probability === t) {
      if (sorted[i].chosen === sorted[i].expected) correctAbove--;
      i++;
    }
  }
  return { threshold: null, samples: 0, correct: 0, lower: null };
}

export interface CalibrationState {
  kind: string;
  model: string;
  /** Null: uncalibrated. */
  threshold: number | null;
  /** Distinct samples (by input digest; a later set wins). */
  samples: number;
  atThreshold: { samples: number; correct: number; lower: number } | null;
  /** Digests of the calibration-set records, oldest first. */
  sets: string[];
}

export interface LabelledSamplesInput {
  kind: string;
  model: string;
  samples: CalibrationSample[];
  note?: string | null;
}

/** Calibration sets stored as append-only knowledge-calibration@1 records. */
export class CalibrationStore {
  readonly #store: KnowledgeStore;
  readonly #principals: Pick<Principals, 'get'>;

  constructor(store: KnowledgeStore, principals: Pick<Principals, 'get'>) {
    this.#store = store;
    this.#principals = principals;
  }

  /** The current calibration of a chain and exact model version. */
  async state(kind: string, model: string): Promise<CalibrationState> {
    const sets = await this.#store.calibrationSets(kind, model);
    const byInput = new Map<string, CalibrationSample>();
    for (const set of sets) for (const sample of set.body.samples) byInput.set(sample.input, sample);
    const samples = [...byInput.keys()].sort(compareText).map((key) => byInput.get(key) as CalibrationSample);
    const result = thresholdOf(samples);
    return {
      kind,
      model,
      threshold: result.threshold,
      samples: samples.length,
      atThreshold: result.threshold === null || result.lower === null ? null : { samples: result.samples, correct: result.correct, lower: result.lower },
      sets: sets.map((set) => set.record.digest),
    };
  }

  async threshold(kind: string, model: string): Promise<number | null> {
    return (await this.state(kind, model)).threshold;
  }

  /** Appends a frozen set. Projected sets come from code placement (buildCalibrationSet); declared ones from an admin. */
  async append(body: KnowledgeCalibrationBody): Promise<string> {
    const provenance = body.origin;
    const record = await this.#store.putClaim(SCHEMAS.calibration, provenance, body, [{ key: INDEX.calibration, value: `${body.kind}/${body.model}` }]);
    return record.digest;
  }

  /** Owner-labelled samples (K04 R[1]): an administrator states the right answer for judged inputs. */
  async addLabelled(by: Principal, input: LabelledSamplesInput): Promise<string> {
    const account = await this.#principals.get(by?.id);
    if (account === null || account.disabled || account.role !== 'admin') throw new KnowledgeError('只有管理员可以添加标注的校准样例');
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(input.kind)) throw new KnowledgeError('校准链的名称不合格');
    if (typeof input.model !== 'string' || input.model === '') throw new KnowledgeError('校准样例要写明模型的确切版本');
    if (!input.model.isWellFormed()) throw new KnowledgeError('模型版本里有不成对的代理字符');
    const samples = input.samples.map((sample, index) => {
      const parsed = CalibrationSampleShape.safeParse(sample);
      if (!parsed.success || !parsed.data.expected.isWellFormed() || !parsed.data.chosen.isWellFormed()) throw new KnowledgeError(`第 ${index + 1} 个校准样例不合格`);
      return parsed.data;
    });
    if (samples.length === 0) throw new KnowledgeError('至少要有一个校准样例');
    const note = input.note === undefined || input.note === null ? null : cutText(input.note, 1000);
    return this.append({ kind: input.kind, model: input.model, origin: 'declared', samples, decided_by: account.id, root: null, note });
  }
}

const MASK = '□';
const ASCII = /^[\x20-\x7e]+$/;

/**
 * Masks literal command words in a span (K04 calibration): every literal, longest first, case-insensitive; ASCII literals
 * only as whole words (white space between their words may vary), others as plain substrings.
 */
export function maskLiterals(text: string, literals: readonly string[]): string {
  const unique = [...new Set(literals.map((literal) => literal.trim()).filter((literal) => literal.length > 0))].sort((a, b) => b.length - a.length || compareText(a, b));
  let out = text;
  for (const literal of unique) {
    const words = literal.split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (ASCII.test(literal)) {
      out = out.replace(new RegExp(`(?<![A-Za-z0-9_])${words.join('\\s+')}(?![A-Za-z0-9_])`, 'gi'), MASK);
    } else {
      out = out.replace(new RegExp(words.join('\\s+'), 'giu'), MASK);
    }
  }
  return out;
}
