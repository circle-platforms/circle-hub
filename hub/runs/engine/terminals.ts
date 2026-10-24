import { labelOf } from '../../../contracts/generated/vocabulary.ts';
import type { Independence, ItemHandling, Verdict } from '../../../contracts/generated/vocabulary.ts';
// Layer terminals, requirement status and attribution (V01, V03, V04, W02 R[4]-R[5], W07 R[2]-R[3], T03 R[4]). Pure: the
// evaluation hands in the check outcomes of one (item, requirement) and what the submission said about the item; nothing
// here reads records. Per-value behaviour is in tables typed against the vocabulary, so a new value does not compile until
// it is placed.
import type {
  AcceptedProducer,
  Attribution,
  CheckTier,
  DynamicTerminal,
  ErrorHandling,
  Reason,
  SourceRole,
  StaticTerminal,
  UnsatisfiedReason,
  RequirementStatus,
} from '../../../contracts/generated/vocabulary.ts';
import type { ErrorHandlingRow, RequirementTemplate } from '../../../contracts/src/pack.ts';
import { UnknownExit, type LayerResult, type RequirementResult } from '../../../contracts/src/validation.ts';
import type { CheckOutcome } from '../../rules/api.ts';
import { valueAt } from './util.ts';

/** One outcome of one check, with the role of what that check judges (A03, checks.json `judges`). */
export interface JudgedOutcome {
  outcome: CheckOutcome;
  check: string;
  judges: SourceRole;
}

/**
 * runCheck turns a sandbox failure into an unknown outcome carrying `data.sandbox`. A display hint only: a pack function can
 * return the same data, so no terminal depends on it (the terminal follows the outcome's reason, V01 R[6]).
 */
export function isSandboxFailure(outcome: CheckOutcome): boolean {
  return outcome.verdict === 'unknown' && typeof outcome.data?.sandbox === 'string';
}

/**
 * V01 R[2], R[6] and P11 R[3]: the static terminal an unknown outcome gives, by its reason. A check error, a timeout, missing
 * input or an unproven closed world is unknown (unchecked); a used-up budget, wherever it was used up, leaves the requirement
 * incomplete. The reasons of submissions and runs never come from a check; they are placed so that a new reason does not
 * compile until it is.
 */
const UNKNOWN_TERMINAL = {
  no_check: 'unchecked',
  check_error: 'unchecked',
  timeout: 'unchecked',
  missing_input: 'unchecked',
  integrity_unproven: 'unchecked',
  budget_exhausted: 'unchecked',
  declared_skip: 'incomplete',
  not_covered: 'incomplete',
  awaiting_step: 'incomplete',
  output_failed: 'incomplete',
  repair_exhausted: 'incomplete',
} as const satisfies Record<Reason, Extract<StaticTerminal, 'unchecked' | 'incomplete'>>;

/**
 * Reasons that make a requirement incomplete at every layer it declares: a skipped item (W07 R[2]), an item the submission
 * did not cover (W07 R[3]), used-up repair rounds (W02 R[5]) and a used-up budget (P11 R[3]).
 */
const EVERY_LAYER = { declared_skip: true, not_covered: true, repair_exhausted: true, budget_exhausted: true } as const satisfies Partial<Record<Reason, true>>;

function everyLayer(reason: Reason | undefined): reason is keyof typeof EVERY_LAYER {
  return reason !== undefined && Object.hasOwn(EVERY_LAYER, reason);
}

/** What a submission said about an item, for requirements that accept judgments. */
export type Handling = ItemHandling | Extract<Reason, 'not_covered'>;

/** What the check contract expects for one (item, requirement): support, or a refutation with one of some codes. */
export interface Expectation {
  outcome: Extract<Verdict, 'support' | 'refute'>;
  codes: string[];
}

