// Claim (B01): everything the Hub says or records about what was said. Trust comes only from the credentials it carries.
import { z } from 'zod';
import {
  BasisRankSchema,
  ControlSchema,
  DiscriminatingPowerSchema,
  IndependenceSchema,
  NatureSchema,
  ProducerKindSchema,
  ProvenanceTypeSchema,
  QualifierMarkSchema,
  ReasonSchema,
  ResolutionSchema,
  SourceRoleSchema,
  ValidityStatusSchema,
  VerdictSchema,
  type Resolution,
} from '../generated/vocabulary.ts';
import { Coverage, IsoTime, ItemId, JsonPointer, Sha256 } from './common.ts';
import { Ground } from './reference.ts';

/** Who or what produced the claim: `rule@version`, `model@exact configuration` (client declared), a Hub account, or `target@version`. */
export const Warrant = z.strictObject({
  producer: ProducerKindSchema,
  id: z.string().min(1),
  independence: IndependenceSchema.optional(),
});
export type Warrant = z.infer<typeof Warrant>;

export const Qualifier = z.strictObject({
  nature: NatureSchema,
  provenance: ProvenanceTypeSchema,
  basis_rank: BasisRankSchema.optional(),
  source_role: SourceRoleSchema.optional(),
  marks: z.array(QualifierMarkSchema),
  coverage: Coverage.optional(),
  collected_at: IsoTime.optional().describe('time bound: when the observation the claim rests on was collected; it holds only for that moment (A05)'),
  control: ControlSchema.optional(),
  discriminating_power: DiscriminatingPowerSchema.optional(),
});
export type Qualifier = z.infer<typeof Qualifier>;

/** What the claim is bound to and when it stops holding. Users re-read this before relying on the claim. */
export const Validity = z.strictObject({
  status: ValidityStatusSchema,
  bound: z.array(Sha256).describe('digests the claim depends on; a change in any of them voids it'),
  expires_at: IsoTime.optional(),
  premises: z.array(z.string()),
});
export type Validity = z.infer<typeof Validity>;

export const Statement = z.strictObject({
  text: z.string(),
  verdict: VerdictSchema.optional(),
  code: z.string().optional().describe('violation code or finding code'),
  reason: ReasonSchema.optional().describe('why the verdict is unknown: check error, timeout, missing input (V01 R[2])'),
  rank: z.string().optional().describe('ranking level from the closed set the pack declares; for sorting and display only (V02)'),
  data: z.record(z.string(), z.unknown()).optional().describe('machine-readable parts of the statement'),
});
export type Statement = z.infer<typeof Statement>;

/** How many referents each resolution state has (T04 R[2]): at least one, at least two candidates, none. */
const REFERENTS = { resolved: 1, ambiguous: 2, unresolved: 0 } as const satisfies Record<Resolution, number>;

/** One exact value of a statement beside what it resolved to: the model's text and the reference side by side (T04 R[1]). */
export const ValueResolution = z
  .strictObject({
    pointer: JsonPointer.describe('where the value stands, as a JSON Pointer into the submission'),
    text: z.string().min(1).describe('the exact value or quotation as the model wrote it'),
    resolution: ResolutionSchema,
    references: z.array(Ground).describe('what it resolved to: one or more when resolved, the candidates when ambiguous, none when unresolved'),
  })
  .superRefine((v, ctx) => {
    const wanted = REFERENTS[v.resolution];
    const ok = v.resolution === 'unresolved' ? v.references.length === 0 : v.references.length >= wanted;
    if (!ok) ctx.addIssue({ code: 'custom', path: ['references'], message: `${v.resolution} needs ${wanted === 0 ? 'no reference' : `at least ${wanted} references`}` });
  });
export type ValueResolution = z.infer<typeof ValueResolution>;

export const Claim = z.strictObject({
  item: ItemId.optional(),
  requirement: z.string().optional(),
  pointer: JsonPointer.optional().describe('where the claim comes from: a JSON Pointer into the submission, or into the checked subject'),
  statement: Statement,
  qualifier: Qualifier,
  grounds: z.array(Ground).describe('references the claim rests on; a knowledge entry is cited by its tree address (B01 R[5])'),
  warrant: Warrant,
  resolution: ResolutionSchema.optional(),
  resolutions: z.array(ValueResolution).optional().describe('each exact value of the statement with what it resolved to (W08, T04 R[1])'),
  validity: Validity,
});
export type Claim = z.infer<typeof Claim>;
