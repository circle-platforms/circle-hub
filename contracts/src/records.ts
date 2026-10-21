// Record envelope: the append-only record table's row shape (formatProposals.recordStructure). The body schema depends on kind@version.
import { z } from 'zod';
import { ProvenanceTypeSchema } from '../generated/vocabulary.ts';
import { RECORD_KINDS } from '../generated/protocol.ts';
import { IsoTime, Sha256 } from './common.ts';

export const RecordKindSchema = z.enum(RECORD_KINDS);

export const RecordEnvelope = z.object({
  id: z.string().regex(/^rcd_[0-9a-z]{26}$/),
  kind: RecordKindSchema,
  schema: z.string().regex(/^[a-z_]+@[0-9]+$/),
  digest: Sha256.describe('SHA-256 of the RFC 8785 canonical JSON of {kind, schema, provenance, created_at, body}'),
  provenance: ProvenanceTypeSchema,
  created_at: IsoTime,
  body: z.unknown(),
});
export type RecordEnvelope = z.infer<typeof RecordEnvelope>;
