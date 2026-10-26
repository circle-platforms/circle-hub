// Independent reference implementation of the Hub's verdict rules, derived from the model elements V01 V03 V04 V05 V06
// W02 W07 W08 T03 and from the shapes in contracts/src, never from hub/runs/engine or hub/rules. `expected` is pure: small
// plain descriptions in, the terminals, requirement status, attribution, cell projection, partition, counts and errors of
// one submission out. Where the model leaves a detail open the rule is marked CHOICE-<n>; README.md lists every choice
// and everything the scenarios do not cover.
import type { ProtocolCode } from '../../../contracts/generated/protocol.ts';
import {
  LAYER,
  PARTITION,
  UNSATISFIED_REASON,
  type Acceptance,
  type AcceptedProducer,
  type Attribution,
  type CheckTier,
  type DynamicTerminal,
  type ErrorHandling,
  type Layer,
  type Partition,
  type Reason,
  type RequirementStatus,
  type SourceRole,
  type StaticTerminal,
  type UnsatisfiedReason,
  type Verdict,
} from '../../../contracts/generated/vocabulary.ts';

// ---------------------------------------------------------------- descriptions (input)

/** The reasons an unknown check verdict carries (V01 R[2]: check error, timeout, missing input). */
export const CHECK_UNKNOWN_REASONS = ['check_error', 'timeout', 'missing_input'] as const satisfies readonly Reason[];
export type CheckUnknownReason = (typeof CHECK_UNKNOWN_REASONS)[number];

/** One outcome a check returned about one item (V01): support, refute with a code at a tier, or unknown with a reason. */
export type Outcome =
  | { verdict: Extract<Verdict, 'support'> }
  | { verdict: Extract<Verdict, 'refute'>; code: string; tier: CheckTier }
  | { verdict: Extract<Verdict, 'unknown'>; reason: CheckUnknownReason };

export interface CheckDescription {
  id: string;
  /** What the check judges (A03): only refutations of the artifact under verification may send an item to rejected (W02 F[7]). */
  judges: Extract<SourceRole, 'subject' | 'artifact_under_verification'>;
  /** A declared tier replaces the tier of every outcome of the check (checks.json `tier`). */
  tier: CheckTier | null;
}

export interface ErrorRow {
  /** A violation code, or * for any other code. */
  code: string;
  action: ErrorHandling;
  /** Repair rounds of the whole requirement; given exactly on a repair row. */
  maxRounds?: number;
}

/** An item-level requirement as frozen at start_run (W02). */
export interface RequirementDescription {
  key: string;
  /** A required requirement that ends incomplete at a declared layer puts the item into incomplete (V05 R[3] step 4). */
  required: boolean;
  /** The declared layers, a non-empty subset of the layer axis (V03 R[0]). */
  layers: Layer[];
  producer: AcceptedProducer;
  /** Only meaningful for an independent judgment: whether the client-declared independence is accepted (A04 R[4]). */
  acceptsDeclaredIndependence: boolean;
  /** Ids of the installed checks, in order; none means no check is installed (V01 R[1]). */
  checks: string[];
  /** The refutation codes a negative item is expected to produce (an expected-outcome override); null when there is none. */
  negativeCodes: string[] | null;
  errorTable: ErrorRow[];
}

/** Who produced a submission: the session the Hub observed and the model the client declared. */
export interface Party {
  session: string | null;
  model: string;
}

export interface RunDescription {
  /** The items of the run in projection order; `negative` is the item field the expected-outcome override tests. */
  items: { id: string; negative: boolean }[];
  requirements: RequirementDescription[];
  /** Keys of run-level requirements (cross-item claims): they never appear in an item result (V05 R[4]). */
  runLevel: string[];
  checks: CheckDescription[];
  /** Submissions made to this run before the one validated now (CHOICE-10: each one is a repair round). */
  roundsUsed: number;
  chargedRounds?:Record<string,number>;
  /** The author an independent judgment must be independent of: the predecessor run's accepted submission; null when unknown. */
  author: Party | null;
}

/** The handling an item entry of the submission declares (W07 F[2]); an item without an entry is missing (W07 R[3]). */
export type HandlingDescription = { handling: 'handled' } | { handling: 'skipped' };

