// Validation result (W08, validation@1): what the Hub's boundary validation produces for one submission.
import { z } from 'zod';
import {
  AcceptanceSchema,
  AttributionSchema,
  CheckTierSchema,
  DynamicTerminalSchema,
  PARTITION,
  ReasonSchema,
  RequirementStatusSchema,
  STATIC_TERMINAL, DYNAMIC_TERMINAL, ExitActionSchema, RequestKindSchema,
  StaticTerminalSchema,
  UnsatisfiedReasonSchema,
  type DynamicTerminal,
  type Layer,
  type Partition,
  type StaticTerminal,
} from '../generated/vocabulary.ts';
import { Claim } from './claim.ts';
import { Coverage, IsoTime, UserId, ItemId, ProtocolError, RunId, Sha256, TraceId } from './common.ts';
import { ReferenceUri, referenceUriOf } from './reference.ts';

/** One concrete fact the process must obtain; whitespace never describes a missing fact. */
export const MissingFact = z.string().regex(/\S/, 'name the missing fact');
/** A nonblank external account identity supplied by the referenced mapping. */
export const MappedIdentity=z.string().regex(/\S/,'name the mapped external identity').describe('External account identity bound by the referenced mapping');
/** Named request recipients are accounts or mapped external identities, never a role placeholder. */
export const ExitAudience = z.union([
  z.strictObject({hub:z.literal(true)}),
  z.strictObject({user:UserId}),
  z.strictObject({external:z.strictObject({mapping:referenceUriOf('rec'),identity:MappedIdentity})}),
]);
export const UnknownExit = z.strictObject({
  action:ExitActionSchema,
  request_kind:RequestKindSchema.optional(),
  audience:ExitAudience,
  due:IsoTime.describe('Absolute next-execution time or the named request deadline; never inferred when reading history'),
}).superRefine((exit,ctx)=>{
  if(exit.action==='request'){
    if(exit.request_kind===undefined)ctx.addIssue({code:'custom',path:['request_kind'],message:'a request exit names its request kind'});
    if('hub'in exit.audience)ctx.addIssue({code:'custom',path:['audience'],message:'a request names a person, not the Hub'});
  }else{
    if(exit.request_kind!==undefined)ctx.addIssue({code:'custom',path:['request_kind'],message:'only a request exit names a request kind'});
    if(!('hub'in exit.audience))ctx.addIssue({code:'custom',path:['audience'],message:'a non-request action is scheduled by the Hub; human work needs a request'});
  }
}).meta({allOf:[{if:{properties:{action:{const:'request'}},required:['action']},then:{properties:{request_kind:{},audience:{type:'object',not:{required:['hub'],properties:{hub:{}}}}},required:['request_kind']},else:{properties:{audience:{type:'object',properties:{hub:{const:true}},required:['hub']}},not:{required:['request_kind'],properties:{request_kind:{}}}}}]});
export type UnknownExit=z.infer<typeof UnknownExit>;
export const RecoveryGap=z.strictObject({reason:ReasonSchema,missing:MissingFact,exit:UnknownExit});
/** JSON Schema carries the same unknown-boundary condition as the Zod admission refinement. */
export function recoveryCondition(field:string,values:readonly string[],required:readonly string[]):Record<string,unknown>{
  return {allOf:[{if:{properties:{[field]:{enum:[...values]}},required:[field]},then:{properties:Object.fromEntries(required.map(key=>[key,{}])),required:[...required]}}]};
}

type Presence = 'required' | 'optional' | 'forbidden';
/** What a layer terminal carries (V03 F[0]-F[1], R[4]; V04 R[1]); `unknown` marks the terminals counted as unknown. */
interface TerminalRule {
  code: Presence;
  reason: Presence;
  attribution: boolean;
  unknown: boolean;
}