/** RequirementTemplate.expected: a negative case whose item field matches an override expects that refutation. */
export function expectationFor(template: RequirementTemplate, fields: Record<string, unknown>): Expectation {
  for (const override of template.expected?.overrides ?? []) {
    if (valueAt(fields, override.when.pointer) === override.when.equals) return { outcome: 'refute', codes: [...override.codes] };
  }
  return { outcome: 'support', codes: [] };
}

export interface StaticInput {
  producer: AcceptedProducer;
  /** A judgment requirement without a slot to fill has no producer (W02 R[4]). Fact requirements always have the Hub. */
  hasProducer: boolean;
  /** Checks the requirement declares. */
  checks: number;
  /** Every outcome of those checks for this item (or for the run). */
  outcomes: JudgedOutcome[];
  /** For requirements that accept judgments; null for facts. */
  handling: Handling | null;
  expectation: Expectation;
}

/** The static terminal before the error handling table is applied. */
export interface RawStatic {
  terminal: StaticTerminal;
  code?: string;
  tier?: CheckTier;
  reason?: Reason;
  /** The refutation the terminal shows when it is a violation. */
  primary?: JudgedOutcome;
  /** Refutations that do not meet the expectation (all of them when support is expected). */
  unexpected: JudgedOutcome[];
  /** Every refutation is one the expectation names. */
  expectedRefutation: boolean;
}

const firstReason = (outcomes: readonly JudgedOutcome[]): Reason => outcomes.find((o) => o.outcome.reason !== undefined)?.outcome.reason ?? 'check_error';

/** V01 R[6], V03 R[1], W07 R[2]-R[3]: the static terminal of one (item, requirement) from its check outcomes. */
export function staticTerminal(input: StaticInput): RawStatic {
  const none = { unexpected: [], expectedRefutation: false };
  // W07 R[2]-R[3]: skip and not covered are declarations about the item. They cover every requirement, including one
  // with no producer, before any check.
  if (input.handling === 'skipped') return { terminal: 'incomplete', reason: 'declared_skip', ...none };
  if (input.handling === 'not_covered') return { terminal: 'incomplete', reason: 'not_covered', ...none };
  if (!input.hasProducer) return { terminal: 'unchecked', reason: 'no_check', ...none };
  const judgment = input.producer !== 'fact';
  if (!judgment && (input.checks === 0 || input.outcomes.length === 0)) {
    return { terminal: 'unchecked', reason: input.checks === 0 ? 'no_check' : 'check_error', ...none };
  }
  const refutes = input.outcomes.filter((o) => o.outcome.verdict === 'refute');
  if (refutes.length > 0) {
    const expected = (o: JudgedOutcome): boolean => input.expectation.outcome === 'refute' && o.outcome.code !== undefined && input.expectation.codes.includes(o.outcome.code);
    const unexpected = refutes.filter((o) => !expected(o));
    const pool = unexpected.length > 0 ? unexpected : refutes;
    const primary = pool.find((o) => o.outcome.tier === 'blocking') ?? pool[0];
    return { terminal: 'violation', code: primary.outcome.code ?? 'check_error', tier: primary.outcome.tier, primary, unexpected, expectedRefutation: unexpected.length === 0 };
  }
  // Unknown outcomes by their reason only (V01 R[6]): an incomplete one (a used-up budget) before the unchecked ones.
  const unknowns = input.outcomes.filter((o) => o.outcome.verdict === 'unknown');
  const incomplete = unknowns.find((o) => UNKNOWN_TERMINAL[o.outcome.reason ?? 'check_error'] === 'incomplete');
  if (incomplete !== undefined) return { terminal: 'incomplete', reason: incomplete.outcome.reason ?? 'check_error', ...none };
  if (unknowns.length > 0) return { terminal: 'unchecked', reason: firstReason(unknowns), ...none };
  return { terminal: judgment ? 'judgment' : 'pass', ...none };
}