export interface SubmissionDescription {
  judge: Party;
  items: Record<string, HandlingDescription>;
  /** Defects that make the whole submission not accepted (T03 R[3]), by the protocol code each must produce. */
  defects: ProtocolCode[];
}

/** check id -> item id -> the outcomes that check returned about that item, in order. */
export type CheckOutcomes = Record<string, Record<string, Outcome[]>>;

// ---------------------------------------------------------------- expectations (output)

export interface ExpectedLayer {
  layer: Layer;
  terminal: StaticTerminal | DynamicTerminal;
  code?: string;
  tier?: CheckTier;
  reason?: Reason;
  attribution?: Attribution;
}

export interface ExpectedRequirement {
  requirement: string;
  layers: ExpectedLayer[];
  status: RequirementStatus;
  unsatisfied_reason?: UnsatisfiedReason;
}

/** One cell of an item (V03 R[3]): the conjunctive projection and the count of every non-pass terminal at that layer. */
export interface Cell {
  value: StaticTerminal | DynamicTerminal;
  counts: Record<string, number>;
}

export interface ExpectedItem {
  item: string;
  partition: Partition;
  /** The code that put the item into rejected (V05 F[1]). */
  code?: string;
  /** Why the item is incomplete (V05 F[3]). */
  reason?: Reason;
  requirements: ExpectedRequirement[];
  /** Null for a layer no requirement of the run declares: "not applicable". */
  cells: Record<Layer, Cell | null>;
}

/** The parts of an `errors` entry the rules fix. `kind` says which rule produced it. */
export interface ExpectedError {
  kind: 'protocol' | 'refutation' | 'not_covered' | 'unknown';
  code?: string;
  item?: string;
  requirement?: string;
  rounds_left?: number;
}

export interface Expected {
  acceptance: Acceptance;
  rounds: { used: number; max: number };
  /** Every item in projection order with its partition and terminals; empty when the submission is not accepted (V05 R[5]). */
  items: ExpectedItem[];
  counts: Record<Partition, number> & { unknown: number };
  errors: ExpectedError[];
}

// ---------------------------------------------------------------- vocabulary-derived tables

/** V03 R[3]: static cell order, worst first: violation, incomplete, unchecked, judgment, pass. */
const STATIC_RANK = { violation: 0, incomplete: 1, unchecked: 2, judgment: 3, pass: 4 } as const satisfies Record<StaticTerminal, number>;
/** V03 R[3]: dynamic cell order, worst first: fail, incomplete, no verdict or not run, pass. */
const DYNAMIC_RANK = { fail: 0, incomplete: 1, no_verdict: 2, not_run: 2, pass: 3 } as const satisfies Record<DynamicTerminal, number>;
/** V03 R[4]: unchecked, no verdict and not run are unknown; incomplete is its own state. */
const STATIC_UNKNOWN = { pass: false, violation: false, judgment: false, unchecked: true, incomplete: false } as const satisfies Record<StaticTerminal, boolean>;
const DYNAMIC_UNKNOWN = { pass: false, fail: false, no_verdict: true, not_run: true, incomplete: false } as const satisfies Record<DynamicTerminal, boolean>;

export function isUnknown(layer: Layer, terminal: string): boolean {
  const table: Record<string, boolean> = layer === 'static' ? STATIC_UNKNOWN : DYNAMIC_UNKNOWN;
  if (!Object.hasOwn(table, terminal)) throw new Error(`${terminal} is not a ${layer} terminal`);
  return table[terminal];
}

// ---------------------------------------------------------------- helpers

/** The row of the error table that handles a code: the exact row, else the * row (requirements.json), else none. */
export function rowFor(r: RequirementDescription, code: string): ErrorRow | null {
  return r.errorTable.find((e) => e.code === code) ?? r.errorTable.find((e) => e.code === '*') ?? null;
}

/** Repair rounds named by one row (W02 F[7]: the code maps to repair of at most n rounds). 0 when the row is not a repair. */
export function rowRounds(row: ErrorRow | null): number {
  return row?.action === 'repair' ? (row.maxRounds ?? 0) : 0;
}

