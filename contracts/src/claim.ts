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
  ResolutionSchema,
  SourceRoleSchema,
  ValidityStatusSchema,
  VerdictSchema,
} from '../generated/vocabulary.ts';
import { Coverage, IsoTime, Sha256 } from './common.ts';
import { ReferenceUri } from './reference.ts';

/** Who or what produced the claim: `rule@version`, `model@exact configuration` (client declared), a Hub account, or `target@version`. */
export const Warrant = z.object({
  producer: ProducerKindSchema,
  id: z.string().min(1),
  independence: IndependenceSchema.optional(),
});
export type Warrant = z.infer<typeof Warrant>;

export const Qualifier = z.object({
  nature: NatureSchema,
  provenance: ProvenanceTypeSchema,
  basis_rank: BasisRankSchema.optional(),
  source_role: SourceRoleSchema.optional(),
  marks: z.array(QualifierMarkSchema),
  coverage: Coverage.optional(),
  control: ControlSchema.optional(),
  discriminating_power: DiscriminatingPowerSchema.optional(),
});
export type Qualifier = z.infer<typeof Qualifier>;

/** What the claim is bound to and when it stops holding. Users re-read this before relying on the claim. */
export const Validity = z.object({
  status: ValidityStatusSchema,
  bound: z.array(Sha256).describe('digests the claim depends on; a change in any of them voids it'),
  expires_at: IsoTime.optional(),
  premises: z.array(z.string()),
});
export type Validity = z.infer<typeof Validity>;

export const Statement = z.object({
  text: z.string(),
  verdict: VerdictSchema.optional(),
  code: z.string().optional().describe('violation code or finding code'),
  data: z.record(z.string(), z.unknown()).optional().describe('machine-readable parts of the statement'),
});

export const Claim = z.object({
  item: z.string().optional(),
  requirement: z.string().optional(),
  statement: Statement,
  qualifier: Qualifier,
  grounds: z.array(ReferenceUri),
  warrant: Warrant,
  resolution: ResolutionSchema.optional(),
  validity: Validity,
});
export type Claim = z.infer<typeof Claim>;
