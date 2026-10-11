import { z } from "zod";
import {
  ActorIdSchema,
  EvidenceIdSchema,
  InputRevisionIdSchema,
  RecordIdSchema,
  Sha256Schema,
  TaskIdSchema,
} from "./ids.js";

/**
 * FZ-08: the two record kinds are stored and judged separately (VER-01).
 * A VerificationRecord is a deterministic program claim inside a declared
 * scope. An AssessmentRecord is a semantic judgement; it never issues
 * facts and can be overridden by a human, with the override kept.
 */

export const VerificationRecordSchema = z.object({
  kind: z.literal("verification"),
  recordId: RecordIdSchema,
  checkId: z.string().min(1),
  programVersion: z.string().min(1),
  inputBindingSha256: Sha256Schema,
  /** What this check actually covered; a check proves nothing outside it. */
  scopeNote: z.string().min(1),
  expected: z.unknown(),
  actual: z.unknown(),
  result: z.enum(["pass", "fail", "not-run"]),
  evidenceRefs: z.array(EvidenceIdSchema).default([]),
  checkedAt: z.string().datetime(),
});
export type VerificationRecord = z.infer<typeof VerificationRecordSchema>;

export const AssessmentConclusionSchema = z.enum([
  "supports",
  "refutes",
  "not-addressed",
  "insufficient-evidence",
  "abstained",
]);
export type AssessmentConclusion = z.infer<typeof AssessmentConclusionSchema>;

export const AssessmentRecordSchema = z.object({
  kind: z.literal("assessment"),
  recordId: RecordIdSchema,
  methodId: z.string().min(1),
  methodVersion: z.string().min(1),
  /** Exact model identity when a model was used; never a bare "latest". */
  modelId: z.string().min(1).optional(),
  inputBindingSha256: Sha256Schema,
  evidenceRefs: z.array(EvidenceIdSchema).default([]),
  conclusion: AssessmentConclusionSchema,
  confidence: z.number().min(0).max(1).optional(),
  unknowns: z.array(z.string()).default([]),
  rationaleSummary: z.string().min(1),
  createdAt: z.string().datetime(),
  humanOverride: z
    .object({
      actorId: ActorIdSchema,
      decision: z.enum(["accept", "reject", "modify"]),
      note: z.string().min(1),
      at: z.string().datetime(),
    })
    .optional(),
});
export type AssessmentRecord = z.infer<typeof AssessmentRecordSchema>;

/**
 * A supports/refutes conclusion with no evidence cited is not a judgement,
 * it is an assertion. Flag it; insufficient-evidence / abstained may
 * legitimately have no supporting evidence.
 */
export function validateAssessment(a: AssessmentRecord): string[] {
  const issues: string[] = [];
  if (
    (a.conclusion === "supports" || a.conclusion === "refutes") &&
    a.evidenceRefs.length === 0
  ) {
    issues.push(
      `conclusion "${a.conclusion}" requires at least one evidence reference`,
    );
  }
  return issues;
}

/* ------------------------------------------------------------------ */
/* Completion checklist skeleton (VER-03)                              */
/* ------------------------------------------------------------------ */

export const CompletionItemKindSchema = z.enum([
  "verification",
  "assessment",
  "human-decision",
  "operation-reconcile",
  "artifact-registered",
]);
export type CompletionItemKind = z.infer<typeof CompletionItemKindSchema>;

export const CompletionChecklistSchema = z.object({
  taskId: TaskIdSchema,
  inputRevisionId: InputRevisionIdSchema,
  items: z.array(
    z.object({
      itemId: z.string().min(1),
      kind: CompletionItemKindSchema,
      refId: z.string().min(1),
      required: z.boolean(),
      satisfied: z.boolean(),
      note: z.string().min(1).optional(),
    }),
  ),
});
export type CompletionChecklist = z.infer<typeof CompletionChecklistSchema>;

/**
 * `delivered` may only be produced when every required item is satisfied
 * (VER-03). Execution success alone never satisfies this by itself.
 */
export function evaluateCompletion(checklist: CompletionChecklist): {
  canDeliver: boolean;
  missing: string[];
} {
  const missing = checklist.items
    .filter((i) => i.required && !i.satisfied)
    .map((i) => i.itemId);
  return { canDeliver: missing.length === 0, missing };
}