/** The run's repair budget (W02 R[5]): the largest repair row of its requirements, 0 when none repairs. */
export function repairRounds(r: RequirementDescription): number {
  return Math.max(0, ...r.errorTable.map((e) => rowRounds(e)));
}

/** CHOICE-14: the run's maximum is the largest repair budget of its requirements. */
export function runMaxRounds(run: RunDescription): number {
  return Math.max(0, ...run.requirements.map(repairRounds));
}

/**
 * V04: who answers for a non-pass terminal that misses the expectation. T03 R[4] reserves producer_error for a statement
 * that disagrees with the source it cites, which these scenarios do not carry, so a repair row does not itself name the
 * producer. A check of the subject is the author's input (V04 F[1]); a check of the artifact under verification is the
 * producer's (V04 F[2]). A request is waiting (V04 F[3]). The unknown action names no one (V04 F[5]).
 */
function attributionOf(row: ErrorRow | null, judges: CheckDescription['judges']): Attribution {
  // T03 R[4] reserves producer_error for a statement that disagrees with the source it cites. These scenarios do not
  // carry that fact, so a repair row does not by itself change who answers. The subject is the author's input (V04 F[1]);
  // the artifact under verification is the producer's (V04 F[2]). A request is waiting, which is transient (V04 F[3]).
  if (row?.action === 'request') return 'transient';
  if (row?.action === 'unknown') return 'unattributed';
  if (judges === 'subject') return 'author_input';
  if (judges === 'artifact_under_verification') return 'producer_error';
  return 'unattributed';
}

/** CHOICE-8/9: attribution of an unknown or incomplete terminal by its reason (V04 F[0] data gap, F[2] producer error, F[3] transient). */
function attributionOfReason(reason: Reason): Attribution {
  switch (reason) {
    case 'timeout':
    case 'awaiting_step':
      return 'transient';
    case 'missing_input':
      return 'data_gap';
    case 'check_error':
      // The check is what should have produced the verdict, and it failed (V04 F[2]).
      return 'producer_error';
    case 'repair_exhausted':
      return 'producer_error';
    case 'declared_skip':
    case 'not_covered':
      // W07 names the reason and no rule names who answers for it (V04 F[5]).
      return 'unattributed';
    default:
      return 'unattributed';
  }
}

/**
 * Whether an independent-judgment requirement may count this judge (W02 F[4], V03 F[2]; the requirement template says it
 * is satisfied only by another session and another model than the predecessor, and only when declared independence is
 * accepted). Anything else leaves independence unknown.
 */
export function independent(r: RequirementDescription, author: Party | null, judge: Party): boolean {
  if (author === null) return false;
  if (author.session === null || judge.session === null || author.session === judge.session) return false;
  if (author.model === judge.model) return false;
  return r.acceptsDeclaredIndependence;
}

function firstReason(reasons: UnsatisfiedReason[]): UnsatisfiedReason | undefined {
  // CHOICE-11: V03 F[2] lists the reasons in one order and the result holds one of them. The earliest listed is named.
  return UNSATISFIED_REASON.find((u) => reasons.includes(u));
}

export function cellOf(layer: Layer, terminals: string[]): Cell | null {
  if (terminals.length === 0) return null;
  const rank: Record<string, number> = layer === 'static' ? STATIC_RANK : DYNAMIC_RANK;
  let value = terminals[0];
  const counts: Record<string, number> = {};
  for (const t of terminals) {
    if (!Object.hasOwn(rank, t)) throw new Error(`${t} is not a ${layer} terminal`);
    if (rank[t] < rank[value]) value = t;
    if (t !== 'pass') counts[t] = (counts[t] ?? 0) + 1;
  }
  return { value: value as StaticTerminal | DynamicTerminal, counts };
}

// ---------------------------------------------------------------- one (item, requirement)

interface Evaluation {
  result: ExpectedRequirement;
  /** A repair-routed refutation listed in errors (W08 R[1], W02 R[5]). */
  repair: ExpectedError | null;
  /** The code that rejects the item (V05 R[3] step 5). */
  reject: string | null;
}

function allLayers(r: RequirementDescription, layer: Omit<ExpectedLayer, 'layer'>): ExpectedLayer[] {
  return LAYER.filter((l) => r.layers.includes(l)).map((l) => ({ layer: l, ...layer }));
}