const STATIC_TERMINAL_RULES = {
  pass: { code: 'forbidden', reason: 'forbidden', attribution: false, unknown: false },
  violation: { code: 'required', reason: 'optional', attribution: true, unknown: false },
  judgment: { code: 'optional', reason: 'optional', attribution: false, unknown: false },
  unchecked: { code: 'optional', reason: 'required', attribution: true, unknown: true },
  incomplete: { code: 'optional', reason: 'required', attribution: true, unknown: false },
} as const satisfies Record<StaticTerminal, TerminalRule>;

const DYNAMIC_TERMINAL_RULES = {
  pass: { code: 'forbidden', reason: 'forbidden', attribution: false, unknown: false },
  fail: { code: 'required', reason: 'optional', attribution: true, unknown: false },
  no_verdict: { code: 'optional', reason: 'required', attribution: true, unknown: true },
  not_run: { code: 'optional', reason: 'required', attribution: true, unknown: true },
  incomplete: { code: 'optional', reason: 'required', attribution: true, unknown: false },
} as const satisfies Record<DynamicTerminal, TerminalRule>;

type LayerFields = { terminal: string; code?: string; reason?: string; attribution?: string;missing?:string;exit?:unknown };

function ruleOf(rules: Record<string, TerminalRule>, terminal: string): TerminalRule | undefined {
  return Object.hasOwn(rules, terminal) ? rules[terminal] : undefined;
}

function checkTerminal(rules: Record<string, TerminalRule>, r: LayerFields, ctx: z.core.$RefinementCtx<LayerFields>,requireExit=true): void {
  const rule = ruleOf(rules, r.terminal);
  if (rule === undefined) return;
  for (const field of ['code', 'reason'] as const) {
    if (rule[field] === 'required' && r[field] === undefined) ctx.addIssue({ code: 'custom', path: [field], message: `a ${r.terminal} terminal needs a ${field}` });
    if (rule[field] === 'forbidden' && r[field] !== undefined) ctx.addIssue({ code: 'custom', path: [field], message: `a ${r.terminal} terminal carries no ${field}` });
  }
  if(requireExit&&rule.reason==='required')for(const field of ['missing','exit'] as const)if(r[field]===undefined)ctx.addIssue({code:'custom',path:[field],message:'a transitional layer needs '+field});
  if (!rule.attribution && r.attribution !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['attribution'], message: 'attribution hangs only on a non-pass terminal that is not a judgment (V04 R[1])' });
  }
}

const layerFields = {
  missing:MissingFact.optional(),
  exit:UnknownExit.optional(),
  gaps:z.array(RecoveryGap).min(1).optional().describe('Additional independent causes, each with its own missing fact and exit; never replace them with a primary reason'),
  code: z.string().min(1).optional().describe('violation code; required when the terminal is violation or fail'),
  tier: CheckTierSchema.optional(),
  reason: ReasonSchema.optional().describe('why; required when the terminal is unknown (unchecked, no verdict, not run) or incomplete'),
  attribution: AttributionSchema.optional().describe("only on a non-pass terminal that misses the check contract's expected outcome, never on a judgment (V04)"),
};

/** Terminal state of the static layer of one (item, requirement). */
export const StaticLayerResult = z
  .strictObject({ layer: z.literal('static' satisfies Layer), terminal: StaticTerminalSchema, ...layerFields })
  .superRefine((r, ctx) => checkTerminal(STATIC_TERMINAL_RULES, r, ctx)).meta(recoveryCondition('terminal',STATIC_TERMINAL.filter(t=>STATIC_TERMINAL_RULES[t].reason==='required'),['missing','exit','reason']));

/** Terminal state of the dynamic layer of one (item, requirement). */
export const DynamicLayerResult = z
  .strictObject({ layer: z.literal('dynamic' satisfies Layer), terminal: DynamicTerminalSchema, ...layerFields })
  .superRefine((r, ctx) => checkTerminal(DYNAMIC_TERMINAL_RULES, r, ctx)).meta(recoveryCondition('terminal',DYNAMIC_TERMINAL.filter(t=>DYNAMIC_TERMINAL_RULES[t].reason==='required'),['missing','exit','reason']));