/** Selector priority: exact code, then generated cause, then wildcard (W02 F[7]). */
export function routeOf(rows: readonly ErrorHandlingRow[], code?: string, reason?: Reason, outcome?: JudgedOutcome): ErrorHandlingRow | undefined {
  if(outcome)rows=rows.filter(row=>rowApplies(row,outcome));
  const exact=code===undefined||code==='*'?undefined:rows.find(row=>row.code===code);
  const cause=reason===undefined?undefined:rows.find(row=>row.reason===reason);
  return exact??cause??rows.find(row=>row.code==='*');
}

/** Repair rounds of a requirement: the largest max_rounds of its repair rows, 0 without one (RequirementSummary.repair_rounds). */
export function repairRounds(template: RequirementTemplate): number {
  return template.error_handling.reduce((max, row) => (row.action === 'repair' ? Math.max(max, row.max_rounds ?? 0) : max), 0);
}

/** A refutation routed through the error handling table, for the errors of the result. */
export interface Routed {
  outcome: JudgedOutcome;
  action: ErrorHandling;
  /** Rounds left after this submission (repair rows only). */
  roundsLeft?: number;
}

export interface RoutedStatic {
  terminal: StaticTerminal;
  code?: string;
  tier?: CheckTier;
  reason?: Reason;
  primary?: JudgedOutcome;
  routed: Routed[];
  /** The action applied to the terminal, from the row of the leading routed refutation. */
  action: ErrorHandling | null;
  /** The routed refutation whose row decided the action (the primary one when its row applies). */
  lead?: JudgedOutcome;
  expectedRefutation: boolean;
}

/**
 * Whether an error handling row applies to a refutation, by the role of what the refuting check judges (A03): repair only to
 * the statements of the artifact under verification (T03 R[4]: only a statement that disagrees with what it cites goes back
 * to its producer; nobody can repair the target through a submission), reject only to a blocking check on it (W02 F[7]);
 * request and unknown to any. A row that does not apply leaves the violation as it is, delivered content (V05 R[1]).
 */
export function rowApplies(row: ErrorHandlingRow, o: JudgedOutcome): boolean {
  if (row.action === 'repair') return o.judges === 'artifact_under_verification';
  if (row.action === 'reject') return row.code!==undefined&&o.outcome.verdict==='refute'&&o.outcome.code!==undefined&&o.judges === 'artifact_under_verification' && o.outcome.tier === 'blocking';
  return true;
}

/**
 * T03 R[4], W02 F[7], W02 R[5]: unexpected refutations are routed by the error table where the row applies (rowApplies).
 * The primary refutation leads when it is routed, else the first routed one: repair keeps the violation until the rounds are
 * used up (then incomplete, repair_exhausted, the statement kept), request waits (incomplete, awaiting_step), unknown records
 * unknown (keeps the violation, unattributed), reject keeps the violation and lets the partition decide. A refutation the
 * expectation names is the expected outcome and is never routed.
 */
export function applyRouting(raw: RawStatic, template: RequirementTemplate, roundsUsed: number, outcomes: readonly JudgedOutcome[] = []): RoutedStatic {
  const rounds = repairRounds(template);
  const roundsLeft = Math.max(0, rounds - roundsUsed);
  const exhausted = roundsUsed >= rounds;
  const routed: Routed[] = [];
  for (const o of [...raw.unexpected, ...outcomes.filter(o => o.outcome.verdict === 'unknown')]) {
    const row = routeOf(template.error_handling, o.outcome.code, o.outcome.reason, o);
    if (row === undefined || !rowApplies(row, o)) continue;
    routed.push(row.action === 'repair' ? { outcome: o, action: 'repair', roundsLeft } : { outcome: o, action: row.action });
  }
  const base: RoutedStatic = {
    terminal: raw.terminal,
    code: raw.code,
    tier: raw.tier,
    reason: raw.reason,
    primary: raw.primary,
    routed,
    action: null,
    expectedRefutation: raw.expectedRefutation,
  };
  if (raw.terminal !== 'violation' || raw.primary === undefined || raw.expectedRefutation) {
    const unknown = routed.find(r => r.outcome.outcome.verdict === 'unknown');
    if (unknown?.action === 'repair' && exhausted) return {...base, terminal:'incomplete', reason:'repair_exhausted',action:'repair',lead:unknown.outcome};
    return base;
  }
  const lead = routed.find((r) => r.outcome === raw.primary) ?? routed[0];
  if (lead === undefined) return base;
  base.action = lead.action;
  base.lead = lead.outcome;
  // A terminal the lead changes shows the lead's refutation.
  const shown = { code: lead.outcome.outcome.code ?? raw.code, tier: lead.outcome.outcome.tier, primary: lead.outcome };
  if (lead.action === 'repair' && exhausted) return { ...base, ...shown, terminal: 'incomplete', reason: 'repair_exhausted' };
  if (lead.action === 'request') return { ...base, ...shown, terminal: 'incomplete', reason: 'awaiting_step' };
  return base;
}