function incomplete(r: RequirementDescription, reason: Reason, extra: Partial<ExpectedLayer> = {}): ExpectedRequirement {
  // W07 R[2]-R[3], W02 R[5]: every declared layer is incomplete; an incomplete requirement is neither met nor missed (pending).
  return { requirement: r.key, layers: allLayers(r, { terminal: 'incomplete', reason, attribution: attributionOfReason(reason), ...extra }), status: 'pending' };
}

function usedFor(run:RunDescription,r:RequirementDescription):number{
  return run.chargedRounds?.[r.key]??(r.checks.some(id=>run.checks.some(c=>c.id===id&&c.judges==='artifact_under_verification'))?run.roundsUsed:0);
}

function evaluate(run: RunDescription, submission: SubmissionDescription, r: RequirementDescription, item: RunDescription['items'][number], outcomes: CheckOutcomes): Evaluation {
  const handling = submission.items[item.id];
  const needsArtifact = r.producer !== 'fact' || r.checks.some(id => run.checks.some(c => c.id === id && c.judges === 'artifact_under_verification'));
  if (needsArtifact && handling === undefined) return { result: incomplete(r, usedFor(run,r)>=repairRounds(r)?'repair_exhausted':'not_covered'), repair: null, reject: null };
  if (needsArtifact && handling?.handling === 'skipped') return { result: incomplete(r, usedFor(run,r)>=repairRounds(r)?'repair_exhausted':'declared_skip'), repair: null, reject: null };

  const checks = new Map(run.checks.map((c) => [c.id, c]));
  const listed: { outcome: Outcome; check: CheckDescription }[] = [];
  for (const id of r.checks) {
    const check = checks.get(id);
    if (check === undefined) throw new Error(`requirement ${r.key} names the unknown check ${id}`);
    const got = outcomes[id]?.[item.id] ?? [];
    // This generator supplies explicit outcomes; dedicated engine tests pin silence to check_error under V03 R[11].
    if (got.length === 0) throw new Error(`check ${id} returned no outcome for item ${item.id}`);
    for (const o of got) listed.push({ outcome: o.verdict === 'refute' && check.tier !== null ? { ...o, tier: check.tier } : o, check });
  }
  const expectedCodes = item.negative && r.negativeCodes !== null ? new Set(r.negativeCodes) : null;
  const refutes = listed.filter((x): x is { outcome: Extract<Outcome, { verdict: 'refute' }>; check: CheckDescription } => x.outcome.verdict === 'refute');
  const unknowns = listed.filter((x): x is { outcome: Extract<Outcome, { verdict: 'unknown' }>; check: CheckDescription } => x.outcome.verdict === 'unknown');
  // An expected refutation meets the override; any other refutation misses it (V03 R[2]). The raw terminal is kept either way.
  const unexpected = refutes.filter((x) => expectedCodes === null || !expectedCodes.has(x.outcome.code));
  const judging = r.producer !== 'fact';
  // V01 R[6] lands a check on the static terminals (反驳 → 不通过). A dynamic pass or fail would be a fact only after the
  // integrity rule (V03 R[5]), which these scenarios do not carry, so a declared dynamic layer stays not run.
  const staticDeclared = r.layers.includes('static');

  let staticLayer: ExpectedLayer | null = null;
  let met: boolean | null = null; // whether the static terminal meets the expected outcome; null when that is not decided
  let noProducer = false;
  let repair: ExpectedError | null = null;
  let reject: string | null = null;

  if (staticDeclared && r.checks.length === 0) {
    // V01 R[1], V03 R[1]: a declared static layer with no check is unchecked. That is unknown, so the requirement is
    // pending (V03 R[4], F[2]) unless the producer itself is missing. An independent judgment with nothing installed
    // has no producer (W02 R[4]); a judgment terminal is only what a check or the model actually returned.
    staticLayer = { layer: 'static', terminal: 'unchecked', reason: 'no_check', attribution: attributionOfReason('no_check') };
    met = null;
    noProducer = r.producer === 'independent_judgment';
  } else if (staticDeclared && refutes.length > 0) {
    // CHOICE-1: one static terminal per layer. A refutation outranks an unknown and a support, the same worst-first order
    // the cell uses (V03 R[3]): 不通过 before 未核对 before 通过.
    if (unexpected.length === 0) {
      const first = refutes[0].outcome;
      staticLayer = { layer: 'static', terminal: 'violation', code: first.code, tier: first.tier };
      met = true;
    } else {
      // CHOICE-2: the first refutation that misses the expectation, in check order then outcome order, is the one named
      // and routed (T03 R[4]: that code's error-table row gives the attribution and the destination).
      const u = unexpected[0];
      const row = rowFor(r, u.outcome.code);
      // T03 R[4], W02 F[7]: repair rows apply only to checks that judge the artifact under verification.
      // Refutations of the subject remain violations attributed to author_input and consume no repair rounds.
      const isRepair = row?.action === 'repair' && u.check.judges === 'artifact_under_verification';
      const budget = isRepair ? rowRounds(row) : 0;
      if (isRepair && usedFor(run,r) >= budget) {
        // W02 R[5]: the rounds of this code are used up. Every declared layer is incomplete; errors still name it.
        return {
          result: incomplete(r, 'repair_exhausted'),
          repair: { kind: 'refutation', code: u.outcome.code, item: item.id, requirement: r.key, rounds_left: 0 },
          reject: null,
        };
      }
      // CHOICE-7 and V01 R[6]: the terminal stays a violation. "记未知" and "发请求" name the handling, not a second mapping.
      if (row?.action === 'request') {
        // W02 F[7] sends a request. V05 R[3] step 4: the requirement is waiting, so it is incomplete (在等某一步).
        const result = incomplete(r, 'awaiting_step');
        for (const layer of result.layers) {
          layer.code = u.outcome.code;
          layer.tier = u.outcome.tier;
          layer.attribution = 'transient';
        }
        return { result, repair: { kind: 'refutation', code: u.outcome.code, item: item.id, requirement: r.key }, reject: null };
      }
      staticLayer = { layer: 'static', terminal: 'violation', code: u.outcome.code, tier: u.outcome.tier, attribution: attributionOf(row, u.check.judges) };
      met = false;
      if(row?.action==='unknown')repair={kind:'refutation',code:u.outcome.code,item:item.id,requirement:r.key};
      if (isRepair) {
        // Recorded either way. An accepted submission lists it only once the rounds are used up (W02 R[5]); a submission
        // that is not accepted lists it with the rounds left (W08 R[1]).
        repair = { kind: 'refutation', code: u.outcome.code, item: item.id, requirement: r.key, rounds_left: Math.max(0, budget - usedFor(run,r)) };
      }
      // W02 F[7], V05 R[2]: reject only a blocking code of a check that judges the artifact under verification.
      if (row?.action === 'reject' && u.outcome.tier === 'blocking' && u.check.judges === 'artifact_under_verification') reject = u.outcome.code;
    }
  } else if (staticDeclared && unknowns.length > 0) {
    // V01 R[2], R[6]: an unknown verdict is unchecked with its reason. CHOICE-4: the first unknown names the reason.
    const reason = unknowns[0].outcome.reason;
    staticLayer = { layer: 'static', terminal: 'unchecked', reason, attribution: attributionOfReason(reason) };
    met = null;
  } else if (staticDeclared) {
    // V01 R[6]: every outcome supports. A requirement that accepts a judgment keeps the judgment terminal (V03 R[4]):
    // pass would claim a fact. With no negative override, that judgment is what the requirement asked for.
    staticLayer = judging ? { layer: 'static', terminal: 'judgment' } : { layer: 'static', terminal: 'pass' };
    met = expectedCodes === null;
  }

  const layers: ExpectedLayer[] = [];
  const reasons: UnsatisfiedReason[] = [];
  let pending = false;
  if (staticLayer !== null) {
    layers.push(staticLayer);
    if (noProducer) reasons.push('no_producer');
    else if (met === null) pending = true;
    else if (!met) reasons.push('outcome_mismatch');
  }
  if (r.layers.includes('dynamic')) {
    // V03 R[1], R[5]: declared, and no integrity-proven observation was supplied, so the layer was not run. Not run is
    // unknown (V03 R[4]), so the requirement stays pending unless some other layer already missed its expectation.
    layers.push({ layer: 'dynamic', terminal: 'not_run', reason: 'no_check', attribution: attributionOfReason('no_check') });
    pending = true;
  }
  if (!staticDeclared && r.producer === 'independent_judgment' && r.checks.length === 0) reasons.push('no_producer');
  // Independence is a property of a judgment actually returned. An unknown or a refutation is not that judgment (V03 F[2]).
  if (r.producer === 'independent_judgment' && staticLayer?.terminal === 'judgment' && !independent(r, run.author, submission.judge)) reasons.push('independence_unknown');

  const reason = firstReason(reasons);
  const result: ExpectedRequirement =
    reason !== undefined
      ? { requirement: r.key, layers, status: 'unsatisfied', unsatisfied_reason: reason }
      : { requirement: r.key, layers, status: pending ? 'pending' : 'satisfied' };
  return { result, repair, reject };
}

