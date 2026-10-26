// Repetition policy (V07). Pure: rounds already judged against the check contract, the frozen policy and the work class
// go in; a summary comes out. No records, no dispatch, no clock. Vocabulary values come from the generated axes.
import {
  AggregationSchema,
  DYNAMIC_TERMINAL,
  DynamicTerminalSchema,
  WorkClassSchema,
  labelOf,
  type Aggregation,
  type DynamicTerminal,
  type ExitAction,
  type Layer,
  type QualifierMark,
  type RequirementStatus,
  type UnsatisfiedReason,
  type WorkClass,
} from '../../../contracts/generated/vocabulary.ts';

const ALL = 'all' as const satisfies Aggregation;
const K_OF_N = 'k_of_n' as const satisfies Aggregation;
const FIRST_PASS = 'first_pass' as const satisfies Aggregation;
const PASS = 'pass' as const satisfies DynamicTerminal;
const NOT_RUN = 'not_run' as const satisfies DynamicTerminal;
const DYNAMIC = 'dynamic' as const satisfies Layer;

/** V07: a determined mix of meeting and missing rounds. Causes of the mix stay out of attribution (V04 R[0]). */
export const INTERMITTENT_MARK = 'intermittent' as const satisfies QualifierMark;

/**
 * Missing rounds are re-judged by the Hub (V07 R[0]). This is not a new-revision exit: audience and due are bound
 * when the summary is written onto a layer.
 */
export const RERUN_ROUNDS = 'reevaluate' as const satisfies ExitAction;

/** One dynamic round that has already passed the integrity rules (V03 R[5]). `meets` is omitted when the round has no judgment. */
export interface RoundOutcome {
  round: number;
  terminal: DynamicTerminal;
  code?: string;
  meets?: boolean;
}

/** Frozen repetition: count, aggregation, and k only for k-of-n (V07 DEF). */
export interface RepetitionPolicy {
  count: number;
  aggregation: Aggregation;
  k?: number;
}

export interface ObservedRound {
  round: number;
  terminal: DynamicTerminal;
  code?: string;
  /** Null when this round has no judgment. */
  meets: boolean | null;
}

/** V07 R[3]: the count, how many rounds showed each terminal, and every round. */
export interface ObservationDistribution {
  count: number;
  byTerminal: Record<DynamicTerminal, number>;
  rounds: ObservedRound[];
}

/** The earliest settled round that missed the expectation (V05 R[7], V07 R[0], R[2]). */
export interface RoundCause {
  round: number;
  terminal: DynamicTerminal;
  code?: string;
}

export interface RepetitionSummary {
  /** Meets, misses, or still short of a judgment. A mix also carries INTERMITTENT_MARK. */
  outcome: 'meets' | 'misses' | 'undecided';
  status: RequirementStatus;
  unsatisfied_reason?: UnsatisfiedReason;
  terminal: DynamicTerminal;
  code?: string;
  marks: QualifierMark[];
  distribution: ObservationDistribution;
  /** Observation sentence, including the intermittent label when the mark is set (display rule 16, V07 R[3]). */
  text: string;
  firstCause?: RoundCause;
  /** Rounds that still have no judgment. Empty once the aggregate is decided. */
  missingRounds: number[];
  missing?: string;
  /** Present only while the aggregate cannot be decided: re-run these rounds. */
  exit?: { action: ExitAction; rounds: number[] };
}

type Decision = 'meets' | 'misses' | 'undecided';

interface Split {
  meets: RoundOutcome[];
  misses: RoundOutcome[];
  open: RoundOutcome[];
  count: number;
  k: number;
}

/** Settled pass and fail have a judgment; the other dynamic terminals do not (V03 F[1], R[4]). */
const UNSETTLED = {
  pass: false,
  fail: false,
  no_verdict: true,
  not_run: true,
  incomplete: true,
} as const satisfies Record<DynamicTerminal, boolean>;

/**
 * V03 R[3] projection, strongest first: fail, incomplete, no verdict or not run, pass. The undecided aggregate takes
 * the weakest open round; equal strength keeps the earliest round.
 */
const STRENGTH = {
  fail: 4,
  incomplete: 3,
  no_verdict: 2,
  not_run: 2,
  pass: 1,
} as const satisfies Record<DynamicTerminal, number>;

const STATUS_OF = {
  meets: { status: 'satisfied' as const satisfies RequirementStatus },
  misses: { status: 'unsatisfied' as const satisfies RequirementStatus, unsatisfied_reason: 'outcome_mismatch' as const satisfies UnsatisfiedReason },
  undecided: { status: 'pending' as const satisfies RequirementStatus },
} as const satisfies Record<Decision, { status: RequirementStatus; unsatisfied_reason?: UnsatisfiedReason }>;

