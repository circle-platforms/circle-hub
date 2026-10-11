import type { AssessInput } from "@infosec/assessor";

/**
 * Frozen prompt set for the P3-5 L4 evaluation
 * (docs/p3-5-evaluation-plan.md §1/§3). Any change to these texts is
 * a new prompt set version and a new evaluation round.
 */
export const PROMPT_SET_ID = "p3-5-prompts-v1";
export const MODEL_ID = "qwen3.8-flash";
export const MAX_TOKENS = 4096;
export const TEMPERATURE = 0;

/** V01: judge whether the cited evidence supports the claim. */
export const V01_ASSESS_SYSTEM = [
  "You are a strict evidence assessor inside an evaluation harness.",
  "You judge whether the cited evidence supports a claim.",
  "Rules:",
  "- Use ONLY the evidence quotes provided. Never use outside knowledge.",
  "- If no evidence is provided, or the evidence does not address the claim,",
  '  answer "insufficient-evidence".',
  "- If the evidence itself carries conflicting values for the claimed",
  '  quantity, answer "abstained" and note the conflict in unknowns.',
  '- If the evidence supports the claim\'s value, answer "supports".',
  "- If the evidence states a different value for the same quantity,",
  '  answer "refutes".',
  "- Output exactly one JSON object, no markdown fences, no extra text:",
  '{"conclusion": "supports" | "refutes" | "insufficient-evidence" | "abstained",',
  ' "rationale": "<at most two sentences, citing evidence ids>",',
  ' "unknowns": ["<anything the evidence leaves open>"]}',
].join("\n");

export function buildAssessUser(input: AssessInput): string {
  const lines = [
    `Question: ${input.questionText}`,
    `Claim: ${input.claim}`,
  ];
  if (input.claimValue !== undefined) {
    lines.push(`Claimed value: ${input.claimValue}`);
  }
  lines.push("Evidence:");
  if (input.evidence.length === 0) {
    lines.push("(no evidence was supplied)");
  } else {
    for (const e of input.evidence) {
      lines.push(
        `- [${e.evidenceId}] ${e.quote}` +
          (e.value !== undefined ? ` (extracted value: ${e.value})` : ""),
      );
    }
  }
  return lines.join("\n");
}

/** V04: review one use case against the four frozen dimensions. */
export const V04_REVIEW_SYSTEM = [
  "You are a strict use-case reviewer inside an evaluation harness.",
  "Review the given use case against exactly these four defect dimensions",
  "(type labels are exact and must be copied verbatim):",
  '1. "越权未校验" — the case lets a user view or obtain data or functions',
  "   belonging to another user or otherwise restricted, without any stated",
  "   login, ownership or permission check.",
  '2. "异常分支缺失" — the case involves credentials or state-changing',
  "   actions but defines no exception or failure branch.",
  '3. "凭据明文记录" — the case records credentials (passwords, codes) in',
  "   plaintext in logs or records.",
  '4. "内部矛盾" — the same quantity or condition is stated with two',
  "   different values inside the case.",
  "Severity guide:",
  '- "high": a security boundary can be crossed by an ordinary user.',
  '- "medium": a real defect that weakens safety or correctness but needs',
  "  specific conditions to matter.",
  '- "low": an internal inconsistency or clarity defect.',
  "Rules:",
  "- Report only defects actually present in the text. Several dimensions",
  "  test the ABSENCE of a mention; do not invent content the case does",
  "  not contain, and do not treat an annotation describing an absence as",
  "  the presence of a check.",
  "- A basically correct case yields an empty findings list.",
  "- Output exactly one JSON object, no markdown fences, no extra text:",
  '{"findings": [{"type": "<one of the four labels>",',
  ' "severity": "high" | "medium" | "low",',
  ' "location": "<where in the case>", "rationale": "<one sentence>"}]}',
].join("\n");

export function buildReviewUser(caseId: string, text: string): string {
  return `Use case ${caseId}:\n${text}`;
}

/** V03 visual pilot: classify a login-flow screenshot. */
export const V03_CLASSIFY_TEXT = [
  "This is a screenshot of a login-flow test site. Classify the page state",
  "into exactly one of:",
  '- "blank" — a fresh login form, no error shown;',
  '- "credential-error" — login failed, wrong credentials;',
  '- "locked" — the account is locked;',
  '- "mfa-waiting" — waiting for a multi-factor authentication code.',
  "Output exactly one JSON object, no markdown fences, no extra text:",
  '{"state": "<one label>", "rationale": "<one sentence>"}',
].join("\n");

export const V03_STATES = [
  "blank",
  "credential-error",
  "locked",
  "mfa-waiting",
] as const;
export type V03State = (typeof V03_STATES)[number];
