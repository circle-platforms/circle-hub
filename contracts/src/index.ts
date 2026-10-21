// Barrel of the Hub contracts. SCHEMA_REGISTRY is every record and pack-file shape that gets a generated JSON Schema.
import type { z } from 'zod';
import * as packSchemas from './pack.ts';
import * as knowledgeSchemas from './knowledge.ts';
import * as resourceSchemas from './resources.ts';
import * as tableSchemas from './tables.ts';
import { Claim } from './claim.ts';
import { RecordEnvelope } from './records.ts';
import { RunSummary, PackSummary } from './run.ts';
import { Submission } from './submission.ts';
import { ValidationResult } from './validation.ts';

export * from '../generated/vocabulary.ts';
export * from '../generated/protocol.ts';
export * from './common.ts';
export * from './reference.ts';
export * from './claim.ts';
export * from './validation.ts';
export * from './run.ts';
export * from './submission.ts';
export * from './records.ts';
export * from './annotations.ts';
export * from './tools.ts';

export const SCHEMA_REGISTRY: Record<string, z.ZodType> = {
  'claim@1': Claim,
  'record@1': RecordEnvelope,
  'run-summary@1': RunSummary,
  'pack-summary@1': PackSummary,
  'submission@1': Submission,
  'validation@1': ValidationResult,
  ...packSchemas.schemas,
  ...knowledgeSchemas.schemas,
  ...resourceSchemas.schemas,
  ...tableSchemas.schemas,
};