/** Terminal state of one (item, requirement, layer). A layer the requirement does not declare has no entry: the screen says "not applicable". */
export const LayerResult = z.discriminatedUnion('layer', [StaticLayerResult, DynamicLayerResult]);
export type LayerResult = z.infer<typeof LayerResult>;

/** Unchecked, no verdict and not run are unknown (V03 R[4]); incomplete is its own state. */
export function isUnknownTerminal(layer: LayerResult): boolean {
  const rules: Record<string, TerminalRule> = layer.layer === 'static' ? STATIC_TERMINAL_RULES : DYNAMIC_TERMINAL_RULES;
  return ruleOf(rules, layer.terminal)?.unknown === true;
}

export const RequirementResult = z
  .strictObject({
    requirement: z.string().min(1),
    layers: z.array(LayerResult).describe('one entry per declared layer'),
    status: RequirementStatusSchema,
    unsatisfied_reason: UnsatisfiedReasonSchema.optional().describe('given exactly when the status is unsatisfied (V03 F[2])'),
    claims: z.array(Claim).describe('in display order: position, statement, nature and basis rank, qualifier, grounds, producer, resolution, validity'),
  })
  .superRefine((r, ctx) => {
    const seen = new Set<string>();
    r.layers.forEach((l, i) => {
      if (seen.has(l.layer)) ctx.addIssue({ code: 'custom', path: ['layers', i, 'layer'], message: `the ${l.layer} layer has one terminal state, listed once` });
      seen.add(l.layer);
    });
    if ((r.status === 'unsatisfied') !== (r.unsatisfied_reason !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['unsatisfied_reason'], message: 'an unsatisfied requirement names its reason, and only an unsatisfied one does' });
    }
  });
export type RequirementResult = z.infer<typeof RequirementResult>;

/** One item result: the common fields plus what its partition adds. Requirement keys are unique per item (checked in Partitions). */
function itemResult<const E extends z.ZodRawShape>(extra: E) {
  return z.strictObject({
    item: ItemId,
    label: z.string(),
    skip_reason:MissingFact.optional().describe('The submitted skipped-item reason preserved verbatim in the result; never inferred from a generic reason code'),
    location: ReferenceUri.describe('reference URI of the item in the judged source'),
    ...extra,
    carried_over: referenceUriOf('rec')
      .optional()
      .describe('the predecessor run fragment this item was carried over from; set only after the Hub checked that the item and the cited content are unchanged (C08 R[4])'),
    requirements: z.array(RequirementResult),
  });
}

/** The items of each partition and what they carry (V05 F[0]-F[3]); keyed by the generated partition vocabulary. */
export const PartitionItem = {
  delivered: itemResult({}),
  rejected: itemResult({ code: z.string().min(1).describe('the code that put the item here (V05 F[1], R[2])') }),
  quarantined: itemResult({ reason: ReasonSchema.describe('why the item is held (V05 F[2])') }),
  incomplete: itemResult({ reason: ReasonSchema.describe('why the item is not complete, for example not_covered or declared_skip (V05 F[3])') }),
} satisfies Record<Partition, z.ZodType>;
export type ItemResult = z.infer<(typeof PartitionItem)[Partition]>;

type PartitionArrays = { [P in Partition]: z.ZodArray<(typeof PartitionItem)[P]> };
const partitionArrays = Object.fromEntries(
  PARTITION.map((p) => {
    // A partition added to the model without an item shape here must stop the generator.
    if (!Object.hasOwn(PartitionItem, p)) throw new Error(`partition ${p} has no item shape in contracts/src/validation.ts`);
    return [p, z.array(PartitionItem[p])];
  }),
) as PartitionArrays;

