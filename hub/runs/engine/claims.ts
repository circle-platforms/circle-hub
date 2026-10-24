// Claims (B01) the engine records: a model's statements from the slots and cross_item entries (judgments with a declared
// producer, A01 R[2], V02 R[1]) and the Hub's own facts from the checks it re-ran (every outcome, support included; a new
// independent ground, A04 R[2]). Each carries its validity bindings: the pack digest, the locked root and the digests of
// what it cites.
import { QUALIFIER_MARK, type BasisRank, type Independence, type QualifierMark, type SourceRole } from '../../../contracts/generated/vocabulary.ts';
import { Claim, type ValueResolution } from '../../../contracts/src/claim.ts';
import type {Coverage} from '../../../contracts/src/common.ts';
import type {SourceBinding} from '../../../contracts/src/run.ts';
import type { SlotClaim } from '../../../contracts/src/pack.ts';
import { Ground } from '../../../contracts/src/reference.ts';
import { parseReference } from '../../refs/api.ts';
import type { CheckOutcome } from '../../rules/api.ts';
import { unique } from './util.ts';

/** Only src, tree and rec references stand as grounds; a knowledge entry never does on its own (B01 R[5]). */
export function groundsOnly(references: Iterable<string>): string[] {
  return unique([...references].filter((r) => Ground.safeParse(r).success));
}

/** The digest a reference is rooted in: source bytes, tree root or record. */
export function rootDigest(reference: string): string | null {
  try {
    const ref = parseReference(reference);
    if (ref.scheme === 'src') return ref.sha256;
    if (ref.scheme === 'tree') return ref.root;
    if (ref.scheme === 'rec') return ref.record;
    return ref.entry;
  } catch {
    return null;
  }
}

/** Source roles in the order a claim's role is taken from what it cites: hint only when nothing stronger is cited (A03 R[6]). */
const ROLE_ORDER = {
  expected: 0,
  subject: 1,
  artifact_under_verification: 2,
  reported_actual: 3,
  request_text: 4,
  republished: 5,
  hint: 6,
} as const satisfies Record<SourceRole, number>;

export function strongestRole(roles: Iterable<SourceRole | null | undefined>): SourceRole | undefined {
  let best: SourceRole | undefined;
  for (const role of roles) if (role && (best === undefined || ROLE_ORDER[role] < ROLE_ORDER[best])) best = role;
  return best;
}


/** Read observations of the actually addressed sources; never infer full coverage from absent legacy metadata. */
export function sourceCoverage(sources:readonly SourceBinding[],references:Iterable<string>):Coverage|undefined {
  const roots=new Set([...references].map(reference=>/^[a-f0-9]{64}$/.test(reference)?reference:rootDigest(reference)).filter((root):root is string=>root!==null));
  const selected=sources.filter(source=>roots.has(rootDigest(source.reference)??''));
  const missing=selected.filter(source=>source.external!==undefined && source.coverage===undefined).length;
  const covered=selected.filter(source=>source.coverage!==undefined).map(source=>source.coverage!);
  if(covered.length===0)return undefined;
  if(covered.length===1 && missing===0)return {...covered[0]};
  const note=[...new Set(covered.flatMap(value=>value.note?[value.note]:[])),...(missing?[`另有 ${missing} 个所依外部来源未声明覆盖；当前计数只合计有声明的来源，重读缺项后再确认范围`]:[])].join('；');
  return {complete:missing===0 && covered.every(value=>value.complete),examined:covered.reduce((n,value)=>n+value.examined,0),...(missing===0 && covered.every(value=>value.total!==undefined)?{total:covered.reduce((n,value)=>n+value.total!,0)}:{}),...(note?{note}:{} )};
}

export interface JudgmentClaimInput {
  coverage?:Coverage;
  item?: string;
  requirement?: string;
  pointer: string;
  text: string;
  code?: string;
  rank?: string;
  data?: Record<string, unknown>;
  /** The declared model and exact configuration (warrant, A01 R[4]). */
  model: string;
  independence?: Independence;
  marks: QualifierMark[];
  sourceRole?: SourceRole;
  grounds: string[];
  resolutions: ValueResolution[];
  bound: string[];
  premises?: string[];
}

/** A model's statement: nature judgment, provenance declared, the model as producer, semantics unasserted (V02 R[1]). */
export function judgmentClaim(input: JudgmentClaimInput): Claim {
  const marks = unique<QualifierMark>(['semantics_unasserted', ...input.marks,...(input.coverage?.complete===false?['partial' as const]:[])]);
  const claim: Claim = {
    ...(input.item !== undefined ? { item: input.item } : {}),
    ...(input.requirement !== undefined ? { requirement: input.requirement } : {}),
    pointer: input.pointer,
    statement: {
      text: input.text,
      ...(input.code !== undefined ? { code: input.code } : {}),
      ...(input.rank !== undefined ? { rank: input.rank } : {}),
      ...(input.data !== undefined ? { data: input.data } : {}),
    },
    qualifier: {
      nature: 'judgment',
      provenance: 'declared',
      basis_rank: 'judgment',
      ...(input.sourceRole !== undefined ? { source_role: input.sourceRole } : {}),
      marks,
      ...(input.coverage?{coverage:input.coverage}:{}),
    },
    grounds: groundsOnly(input.grounds),
    warrant: { producer: 'model', id: input.model, ...(input.independence !== undefined ? { independence: input.independence } : {}) },
    ...(input.resolutions.length > 0 ? { resolution: worstResolution(input.resolutions), resolutions: input.resolutions } : {}),
    validity: { status: 'valid', bound: unique(input.bound).sort(), premises: input.premises ?? [] },
  };
  return Claim.parse(claim);
}