/** V07 R[0]–R[2]. k equal to the count decides the same way as “all”. */
const DECIDE = {
  all(split: Split): Decision {
    if (split.misses.length > 0) return 'misses';
    if (split.meets.length === split.count && split.open.length === 0) return 'meets';
    return 'undecided';
  },
  k_of_n(split: Split): Decision {
    if (split.meets.length >= split.k) return 'meets';
    if (split.misses.length > split.count - split.k) return 'misses';
    return 'undecided';
  },
  first_pass(split: Split): Decision {
    if (split.meets.length > 0) return 'meets';
    if (split.misses.length === split.count && split.open.length === 0) return 'misses';
    return 'undecided';
  },
} as const satisfies Record<Aggregation, (split: Split) => Decision>;

const CLASS_DEFAULT = {
  verification: { count: 3, aggregation: ALL },
  reproduction: { count: 3, aggregation: ALL },
  web: { count: 2, aggregation: FIRST_PASS },
} as const satisfies Record<WorkClass, { readonly count: number; readonly aggregation: Aggregation }>;

const SINGLE_ROUND: RepetitionPolicy = { count: 1, aggregation: ALL };

export type RepetitionBasis = 'explicit' | 'work_class' | 'single_round';

export interface EffectiveRepetition extends RepetitionPolicy {
  /** explicit: a field was written; work_class: the pack's class; single_round: no class, or a static requirement. */
  basis: RepetitionBasis;
  explicit: { count: boolean; aggregation: boolean; k: boolean };
}

export interface RepetitionRequest {
  workClass?: WorkClass;
  /** Declared layers. A static-only requirement is a single round (V07 R[5]). */
  layers?: readonly Layer[];
  declared?: { count?: number; aggregation?: Aggregation; k?: number };
  /** Count written on the dispatch row. It wins over the requirement and the class default (V07 R[5]). */
  dispatchCount?: number;
}

function assertPolicy(policy: RepetitionPolicy): RepetitionPolicy {
  if (!AggregationSchema.safeParse(policy.aggregation).success || DECIDE[policy.aggregation] === undefined) {
    throw new Error(`聚合方式不在词表里：${String(policy.aggregation)}`);
  }
  if (!Number.isInteger(policy.count) || policy.count < 1 || policy.count > 10) {
    throw new Error(`重复次数须为 1 到 10 的整数：${String(policy.count)}`);
  }
  if (policy.aggregation === K_OF_N) {
    if (policy.k === undefined || !Number.isInteger(policy.k) || policy.k < 1 || policy.k > policy.count) {
      throw new Error(`k-of-n 的 k 须为 1 到次数的整数：${String(policy.k)}`);
    }
    return { count: policy.count, aggregation: policy.aggregation, k: policy.k };
  }
  if (policy.k !== undefined) throw new Error('只有 k-of-n 写 k');
  return { count: policy.count, aggregation: policy.aggregation };
}

function assertRounds(rounds: readonly RoundOutcome[], count: number): RoundOutcome[] {
  const seen = new Set<number>();
  for (const round of rounds) {
    if (!Number.isInteger(round.round) || round.round < 1 || round.round > count) {
      throw new Error(`轮次不在 1 到 ${count} 里：${String(round.round)}`);
    }
    if (seen.has(round.round)) throw new Error(`轮次重复：${round.round}`);
    seen.add(round.round);
    if (!DynamicTerminalSchema.safeParse(round.terminal).success || !Object.hasOwn(UNSETTLED, round.terminal)) {
      throw new Error(`动态层终态不在词表里：${String(round.terminal)}`);
    }
    if (round.code !== undefined && round.code.trim() === '') throw new Error(`第 ${round.round} 轮的码是空的`);
    if (round.terminal === PASS && round.code !== undefined) throw new Error(`第 ${round.round} 轮通过不带码`);
    if (UNSETTLED[round.terminal]) {
      if (round.meets === true) throw new Error(`第 ${round.round} 轮缺判定，不能记成合期望`);
    } else if (typeof round.meets !== 'boolean') {
      throw new Error(`第 ${round.round} 轮已有终态，要写明合不合期望`);
    }
  }
  return [...rounds].sort((a, b) => a.round - b.round);
}

function causeOf(round: RoundOutcome): RoundCause {
  return { round: round.round, terminal: round.terminal, ...(round.terminal === PASS || round.code === undefined ? {} : { code: round.code }) };
}

function weakest(rounds: readonly RoundOutcome[]): RoundOutcome {
  const [first, ...rest] = rounds;
  if (first === undefined) throw new Error('没有可比较的缺判定轮次');
  return rest.reduce((best, round) => (STRENGTH[round.terminal] < STRENGTH[best.terminal] ? round : best), first);
}

function emptyCounts(): Record<DynamicTerminal, number> {
  return Object.fromEntries(DYNAMIC_TERMINAL.map((terminal) => [terminal, 0])) as Record<DynamicTerminal, number>;
}