// ---------------------------------------------------------------- attribution (V04)

/** V04: attributions given by rule for an unknown or incomplete terminal, by its reason. */
const BY_REASON = {
  no_check: 'unattributed',
  check_error: 'producer_error',
  timeout: 'transient',
  missing_input: 'data_gap',
  declared_skip: 'unattributed',
  not_covered: 'producer_error',
  awaiting_step: 'transient',
  output_failed: 'producer_error',
  repair_exhausted: 'producer_error',
  budget_exhausted: 'transient',
  integrity_unproven: 'data_gap',
} as const satisfies Record<Reason, Attribution>;

export {bindRecovery,EXIT_BY_REASON,type NamedRecoveryContext as RecoveryContext} from './recovery.ts';

/** V04: attribution of a violation by the role of what the refuting check judges (A03). */
const BY_ROLE = {
  expected: 'data_gap',
  subject: 'author_input',
  artifact_under_verification: 'producer_error',
  reported_actual: 'unattributed',
  republished: 'unattributed',
  hint: 'data_gap',
  request_text: 'author_input',
} as const satisfies Record<SourceRole, Attribution>;

export function attributionByReason(reason: Reason): Attribution {
  return BY_REASON[reason];
}

export function attributionByRole(role: SourceRole): Attribution {
  return BY_ROLE[role];
}

// ---------------------------------------------------------------- layers

/** Terminals that leave a requirement undecided (V03 F[2]: pending). */
const STATIC_UNSETTLED = { pass: false, violation: false, judgment: false, unchecked: true, incomplete: true } as const satisfies Record<StaticTerminal, boolean>;
const DYNAMIC_UNSETTLED = { pass: false, fail: false, no_verdict: true, not_run: true, incomplete: true } as const satisfies Record<DynamicTerminal, boolean>;

export function isUnsettled(layer: LayerResult): boolean {
  return layer.layer === 'static' ? STATIC_UNSETTLED[layer.terminal] : DYNAMIC_UNSETTLED[layer.terminal];
}

/** Whether a settled terminal meets the expectation; a violation meets a refute expectation only when every refutation is expected. */
export function meets(layer: LayerResult, expectation: Expectation, expectedRefutation: boolean, producer?: AcceptedProducer): boolean {
  if (layer.layer === 'static') {
    if (layer.terminal === 'pass') return expectation.outcome === 'support';
    if (layer.terminal === 'judgment') return producer !== 'fact' && expectation.outcome === 'support';
    if (layer.terminal === 'violation') return expectation.outcome === 'refute' && expectedRefutation;
    return false;
  }
  if (layer.terminal === 'pass') return expectation.outcome === 'support';
  if (layer.terminal === 'fail') return expectation.outcome === 'refute' && layer.code !== undefined && expectation.codes.includes(layer.code);
  return false;
}

