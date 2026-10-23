// Client calibration math adapted from the repository pure rules.
import { NONE_OPTION } from './decide.ts';
const compareText=(a:string,b:string)=>a<b?-1:a>b?1:0;
interface CalibrationSample {input:string;expected:string;chosen:string;probability:number}
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