function worstResolution(resolutions: readonly ValueResolution[]): ValueResolution['resolution'] {
  if (resolutions.some((r) => r.resolution === 'unresolved')) return 'unresolved';
  if (resolutions.some((r) => r.resolution === 'ambiguous')) return 'ambiguous';
  return 'resolved';
}

export interface FactClaimInput {
  runtime?: {admitted:boolean;admission:string;run:string;table:string;submission:string};
  coverage?:Coverage;
  item?: string;
  requirement?: string;
  // Check outputs validate their tier at the check boundary. Projection facts have no check tier to consume here.
  outcome: Omit<CheckOutcome, 'tier'> & Partial<Pick<CheckOutcome, 'tier'>>;
  /** rule@version of the check: the interpreter, or the pack function check of the pack version. */
  rule: string;
  judges: SourceRole;
  /** The check read model judgments (the slots): a rule over claims, conditional on judgment (A02 R[3]). */
  overClaims: boolean;
  /** The requirement asks for discriminating power, which runs cannot establish (V06 R[3]). */
  discrimination: boolean;
  /** The check's sample marks (T02 R[1]: a rule with only author samples supports its facts marked 仅作者样例). */
  sampleMarks?: readonly QualifierMark[];
  bound: string[];
  /** The judgments a rule over claims rests on: pointers into the submission, or the carried record (V03 R[6], A02 R[3]). */
  premises?: string[];
}

/**
 * A Hub fact from a check outcome: support, refute or unknown with the outcome's statement, data and grounds (V01 R[4]). An
 * unknown outcome is not on the basis lattice (A02: a claim without grounds is unknown), so it carries no basis rank and
 * nothing it would be conditional on.
 */
export function factClaim(input: FactClaimInput): Claim {
  const o = input.outcome;
  const known = o.verdict !== 'unknown';
  const basis: BasisRank = input.overClaims ? 'rule_over_claims' : 'rule_over_observation';
  const conditional = known && (input.overClaims || input.runtime?.admitted === false);
  const unestablished = input.runtime !== undefined ? !input.runtime.admitted : input.discrimination;
  // Vocabulary order (QUALIFIER_MARK), deduplicated: the marks the run adds and the check's own sample marks.
  const marks = unique<QualifierMark>([...(conditional ? ['conditional_on_judgment' as const] : []), ...(unestablished ? ['discrimination_not_established' as const] : []), ...(input.sampleMarks ?? []),...(input.coverage?.complete===false?['partial' as const]:[])]).sort(
    (a, b) => QUALIFIER_MARK.indexOf(a) - QUALIFIER_MARK.indexOf(b),
  );
  const claim: Claim = {
    ...(input.item !== undefined ? { item: input.item } : {}),
    ...(input.requirement !== undefined ? { requirement: input.requirement } : {}),
    ...(o.pointer !== undefined ? { pointer: o.pointer } : {}),
    statement: {
      text: o.statement,
      verdict: o.verdict,
      ...(o.code !== undefined ? { code: o.code } : {}),
      ...(o.reason !== undefined ? { reason: o.reason } : {}),
      ...(input.runtime ? {data:{...o.data,admission:input.runtime.admission}} : o.data !== undefined ? { data: o.data } : {}),
    },
    qualifier: {
      nature: known ? 'fact' : 'unknown',
      provenance: 'projected',
      ...(known ? { basis_rank: basis } : {}),
      source_role: input.judges,
      marks,
      ...(input.coverage?{coverage:input.coverage}:{}),
      ...(input.runtime?.admitted ? {discriminating_power:'established' as const} : unestablished ? {discriminating_power:'not_established' as const} : {}),
    },
    grounds: groundsOnly([...o.grounds,...(input.runtime?.admitted?[input.runtime.admission]:[])]),
    warrant: { producer: 'function', id: input.rule, independence: 'judge_not_author' },
    validity: { status: 'valid', bound: unique([...input.bound,...(input.runtime ? [input.runtime.run,input.runtime.table,input.runtime.submission] : [])]).sort(), premises: conditional ? unique(input.premises ?? []) : [] },
  };
  return Claim.parse(claim);
}

/** The statement fields of a slot claim. */
export function statementOf(claim: SlotClaim): Pick<JudgmentClaimInput, 'text' | 'code' | 'rank' | 'data'> {
  return {
    text: claim.text,
    ...(claim.code !== undefined ? { code: claim.code } : {}),
    ...(claim.rank !== undefined ? { rank: claim.rank } : {}),
    ...(claim.data !== undefined ? { data: claim.data } : {}),
  };
}