/** The static layer result: the terminal with its code, tier, reason and, when it misses the expectation, its attribution. */
export function staticLayer(routed: RoutedStatic, expectation: Expectation): LayerResult {
  const layer: LayerResult = { layer: 'static', terminal: routed.terminal };
  if (routed.code !== undefined && routed.terminal !== 'pass') layer.code = routed.code;
  if (routed.tier !== undefined && routed.terminal !== 'pass' && routed.code !== undefined) layer.tier = routed.tier;
  if (routed.reason !== undefined && routed.terminal !== 'pass' && routed.terminal !== 'violation') layer.reason = routed.reason;
  if (routed.terminal === 'pass' || routed.terminal === 'judgment') return layer;
  if (routed.terminal === 'violation') {
    if (meets(layer, expectation, routed.expectedRefutation)) return layer;
    if (routed.action === 'unknown') {
      layer.attribution = 'unattributed';
      return layer;
    }
    layer.attribution = attributionByRole(routed.primary?.judges ?? 'subject');
    return layer;
  }
  layer.attribution = attributionByReason(routed.reason ?? 'check_error');
  return layer;
}

/**
 * The dynamic layer of a requirement that declares it. Milestone 1 has no dynamic checks: not run (no check installed, V03
 * R[1]), unless the requirement is incomplete at every layer it declares (a skipped or uncovered item, used-up repair rounds or
 * budget: EVERY_LAYER), shown by its static terminal; then incomplete with the same reason.
 */
export function dynamicLayer(statics?: Pick<RoutedStatic, 'terminal' | 'reason'>): LayerResult {
  if (statics?.reason === 'output_failed') return {layer:'dynamic',terminal:'not_run',reason:'output_failed',attribution:attributionByReason('output_failed')};
  if (statics !== undefined && statics.terminal === 'incomplete' && everyLayer(statics.reason)) {
    return { layer: 'dynamic', terminal: 'incomplete', reason: statics.reason, attribution: attributionByReason(statics.reason) };
  }
  return { layer: 'dynamic', terminal: 'not_run', reason: 'no_check', attribution: attributionByReason('no_check') };
}

// ---------------------------------------------------------------- status

/** Independence of a judgment from the predecessor run (A04), as far as the Hub can tell. */
export type IndependenceFinding = 'independent' | Extract<Independence, 'not_independent' | 'unknown'>;

export interface StatusInput {
  producer?: AcceptedProducer;
  layers: LayerResult[];
  hasProducer: boolean;
  expectation: Expectation;
  expectedRefutation: boolean;
  /** For requirements independent of the predecessor; null otherwise. */
  independence: IndependenceFinding | null;
  /** The template accepts the independence the client declares (A04 R[4]). */
  acceptsDeclared: boolean;
  accountVerified?:boolean;
}

/**
 * V03 F[2], R[2]: pending while any declared layer is unsettled; unsatisfied (outcome_mismatch) when a settled terminal
 * misses the expected outcome; an independent judgment is satisfied only when its independence is established and the
 * template accepts the declared independence it rests on (A04 R[4], R[5]); a requirement without a producer is unsatisfied
 * (no_producer, W02 R[4]).
 */
export function requirementStatus(input: StatusInput): { status: RequirementStatus; unsatisfied_reason?: UnsatisfiedReason } {
  if (!input.hasProducer) return { status: 'unsatisfied', unsatisfied_reason: 'no_producer' };
  if (input.layers.some(layer=>!isUnsettled(layer)&&!meets(layer,input.expectation,input.expectedRefutation,input.producer))) return {status:'unsatisfied',unsatisfied_reason:'outcome_mismatch'};
  if (input.layers.some(isUnsettled)) return { status: 'pending' };
  if (!input.layers.every((l) => meets(l, input.expectation, input.expectedRefutation,input.producer))) return { status: 'unsatisfied', unsatisfied_reason: 'outcome_mismatch' };
  if (input.independence !== null && !(input.independence === 'independent' && (input.accountVerified||input.acceptsDeclared))) {
    return { status: 'unsatisfied', unsatisfied_reason: 'independence_unknown' };
  }
  return { status: 'satisfied' };
}

