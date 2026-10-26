// Pure round planning for one dispatch command. The service writes the records; this file does not.
import type { Aggregation } from '../../contracts/generated/vocabulary.ts';
import { withinCountBudget, type RepetitionPolicy } from '../runs/engine/repetition.ts';

export interface RoundPolicy extends RepetitionPolicy {
  fresh_context: boolean;
  baseline_first: boolean;
  window_seconds?: number;
  /** Smallest repetition written on a releasing effect row, or the frozen count when none writes one. */
  limit: number;
}

/** The frozen requirement policy, with a dispatch row's written count winning (V07 R[5]). Absent means one round. */
export function roundPolicy(
  run: { requirements?: ReadonlyArray<{ key?: string; repetition?: { count: number; aggregation: Aggregation; k?: number; fresh_context?: boolean; baseline_first?: boolean; window_seconds?: number } }> },
  effects: ReadonlyArray<{ release: { requirements: readonly string[] }; repetition?: number }>,
  requirement: string,
): RoundPolicy {
  const frozen = run.requirements?.find((row) => row.key === requirement)?.repetition;
  const written = effects.filter((effect) => effect.release.requirements.includes(requirement) && effect.repetition !== undefined).map((effect) => effect.repetition as number);
  const count = written.length > 0 ? Math.min(...written) : frozen?.count ?? 1;
  return {
    count,
    aggregation: frozen?.aggregation ?? 'all',
    ...(frozen?.k === undefined ? {} : { k: frozen.k }),
    fresh_context: frozen?.fresh_context === true,
    baseline_first: frozen?.baseline_first === true,
    ...(frozen?.window_seconds === undefined ? {} : { window_seconds: frozen.window_seconds }),
    limit: written.length > 0 ? Math.min(...written) : count,
  };
}

/** One round with none of the shaping flags keeps the single-submit path. */
export function repeats(policy: RoundPolicy): boolean {
  return policy.count > 1 || policy.fresh_context || policy.baseline_first || policy.window_seconds !== undefined;
}

/** Legacy intents have no round and are round 1. */
export function roundOf(detail: { round?: unknown }): number {
  return typeof detail.round === 'number' && Number.isInteger(detail.round) && detail.round >= 1 ? detail.round : 1;
}

/** Round 1 of a single-round dispatch keeps `dispatch.bytes:<S>:<attempt>`. Later rounds add the round. */
export function bytesKey(sha: string, round: number, attempt: number, multi: boolean): string {
  return multi ? `dispatch.bytes:${sha}:${round}:${attempt}` : `dispatch.bytes:${sha}:${attempt}`;
}

export function roundAllowed(round: number, policy: RoundPolicy): boolean {
  return withinCountBudget(round, policy, policy.limit);
}

/** A pass meets a support expectation; a fail meets only a refute expectation that names its code. */
export function roundMeets(terminal: string, code: string | undefined, expectation: { outcome: string; codes: readonly string[] }): boolean {
  if (terminal === 'pass') return expectation.outcome === 'support';
  if (terminal === 'fail') return expectation.outcome === 'refute' && code !== undefined && expectation.codes.includes(code);
  return false;
}

export function earlyStopSentence(passedRound: number, remaining: number): string {
  const which = passedRound === 1 ? '首轮' : `第 ${passedRound} 轮`;
  return `${which}通过，按策略提前停，剩 ${remaining} 轮未跑`;
}