// ---------------------------------------------------------------- the validation of one submission

function validate(run: RunDescription): void {
  const ids = new Set<string>();
  for (const it of run.items) {
    if (ids.has(it.id)) throw new Error(`item ${it.id} is listed twice`);
    ids.add(it.id);
  }
  const keys = new Set<string>();
  for (const r of run.requirements) {
    if (keys.has(r.key) || run.runLevel.includes(r.key)) throw new Error(`requirement ${r.key} is listed twice`);
    keys.add(r.key);
    if (r.layers.length === 0) throw new Error(`requirement ${r.key} declares no layer`);
    for (const row of r.errorTable) if ((row.action === 'repair') !== (row.maxRounds !== undefined)) throw new Error(`requirement ${r.key}: a repair row names its rounds, and only a repair row`);
  }
}

export function expected(run: RunDescription, submission: SubmissionDescription, outcomes: CheckOutcomes): Expected {
  validate(run);
  const checks = new Map(run.checks.map((c) => [c.id, c]));
  const max = runMaxRounds(run);
  const used = Math.min(max, Math.max(0, ...run.requirements.map((r) => Math.min(usedFor(run,r),repairRounds(r)))));
  const rounds = { used, max };
  const zero = { ...(Object.fromEntries(PARTITION.map((p) => [p, 0])) as Record<Partition, number>), unknown: 0 };

  if (submission.defects.length > 0) {
    // T03 R[3], W08 R[1]: not accepted; no partitions and no terminals (V05 R[5]); the errors list every code and the
    // item-level refutations of the items that still parse, with the rounds left.
    const errors: ExpectedError[] = submission.defects.map((code) => ({ kind: 'protocol', code }));
    for (const item of run.items) {
      for (const r of run.requirements) {
        const e = evaluate(run, submission, r, item, outcomes);
        // W08 R[1]: every item-level refutation, including one routed to reject, with the rounds left when it repairs.
        if (e.repair !== null) errors.push(e.repair);
        if (e.reject !== null) errors.push({ kind: 'refutation', code: e.reject, item: item.id, requirement: r.key });
      }
    }
    return { acceptance: 'not_accepted', rounds, items: [], counts: zero, errors };
  }

  const items: ExpectedItem[] = [];
  const errors: ExpectedError[] = [];
  const counts = { ...zero };
  for (const item of run.items) {
    const evaluations = run.requirements.map((r) => evaluate(run, submission, r, item, outcomes));
    const requirements = evaluations.map((e) => e.result);
    for (let i = 0; i < evaluations.length; i++) {
      const e = evaluations[i];
      // An open repair stays on the terminal until its rounds are used up (W02 R[5]). A request and a used-up repair are
      // errors now. A reject-routed refutation is an item-level refutation on the receipt whether or not it wins the
      // partition (the validation contract; V05 R[3] only orders the partition).
      if (e.repair !== null && (e.repair.rounds_left === undefined || e.repair.rounds_left === 0)) errors.push(e.repair);
      if (e.reject !== null) errors.push({ kind: 'refutation', code: e.reject, item: item.id, requirement: run.requirements[i].key });
    }

    // V03 R[10] and W07 R[2]-R[3]: every unresolved fact and missing artifact is visible with its own budget.
    for(const [i,r] of run.requirements.entries()){
      const left=Math.max(0,repairRounds(r)-usedFor(run,r));
      const handling=submission.items[item.id]?.handling;
      const needsArtifact=r.producer!=='fact'||r.checks.some(id=>checks.get(id)?.judges==='artifact_under_verification');
      for(const id of r.checks){
        if(handling!=='handled'&&checks.get(id)?.judges==='artifact_under_verification')continue;
        for(const outcome of outcomes[id]?.[item.id]??[])if(outcome.verdict==='unknown')errors.push({kind:'unknown',code:outcome.reason,item:item.id,requirement:r.key,rounds_left:left});
      }
      if(handling!=='handled'&&needsArtifact)errors.push({kind:'not_covered',code:left===0?'repair_exhausted':handling==='skipped'?'declared_skip':'not_covered',item:item.id,requirement:r.key,rounds_left:left});
      for(const layer of evaluations[i].result.layers){
        if(!layer.reason||!['unchecked','no_verdict','not_run','incomplete'].includes(layer.terminal))continue;
        const existing=errors.find(e=>e.item===item.id&&e.requirement===r.key&&(e.code===layer.reason||layer.code!==undefined&&e.code===layer.code));
        if(existing)existing.rounds_left??=left;
        else errors.push({kind:'unknown',code:layer.reason,item:item.id,requirement:r.key,rounds_left:left});
      }
    }

    // V05 R[3] in its order (steps 1-3 need effects and dispositions, which these scenarios do not carry).
    let partition: Partition = 'delivered';
    let code: string | undefined;
    let reason: Reason | undefined;
    const omitted = submission.items[item.id] === undefined && run.requirements.some(r => r.producer !== 'fact' || r.checks.some(id => run.checks.some(c => c.id === id && c.judges === 'artifact_under_verification')));
    if (omitted){const judgments=run.requirements.filter(r=>r.producer!=='fact'&&r.checks.length>0);errors.push({kind:'not_covered',code:'core.coverage.shortfall',item:item.id,rounds_left:judgments.length?Math.min(...judgments.map(r=>Math.max(0,repairRounds(r)-usedFor(run,r)))):0});}
    if (submission.items[item.id] === undefined && run.requirements.some(r => r.required && (r.producer !== 'fact' || r.checks.some(id => run.checks.some(c => c.id === id && c.judges === 'artifact_under_verification'))))) {
      // Step 4 and W07 R[3]: the submission does not cover the item; named in errors (CHOICE-12: with the run's rounds left).
      partition = 'incomplete';
      reason = run.requirements.some((r,i)=>r.required&&requirements[i].layers.some(l=>l.terminal==='incomplete'&&l.reason==='repair_exhausted'))?'repair_exhausted':'not_covered';
    } else {
      const stopped = run.requirements
        .map((r, i) => ({ r, layers: requirements[i].layers }))
        .find((x) => x.r.required && x.layers.some((l) => l.terminal === 'incomplete'));
      const rejecting = evaluations.find((e) => e.reject !== null);
      if (stopped !== undefined) {
        // Step 4: a required requirement ends incomplete at a declared layer.
        partition = 'incomplete';
        reason = stopped.layers.find((l) => l.terminal === 'incomplete')?.reason;
      } else if (rejecting !== undefined && rejecting.reject !== null) {
        // Step 5: the artifact under verification is refused by a blocking check. The code is already in errors.
        partition = 'rejected';
        code = rejecting.reject;
      }
    }

    const cells = Object.fromEntries(
      LAYER.map((layer) => [layer, cellOf(layer, requirements.flatMap((q) => q.layers.filter((l) => l.layer === layer).map((l) => l.terminal)))]),
    ) as Record<Layer, Cell | null>;
    const entry: ExpectedItem = { item: item.id, partition, requirements, cells };
    if (code !== undefined) entry.code = code;
    if (reason !== undefined) entry.reason = reason;
    items.push(entry);
    counts[partition]++;
    if (requirements.some((q) => q.layers.some((l) => isUnknown(l.layer, l.terminal)))) counts.unknown++;
  }
  return { acceptance: 'accepted', rounds, items, counts, errors };
}