// ---------------------------------------------------------------- item cell (V03 R[3])

/** Strength of each terminal in the item cell, strongest first in the projection order. */
const STATIC_STRENGTH = { violation: 5, incomplete: 4, unchecked: 3, judgment: 2, pass: 1 } as const satisfies Record<StaticTerminal, number>;
const DYNAMIC_STRENGTH = { fail: 4, incomplete: 3, no_verdict: 2, not_run: 2, pass: 1 } as const satisfies Record<DynamicTerminal, number>;

export interface CellLayer<T extends string> {
  /** The strongest terminal of the layer over the item's requirements. */
  terminal: T;
  /** How many requirements show each non-pass terminal, so an unknown is never hidden behind a pass or a violation. */
  counts: Partial<Record<T, number>>;
}

export interface ItemCell {
  static?: CellLayer<StaticTerminal>;
  dynamic?: CellLayer<DynamicTerminal>;
}

/** The item's two cells: the conjunction over its requirements per layer; a layer no requirement declares has no cell. */
export function itemCell(requirements: readonly RequirementResult[]): ItemCell {
  const cell: ItemCell = {};
  for (const r of requirements) {
    for (const layer of r.layers) {
      if (layer.layer === 'static') {
        const current = cell.static;
        if (current === undefined || STATIC_STRENGTH[layer.terminal] > STATIC_STRENGTH[current.terminal]) cell.static = { terminal: layer.terminal, counts: current?.counts ?? {} };
        if (layer.terminal !== 'pass') cell.static!.counts[layer.terminal] = (cell.static!.counts[layer.terminal] ?? 0) + 1;
      } else {
        const current = cell.dynamic;
        if (current === undefined || DYNAMIC_STRENGTH[layer.terminal] > DYNAMIC_STRENGTH[current.terminal]) cell.dynamic = { terminal: layer.terminal, counts: current?.counts ?? {} };
        if (layer.terminal !== 'pass') cell.dynamic!.counts[layer.terminal] = (cell.dynamic!.counts[layer.terminal] ?? 0) + 1;
      }
    }
  }
  return cell;
}

/** Explicit premise paths only: a dependency is never inferred from prose or a shared word. */
export function waitForRepairs(results: RequirementResult[], repairs: Array<{requirement:string;pointer:string;exit:UnknownExit}>): void {
  const boundary=(premise:string,pointer:string)=>premise===pointer||premise.startsWith(pointer+'/');
  for(const result of results){
    const waits=repairs.filter(repair=>repair.requirement!==result.requirement&&result.claims.some(claim=>claim.validity.premises.some(p=>p.startsWith('/')&&boundary(p,repair.pointer))));
    if(!waits.length)continue;
    let changed=false;
    result.layers=result.layers.map(layer=>{
      if(!isUnsettled(layer))return layer;
      changed=true;
      const waiting=waits.map(repair=>`等待要求项 ${repair.requirement} 的修复（${repair.pointer}）`).join('；');
      const unknown=layer.layer==='static'?layer.terminal==='unchecked':layer.terminal==='no_verdict'||layer.terminal==='not_run';
      const gaps=[...(layer.gaps??[]),...(unknown&&layer.reason&&layer.missing&&layer.exit?[{reason:layer.reason,missing:layer.missing,exit:layer.exit}]:[])];
      const original=layer.reason?`原原因 ${labelOf('reason',layer.reason)}：${layer.missing??''}；`:layer.code?`原判定 ${layer.code}；`:'';
      return {...layer,terminal:'incomplete' as const,reason:'awaiting_step' as const,missing:original+waiting,exit:waits[0].exit,attribution:'transient' as const,...(gaps.length?{gaps}:{})};
    });
    if(changed&&result.status!=='unsatisfied'){result.status='pending';delete result.unsatisfied_reason;}
  }
}
