import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Budget discipline for the P3-5 evaluation (frozen plan
 * docs/p3-5-evaluation-plan.md §4): hard caps of 120 calls and
 * 1,500,000 total tokens for the whole round. The tracker refuses a
 * new call once either cap is reached; usage is charged from the
 * provider's own metering in each response.
 */
export class BudgetExceeded extends Error {}

export interface CallAttempt {
  latencyMs: number;
  outcome: "ok" | "http-error" | "network-error";
  httpStatus?: number;
}

export interface CallLogEntry {
  purpose: string;
  attempts: CallAttempt[];
  inputTokens?: number;
  outputTokens?: number;
}

export class BudgetTracker {
  calls = 0;
  inputTokens = 0;
  outputTokens = 0;
  readonly log: CallLogEntry[] = [];

  constructor(
    readonly maxCalls = 120,
    readonly maxTokens = 1_500_000,
  ) {}

  get totalTokens(): number {
    return this.inputTokens + this.outputTokens;
  }

  assertCallAllowed(purpose: string): void {
    if (this.calls >= this.maxCalls) {
      throw new BudgetExceeded(
        `call cap ${this.maxCalls} reached before ${purpose}`,
      );
    }
    if (this.totalTokens >= this.maxTokens) {
      throw new BudgetExceeded(
        `token cap ${this.maxTokens} reached before ${purpose}`,
      );
    }
  }

  snapshot() {
    return {
      calls: this.calls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.totalTokens,
      maxCalls: this.maxCalls,
      maxTokens: this.maxTokens,
      log: this.log,
    };
  }
}

export class CallFailed extends Error {
  constructor(
    message: string,
    readonly attempts: CallAttempt[],
  ) {
    super(message);
  }
}

/**
 * The bridge is a local command that takes a complete Messages API
 * request JSON via `--request-file <path>` and prints the full
 * response JSON on stdout. It attaches the vault credential through
 * the platform's surrogate mechanism; this package never sees any
 * credential. Exit codes: 0 ok, 3 HTTP error (JSON detail on
 * stderr), 4 network/other failure.
 */
const BRIDGE =
  process.env.LLM_BRIDGE ??
  join(homedir(), "workspace/skills/aliyun-token-plan/bin/messages.py");

const workDir = mkdtempSync(join(tmpdir(), "infosec-llm-bridge-"));
let requestSeq = 0;

export interface MessagesResponse {
  content?: { type: string; text?: string }[];
  model?: string;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  [key: string]: unknown;
}

/**
 * One logical model call. Retry rule (frozen plan §3): only
 * transport/5xx failures retry, at most 2 retries, every attempt
 * logged. Content or parse problems are the caller's business and
 * are never retried here.
 */
export function callMessages(
  budget: BudgetTracker,
  purpose: string,
  request: Record<string, unknown>,
): { response: MessagesResponse; text: string } {
  budget.assertCallAllowed(purpose);
  const entry: CallLogEntry = { purpose, attempts: [] };
  budget.log.push(entry);
  const file = join(workDir, `req-${++requestSeq}.json`);
  writeFileSync(file, JSON.stringify(request), "utf8");

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const started = Date.now();
    try {
      const stdout = execFileSync("python3", [BRIDGE, "--request-file", file], {
        encoding: "utf8",
        timeout: 320_000,
        maxBuffer: 64 * 1024 * 1024,
      });
      const latencyMs = Date.now() - started;
      const response = JSON.parse(stdout) as MessagesResponse;
      const usage = response.usage ?? {};
      entry.attempts.push({ latencyMs, outcome: "ok" });
      entry.inputTokens = usage.input_tokens ?? 0;
      entry.outputTokens = usage.output_tokens ?? 0;
      budget.calls += 1;
      budget.inputTokens += entry.inputTokens;
      budget.outputTokens += entry.outputTokens;
      const text = (response.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      return { response, text };
    } catch (error) {
      const latencyMs = Date.now() - started;
      const status = (error as { status?: number }).status;
      const stderr = String(
        (error as { stderr?: unknown }).stderr ?? "",
      ).slice(0, 300);
      let httpStatus: number | undefined;
      try {
        httpStatus = (
          JSON.parse(stderr) as { status?: number }
        ).status;
      } catch {
        httpStatus = undefined;
      }
      entry.attempts.push({
        latencyMs,
        outcome: status === 3 ? "http-error" : "network-error",
        httpStatus,
      });
      lastError = error;
      const retryable =
        status === 4 ||
        status === undefined ||
        (status === 3 && (httpStatus === undefined || httpStatus >= 500));
      if (!retryable || attempt === 2) break;
    }
  }
  throw new CallFailed(
    `model call failed after ${entry.attempts.length} attempt(s): ${purpose}`,
    entry.attempts,
  );
}

/** Extract the first JSON object from a model text reply, or null. */
export function parseModelJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}