function distributionOf(rounds: readonly RoundOutcome[], count: number): ObservationDistribution {
  const byTerminal = emptyCounts();
  const observed: ObservedRound[] = [];
  for (const round of rounds) {
    byTerminal[round.terminal] += 1;
    observed.push({
      round: round.round,
      terminal: round.terminal,
      ...(round.code === undefined ? {} : { code: round.code }),
      meets: UNSETTLED[round.terminal] ? null : round.meets === true,
    });
  }
  return { count, byTerminal, rounds: observed };
}

function observationText(distribution: ObservationDistribution, intermittent: boolean, missingRounds: readonly number[]): string {
  const parts = DYNAMIC_TERMINAL.flatMap((terminal) => {
    const found = distribution.byTerminal[terminal];
    return found > 0 ? [`${found} 次${labelOf('dynamic_terminal', terminal)}`] : [];
  });
  const body = parts.join('、');
  if (intermittent) {
    const where = distribution.rounds.filter((round) => round.meets === false).map((round) => round.round);
    return `${labelOf('qualifier_mark', INTERMITTENT_MARK)}：${distribution.count} 次里 ${body}（第 ${where.join('、')} 次）`;
  }
  if (missingRounds.length > 0) {
    const observed = body === '' ? '尚无轮次观察' : `${distribution.count} 次里 ${body}`;
    return `缺第 ${missingRounds.join('、')} 轮的判定；${observed}`;
  }
  const uniformPass = distribution.rounds.length === distribution.count
    && distribution.byTerminal.fail === 0
    && distribution.rounds.every((round) => round.terminal === PASS);
  if (uniformPass) return `${distribution.count}/${distribution.count} 次未见失败`;
  return `${distribution.rounds.length}/${distribution.count} 次：${body}`;
}

/**
 * V07 R[0]–R[3]. Each round is already meets or not. “All” meets only when every round meets, misses on the first miss,
 * and marks a decided mix intermittent. k-of-n uses the threshold. First pass meets on the first meeting round and
 * keeps the earlier miss. An aggregate that cannot be decided takes the weakest open round and names the rounds to re-run.
 */
/** The frozen repetition part of a requirement summary: the policy in force, where it came from, and what each round needs. */
export interface RepetitionSummaryShape {
  count: number;
  aggregation: Aggregation;
  k?: number;
  basis: RepetitionBasis;
  declared: { count: boolean; aggregation: boolean; k: boolean };
  fresh_context?: boolean;
  baseline_first?: boolean;
  window_seconds?: number;
}

/**
 * The one projection both summaries use (`packSummary` in the packs package and `requirementSummary` at start_run), so a
 * pack listing and a frozen run cannot disagree about the policy in force (V07 R[5]).
 */
export function repetitionSummary(
  input: RepetitionRequest & { fresh_context?: boolean; baseline_first?: boolean; window_seconds?: number },
): RepetitionSummaryShape {
  const policy = effectiveRepetition(input);
  return {
    count: policy.count,
    aggregation: policy.aggregation,
    ...(policy.k === undefined ? {} : { k: policy.k }),
    basis: policy.basis,
    declared: { count: policy.explicit.count, aggregation: policy.explicit.aggregation, k: policy.explicit.k },
    ...(input.fresh_context === undefined ? {} : { fresh_context: input.fresh_context }),
    ...(input.baseline_first === undefined ? {} : { baseline_first: input.baseline_first }),
    ...(input.window_seconds === undefined ? {} : { window_seconds: input.window_seconds }),
  };
}

/**
 * The rounds a dispatch row authorizes for one requirement: the smallest count written on the effect rows that release it
 * (V07 R[5]: what the dispatch row writes wins), or undefined when no row writes one.
 */
export function dispatchCountOf(effects: ReadonlyArray<{ release: { requirements: readonly string[] }; repetition?: number }>, requirement: string): number | undefined {
  const written = effects.filter((effect) => effect.release.requirements.includes(requirement) && effect.repetition !== undefined).map((effect) => effect.repetition as number);
  return written.length > 0 ? Math.min(...written) : undefined;
}

