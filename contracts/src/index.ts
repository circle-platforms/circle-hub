import {ContributionInput} from './contributions.ts';
// Barrel of the Hub contracts. SCHEMA_REGISTRY is every record and pack-file shape that gets a generated JSON Schema.
import type { z } from 'zod';
import * as packSchemas from './pack.ts';
import * as productSchemas from './product.ts';
import * as knowledgeSchemas from './knowledge.ts';
import * as feedingSchemas from './feeding.ts';
import * as resourceSchemas from './resources.ts';
import * as tableSchemas from './tables.ts';
import * as viewSchemas from './views.ts';
import * as variableSchemas from './variables.ts';
import { Claim } from './claim.ts';
import { SchemaId } from './common.ts';
import { RecordEnvelope } from './records.ts';
import { RunRecord, RunSummary, PackSummary } from './run.ts';
import { ReceivedSubmission, Submission } from './submission.ts';
import {RequestRecord} from './request.ts';
import { ValidationResult } from './validation.ts';

export * from '../generated/vocabulary.ts';
export * from '../generated/protocol.ts';
export * from './common.ts';
export * from './reference.ts';
export * from './claim.ts';
export * from './validation.ts';
export * from './run.ts';
export * from './submission.ts';
export * from './contributions.ts';
export * from './feeding.ts';
export * from './records.ts';
export * from './variables.ts';
export * from './annotations.ts';
export * from './tools.ts';

/** Merges the registrations of every owner; a malformed or repeated key is an error, never a silent overwrite. */
function registry(parts: Record<string, Record<string, z.ZodType>>): Record<string, z.ZodType> {
  const out: Record<string, z.ZodType> = {};
  const owner: Record<string, string> = {};
  for (const [file, schemas] of Object.entries(parts)) {
    for (const [id, schema] of Object.entries(schemas)) {
      if (!SchemaId.safeParse(id).success) throw new Error(`contracts/src/${file}: schema key ${JSON.stringify(id)} is not name@major`);
      if (id in out) throw new Error(`schema ${id} is registered twice: contracts/src/${owner[id]} and contracts/src/${file}`);
      out[id] = schema;
      owner[id] = file;
    }
  }
  return out;
}

export const SCHEMA_REGISTRY: Record<string, z.ZodType> = registry({
  'index.ts': {
    'contribution-input@1':ContributionInput,
    'claim@1': Claim,
    'record@1': RecordEnvelope,
    'run@1': RunRecord,
    'run-summary@1': RunSummary,
    'pack-summary@1': PackSummary,
    'submission@1': Submission,
    'request@1': RequestRecord,
    'submission-received@1': ReceivedSubmission,
    'validation@1': ValidationResult,
  },
  'pack.ts': packSchemas.schemas,
  'product.ts': productSchemas.schemas,
  'knowledge.ts': knowledgeSchemas.schemas,
  'feeding.ts': feedingSchemas.FEEDING_SCHEMAS,
  'resources.ts': resourceSchemas.schemas,
  'tables.ts': tableSchemas.schemas,
  'views.ts': viewSchemas.schemas,
  'variables.ts': variableSchemas.schemas,
});