/**
 * The partitioned manifest (V05): one array per partition. A partition is cited as `rec:<digest>#/partitions/<partition>`
 * and an item as `rec:<digest>#/partitions/<partition>/<n>` (B03 F[3]). The partitions are disjoint (V05 R[0]); that their
 * union is the run's item set is checked by the runs package, which knows the items.
 */
export const Partitions = z.strictObject(partitionArrays).superRefine((parts, ctx) => {
  const first = new Map<string, string>();
  for (const p of PARTITION) {
    (parts[p] ?? []).forEach((it, i) => {
      const seen = first.get(it.item);
      if (seen === undefined) first.set(it.item, `${p}/${i}`);
      else ctx.addIssue({ code: 'custom', path: [p, i, 'item'], message: `item ${it.item} is already listed at ${seen}: every item is in exactly one partition (V05 R[0])` });
      const keys = new Set<string>();
      it.requirements.forEach((r, j) => {
        if (keys.has(r.requirement)) ctx.addIssue({ code: 'custom', path: [p, i, 'requirements', j, 'requirement'], message: `requirement ${r.requirement} is listed twice for this item` });
        keys.add(r.requirement);
      });
    });
  }
});
export type Partitions = z.infer<typeof Partitions>;

export const Locks = z.strictObject({
  pack: z.string().describe('pack id@version'),
  pack_digest: Sha256,
  unversioned_root: Sha256.optional().describe('product-wide knowledge root locked for this run'),
  root: Sha256.optional().describe('knowledge root digest locked at start_run'),
  policy: z.string().optional(),
});

const count = z.number().int().nonnegative();

/** Repair rounds of the requirements of the run: used so far and the maximum (W02 R[5]). */
export const Rounds = z.strictObject({ used: count, max: count }).refine((r) => r.used <= r.max, { message: 'used rounds cannot exceed the maximum', path: ['used'] });

export const ValidationResult = z
  .strictObject({
    schema: z.literal('validation@1'),
  contributions: z.strictObject({ submitted: z.number().int().nonnegative(),
    stored: z.array(z.strictObject({ item: z.string(), record: Sha256 })),
    not_stored: z.array(z.strictObject({ item: z.string(), reason: z.string() })),
  }).optional().describe('Dedicated contribution run receipt; ordinary submissions never write the knowledge layer'),
    run: RunId,
    submission: Sha256.describe('digest of the submission as received, the idempotency key together with the run'),
    acceptance: AcceptanceSchema,
    errors: z.array(ProtocolError).describe('every code that kept the submission from being accepted, item-level refutations with their fixes and rounds left, and items the submission did not cover'),
    rounds: Rounds,
    partitions: Partitions,
    cross_item: z.array(Claim).describe('claims over several items, listed apart and not counted in any partition'),
    coverage: Coverage,
    locks: Locks,
    trace: TraceId.describe('trace id of the call that produced this result'),
  })
  .superRefine((v, ctx) => {
    if (v.contributions !== undefined) {
      const c = v.contributions;
      if (c.submitted !== c.stored.length + c.not_stored.length) ctx.addIssue({code:'custom',path:['contributions'],message:'contribution receipt counts agree'});
      if (v.acceptance === 'not_accepted' && c.stored.length > 0) ctx.addIssue({code:'custom',path:['contributions','stored'],message:'a refused submission admits no contribution'});
    }
    if (v.acceptance !== 'not_accepted') return;
    if (v.errors.length === 0) ctx.addIssue({ code: 'custom', path: ['errors'], message: 'a submission that is not accepted names its codes (W08 R[1])' });
    for (const p of PARTITION) {
      if ((v.partitions[p] ?? []).length > 0) ctx.addIssue({ code: 'custom', path: ['partitions', p], message: 'a submission that is not accepted produces no partitions (V05 R[5], W08 R[1])' });
    }
    if (v.cross_item.length > 0) ctx.addIssue({ code: 'custom', path: ['cross_item'], message: 'a submission that is not accepted produces no cross-item claims (W08 R[1])' });
  });
