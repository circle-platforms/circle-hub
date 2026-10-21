// Record envelope: the append-only record table's row shape (formatProposals.recordStructure). The body schema depends on `schema`.
import { z } from 'zod';
import { ProvenanceTypeSchema } from '../generated/vocabulary.ts';
import { RECORD_KINDS } from '../generated/protocol.ts';
import { IsoTime, RecordId, SchemaId, Sha256 } from './common.ts';

export const RecordKindSchema = z.enum(RECORD_KINDS);

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
