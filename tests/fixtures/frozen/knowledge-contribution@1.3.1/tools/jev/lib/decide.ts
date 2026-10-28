// Client-side adaptation of the repository pure judgment rules; never imported by Hub runtime.
// Pure helpers for the placement policy (K04 R[1]): the service never abstains, so picking the none option, a tie, a
// non-finite value, a missing threshold (uncalibrated chain) or a probability below the threshold all stop at the parent.
import type { JevAnswer } from './api.ts';

/** Name of the explicit "nothing fits" option the knowledge package adds to every choice question. */
export const NONE_OPTION = 'none';

export interface DecideOptions {
  /** The none option of a choice question; default 'none'. For a yes/no answer, 'false' plays this part. */
  noneOption?: string;
}

export interface TopChoice {
  /** The most probable candidate ('true'/'false' for yes/no, the level for a score). */
  choice: string;
  p: number;
  /** p minus the next highest probability; 0 on a tie. */
  margin: number;
  isNone: boolean;
}

function distributionOf(answer: JevAnswer): Array<[string, number]> {
  if (answer.type === 'noul') return [['true', answer.noul], ['false', 1 - answer.noul]];
  const probabilities: unknown = answer.probabilities;
  if (probabilities === null || typeof probabilities !== 'object') return [];
  return Object.entries(probabilities as { [name: string]: unknown }).map(([name, p]): [string, number] => [name, typeof p === 'number' ? p : Number.NaN]);
}

export function topChoice(answer: JevAnswer, options: DecideOptions = {}): TopChoice {
  const noneOption = options.noneOption ?? NONE_OPTION;
  const distribution = distributionOf(answer);
  let choice = '';
  let best = Number.NEGATIVE_INFINITY;
  let second = Number.NEGATIVE_INFINITY;
  let broken = distribution.length === 0;
  for (const [name, p] of distribution) {
    if (!Number.isFinite(p)) broken = true;
    if (p > best) {
      second = best;
      best = p;
      choice = name;
    } else if (p > second) {
      second = p;
    }
  }
  // Keep the service's own pick when it is tied for the top.
  if (answer.type === 'choice' && typeof answer.choice === 'string' && answer.probabilities[answer.choice] === best) choice = answer.choice;
  const isNone = answer.type === 'noul' ? choice === 'false' : choice === noneOption;
  if (broken) return { choice, p: Number.NaN, margin: Number.NaN, isNone };
  return { choice, p: best, margin: distribution.length > 1 ? best - second : best, isNone };
}

/**
 * Descend one level only when the top candidate is not the none option, is not tied, and its probability is finite and
 * not below the threshold. A null or invalid threshold (an uncalibrated chain) never descends.
 */
export function shouldDescend(answer: JevAnswer, threshold: number | null, options: DecideOptions = {}): boolean {
  if (threshold === null || typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) return false;
  const top = topChoice(answer, options);
  if (top.isNone || !Number.isFinite(top.p) || !Number.isFinite(top.margin) || top.margin <= 0) return false;
  return top.p >= threshold;
}