export type ValidationResult = z.infer<typeof ValidationResult>;

const partitionCountShape = Object.fromEntries(PARTITION.map((p) => [p, count])) as Record<Partition, typeof count>;

/** Counts derived from the partitions of a validation result, never stored with it (W08 R[0]); the response carries them for the first content line (D05 R[1]). */
export const PartitionCounts = z.strictObject({
  ...partitionCountShape,
  unknown: count.describe('items with at least one layer terminal that is unknown: unchecked, no verdict or not run (V03 R[4])'),
});
export type PartitionCounts = z.infer<typeof PartitionCounts>;

/** The counts of a manifest: items per partition, and items with an unknown layer terminal in any partition. */
export function partitionCountsOf(partitions: Partitions): PartitionCounts {
  const counts = Object.fromEntries(PARTITION.map((p) => [p, partitions[p].length])) as Record<Partition, number>;
  let unknown = 0;
  for (const p of PARTITION) {
    for (const it of partitions[p]) if (it.requirements.some((r) => r.layers.some(isUnknownTerminal))) unknown++;
  }
  return { ...counts, unknown };
}


/** Read-only historical shape: omissions are preserved, not backfilled into old append-only records. */
export const StoredLayerResult=z.discriminatedUnion('layer',[
  z.strictObject({layer:z.literal('static' satisfies Layer),terminal:StaticTerminalSchema,...layerFields}).superRefine((r,ctx)=>checkTerminal(STATIC_TERMINAL_RULES,r,ctx,false)),
  z.strictObject({layer:z.literal('dynamic' satisfies Layer),terminal:DynamicTerminalSchema,...layerFields}).superRefine((r,ctx)=>checkTerminal(DYNAMIC_TERMINAL_RULES,r,ctx,false)),
]);
const StoredRequirementResult=RequirementResult.safeExtend({layers:z.array(StoredLayerResult)});
const storedRequirementFields={requirements:z.array(StoredRequirementResult)};
export const StoredPartitionItem={
  delivered:PartitionItem.delivered.safeExtend(storedRequirementFields),
  rejected:PartitionItem.rejected.safeExtend(storedRequirementFields),
  quarantined:PartitionItem.quarantined.safeExtend(storedRequirementFields),
  incomplete:PartitionItem.incomplete.safeExtend(storedRequirementFields),
} satisfies Record<Partition,z.ZodType>;
const storedArrays=Object.fromEntries(PARTITION.map(p=>[p,z.array(StoredPartitionItem[p])])) as PartitionArrays;
export const StoredValidationResult=ValidationResult.safeExtend({partitions:Partitions.safeExtend(storedArrays)});
/** Missing recovery facts on one immutable historical item; paths are relative to the supplied prefix. */
export function storedItemNotices(item:Pick<z.infer<typeof StoredPartitionItem.delivered>,'requirements'>,prefix=''){
  const notices:Array<{path:string;message:string}>=[];
  item.requirements.forEach((requirement,j)=>requirement.layers.forEach((layer,k)=>{
    const rules=layer.layer==='static'?STATIC_TERMINAL_RULES:DYNAMIC_TERMINAL_RULES;
    if(ruleOf(rules,layer.terminal)?.reason!=='required')return;
    const path=prefix+'/requirements/'+j+'/layers/'+k;
    if(layer.exit===undefined)notices.push({path:path+'/exit',message:'出口未写'});
    if(layer.missing===undefined)notices.push({path:path+'/missing',message:'缺失事实未写'});
  }));
  return notices;
}
export function readStoredValidationResult(value:unknown){
  const result=StoredValidationResult.parse(value),notices:Array<{path:string;message:string}>=[];
  for(const p of PARTITION)result.partitions[p].forEach((item,i)=>notices.push(...storedItemNotices(item,'/partitions/'+p+'/'+i)));
  return {result,notices};
}
