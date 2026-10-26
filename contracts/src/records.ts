// Record envelope: the append-only record table's row shape (formatProposals.recordStructure). The body schema depends on `schema`.
import { z } from 'zod';
import { LeaseOpSchema, ProvenanceTypeSchema } from '../generated/vocabulary.ts';
import { RunId } from './common.ts';
import { RECORD_KINDS } from '../generated/protocol.ts';
import { IsoTime, RecordId, SchemaId, Sha256 } from './common.ts';

export const RecordKindSchema = z.enum(RECORD_KINDS);

/** The detail a `lease` action carries (B05 F[0] milestone: the lease action kind): what happened to which keys, held
 * by whom, until when, with the fencing token. The token lives only in the Hub's own action records (D04 R[0] last
 * sentence), never in what a client sees. */
const HeldLeaseDetail = z.strictObject({
  op: LeaseOpSchema.exclude(['register', 'unregister']),
  lease: z.string().min(1).describe('the lease identity (lse_…) the keys are held under'),
  keys: z.array(z.string().min(1)).min(1),
  holder: z.strictObject({ user: z.string().min(1), run: RunId }).describe('the user and the run that hold the lease'),
  until: z.string().min(1).nullable().describe('the end moment of the lease after this operation (ISO time)'),
  token: z.number().int().nonnegative().describe('the fencing token after this operation: monotonic per key row'),
});

export const LeaseRegistrationDetail = z.strictObject({
  op: LeaseOpSchema.extract(['register', 'unregister']),
  prefix: z.string().min(1).endsWith('/'),
  owner: z.string().min(1),
  previous_owner: z.string().min(1).nullable(),
  by: z.string().min(1),
  reason: z.string().min(1).refine(value => value.trim().length > 0, "reason must contain non-whitespace text"),
});
export const LeaseDetail = z.union([HeldLeaseDetail, LeaseRegistrationDetail]);

export const RecordEnvelope = z.strictObject({
  id: RecordId,
  kind: RecordKindSchema,
  schema: SchemaId.describe('name@major of the body shape, a key of SCHEMA_REGISTRY, for example validation@1'),
  digest: Sha256.describe('SHA-256 of the RFC 8785 canonical JSON of {kind, schema, provenance, created_at, body}'),
  provenance: ProvenanceTypeSchema.describe('provenance type (A01) of the recorded content'),
  created_at: IsoTime,
  body: z.unknown(),
});
export type RecordEnvelope = z.infer<typeof RecordEnvelope>;