export function aggregate(rounds: readonly RoundOutcome[], policy: RepetitionPolicy): RepetitionSummary {
  const frozen = assertPolicy(policy);
  const sorted = assertRounds(rounds, frozen.count);
  const split: Split = { meets: [], misses: [], open: [], count: frozen.count, k: frozen.k ?? frozen.count };
  for (const round of sorted) {
    if (UNSETTLED[round.terminal]) split.open.push(round);
    else if (round.meets === true) split.meets.push(round);
    else split.misses.push(round);
  }
  const decision = DECIDE[frozen.aggregation](split);
  if (decision === 'meets') {
    const expected = split.meets[0];
    if (expected === undefined) throw new Error('合期望却没有合期望的轮');
    for (const round of split.meets) {
      if (round.terminal !== expected.terminal || round.code !== expected.code) {
        throw new Error(`合期望的轮次终态不一致：第 ${expected.round} 轮与第 ${round.round} 轮`);
      }
    }
  }
  const intermittent = decision !== 'undecided' && split.meets.length > 0 && split.misses.length > 0;
  const distribution = distributionOf(sorted, frozen.count);
  const firstMiss = split.misses[0];
  const firstCause = firstMiss === undefined ? undefined : causeOf(firstMiss);
  const missingRounds = decision === 'undecided'
    ? Array.from({ length: frozen.count }, (_, index) => index + 1).filter((round) => {
      const found = sorted.find((item) => item.round === round);
      return found === undefined || UNSETTLED[found.terminal];
    })
    : [];
  // Absent rounds are not run. They compete with observed gaps for the weakest terminal, and stay out of the distribution.
  const gaps = [...split.open];
  if (decision === 'undecided') {
    for (let round = 1; round <= frozen.count; round++) {
      if (!sorted.some((item) => item.round === round)) gaps.push({ round, terminal: NOT_RUN });
    }
  }
  const selected = decision === 'meets' ? split.meets[0] : decision === 'misses' ? split.misses[0] : gaps.length > 0 ? weakest(gaps) : undefined;
  if (selected === undefined) throw new Error('汇总没有可取的轮次');
  const terminal = selected.terminal;
  const code = terminal === PASS ? undefined : selected.code;
  const marks: QualifierMark[] = intermittent ? [INTERMITTENT_MARK] : [];
  const status = STATUS_OF[decision];
  const missing = missingRounds.length === 0
    ? undefined
    : `缺少第 ${missingRounds.join('、')} 轮的动态层判定；出口是重跑这几轮`;
  const exit = missingRounds.length === 0 ? undefined : { action: RERUN_ROUNDS, rounds: [...missingRounds] };
  return {
    outcome: decision,
    status: status.status,
    ...('unsatisfied_reason' in status ? { unsatisfied_reason: status.unsatisfied_reason } : {}),
    terminal,
    ...(code === undefined ? {} : { code }),
    marks,
    distribution,
    text: observationText(distribution, intermittent, missingRounds),
    ...(firstCause === undefined ? {} : { firstCause }),
    missingRounds,
    ...(missing === undefined ? {} : { missing }),
    ...(exit === undefined ? {} : { exit }),
  };
}

/** V07 R[5]: class defaults, then any field the requirement wrote, then a dispatch-row count. */
export function effectiveRepetition(input: RepetitionRequest = {}): EffectiveRepetition {
  if (input.workClass !== undefined && !WorkClassSchema.safeParse(input.workClass).success) {
    throw new Error(`工作类不在词表里：${String(input.workClass)}`);
  }
  const declared = input.declared ?? {};
  const explicit = {
    count: input.dispatchCount !== undefined || declared.count !== undefined,
    aggregation: declared.aggregation !== undefined,
    k: declared.k !== undefined,
  };
  const wrote = explicit.count || explicit.aggregation || explicit.k;
  if (input.layers !== undefined && !repetitionApplies(input.layers)) {
    if (wrote) throw new Error('静态检查不重复');
    return { ...SINGLE_ROUND, basis: 'single_round', explicit: { count: false, aggregation: false, k: false } };
  }
  const base = input.workClass === undefined ? SINGLE_ROUND : CLASS_DEFAULT[input.workClass];
  const policy = assertPolicy({
    count: input.dispatchCount ?? declared.count ?? base.count,
    aggregation: declared.aggregation ?? base.aggregation,
    ...(declared.k === undefined ? {} : { k: declared.k }),
  });
  const basis: RepetitionBasis = wrote ? 'explicit' : input.workClass === undefined ? 'single_round' : 'work_class';
  return { ...policy, basis, explicit };
}

/** Static checks are not repeated (V07 R[5]). */
export function repetitionApplies(layers: readonly Layer[]): boolean {
  return layers.includes(DYNAMIC);
}

/** V07 R[4]: two runs can be compared only when aggregation, k and round depth are the same. */
export function comparableRepetitions(left: RepetitionPolicy, right: RepetitionPolicy): boolean {
  const a = assertPolicy(left);
  const b = assertPolicy(right);
  return a.count === b.count && a.aggregation === b.aggregation && a.k === b.k;
}

/** V07 R[5], W03 F[0]: a round stays inside the frozen count and the effect row's count budget. */
export function withinCountBudget(round: number, policy: RepetitionPolicy, budget: number): boolean {
  const frozen = assertPolicy(policy);
  return Number.isInteger(round) && Number.isInteger(budget) && budget >= 1 && round >= 1 && round <= frozen.count && round <= budget;
}
