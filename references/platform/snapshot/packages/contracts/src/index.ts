import { zodToJsonSchema } from "zod-to-json-schema";
import { BindingSetSchema } from "./bindings.js";
import { EffectDescriptorSchema } from "./effects.js";
import {
  RequestEnvelopeSchema,
  ResponseEnvelopeSchema,
} from "./envelope.js";
import { PendingInputSchema } from "./pending.js";
import { AssessmentRecordSchema, VerificationRecordSchema } from "./records.js";
import { StructuredErrorSchema } from "./vocab.js";

export * from "./ids.js";
export * from "./vocab.js";
export * from "./bindings.js";
export * from "./effects.js";
export * from "./records.js";
export * from "./pending.js";
export * from "./envelope.js";

/**
 * Freeze identity for this contract set.
 * FZ-01..FZ-09 as accepted in the phase-1 baseline (ADR 0006) and the
 * P1 plan; wire baseline per ADR 0007, mind-map scope per ADR 0008,
 * ResponseStatus amended by ADR 0009 (v1.1: cancelled).
 */
export const CONTRACT_VERSION = "1.2.0";
export const FREEZE_ID = "FZ-2026-10-10-v1.2";

/**
 * JSON Schemas generated from the same Zod source, for wire consumers
 * that do not run TypeScript. Generated, never hand-maintained.
 */
export function contractJsonSchemas(): Record<string, unknown> {
  return {
    BindingSet: zodToJsonSchema(BindingSetSchema, "BindingSet"),
    EffectDescriptor: zodToJsonSchema(EffectDescriptorSchema, "EffectDescriptor"),
    StructuredError: zodToJsonSchema(StructuredErrorSchema, "StructuredError"),
    VerificationRecord: zodToJsonSchema(
      VerificationRecordSchema,
      "VerificationRecord",
    ),
    AssessmentRecord: zodToJsonSchema(AssessmentRecordSchema, "AssessmentRecord"),
    PendingInput: zodToJsonSchema(PendingInputSchema, "PendingInput"),
    RequestEnvelope: zodToJsonSchema(RequestEnvelopeSchema, "RequestEnvelope"),
    ResponseEnvelope: zodToJsonSchema(ResponseEnvelopeSchema, "ResponseEnvelope"),
  };
}
