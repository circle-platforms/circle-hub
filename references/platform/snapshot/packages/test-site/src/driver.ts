import {
  requiresSensitiveChannel,
  type PendingInput,
  type PendingInputResponse,
} from "@infosec/contracts";
import {
  fail,
  ok,
  type OperationService,
  type Result,
  type TaskService,
} from "@infosec/platform";
import type { SiteClient, PageResult } from "./client.js";

export type LoginClassification =
  | "logged-in"
  | "awaiting-mfa"
  | "credential-error"
  | "locked"
  | "mfa-timeout"
  | "mfa-failed"
  | "session-expired"
  | "target-unreachable";

export interface LoginStepResult {
  classification: LoginClassification;
  failCount?: number;
  mfaAttempts?: number;
}

/**
 * The V03 web-login driver. Credentials and MFA codes reach the driver
 * ONLY as decisions on platform pending inputs flagged for the
 * sensitive channel (HUM-04): the driver never accepts them as plain
 * method arguments, never stores them, and its operation records and
 * results carry classifications, not secrets.
 */
export class WebLoginDriver {
  #client: SiteClient;
  #tasks: TaskService;
  #ops: OperationService;
  #ids: { next(prefix: string): string };
  #ctx: { tenantId: string; scopeId: string; principalId: string; runId: string };
  usedSensitiveChannel = false;

  constructor(deps: {
    client: SiteClient;
    tasks: TaskService;
    ops: OperationService;
    ids: { next(prefix: string): string };
    ctx: { tenantId: string; scopeId: string; principalId: string; runId: string };
  }) {
    this.#client = deps.client;
    this.#tasks = deps.tasks;
    this.#ops = deps.ops;
    this.#ids = deps.ids;
    this.#ctx = deps.ctx;
  }

  beginCredentialRequest(taskId: string): Result<PendingInput> {
    const pending = this.#tasks.requestInput(taskId, {
      decisionType: "credential",
      question: "提供本地测试站的账号与口令",
      sensitiveChannel: true,
      ttlMs: 300_000,
    });
    if (pending.ok && requiresSensitiveChannel(pending.value)) {
      this.usedSensitiveChannel = true;
    }
    return pending;
  }

  beginMfaRequest(taskId: string): Result<PendingInput> {
    const pending = this.#tasks.requestInput(taskId, {
      decisionType: "mfa",
      question: "提供站点模拟器给出的 6 位 MFA 码",
      sensitiveChannel: true,
      ttlMs: 60_000,
    });
    if (pending.ok && requiresSensitiveChannel(pending.value)) {
      this.usedSensitiveChannel = true;
    }
    return pending;
  }

  #runOp<T>(name: string, kind: "read" | "effect", fn: () => Promise<T>): Promise<T> {
    const sub = this.#ops.submit({
      ...this.#ctx,
      name,
      kind,
      idempotencyKey: this.#ids.next("idem"),
      request: { name },
    });
    if (!sub.ok) return fn();
    const opId = sub.value.operation.operationId;
    this.#ops.start(opId);
    return fn().then(
      (value) => {
        this.#ops.complete(opId, "succeeded", { classification: "recorded" });
        return value;
      },
      (error: unknown) => {
        this.#ops.complete(opId, "failed");
        throw error;
      },
    );
  }

  #classifyLoginPage(page: PageResult): LoginStepResult {
    if (page.location === "/home" || page.state === "home") {
      return { classification: "logged-in" };
    }
    if (page.location === "/mfa" || page.state === "mfa-waiting") {
      return { classification: "awaiting-mfa" };
    }
    if (page.location === "/locked" || page.state === "locked") {
      return { classification: "locked" };
    }
    if (page.state === "login-error") {
      return { classification: "credential-error", failCount: page.failCount };
    }
    return { classification: "target-unreachable" };
  }

  async submitCredentials(
    taskId: string,
    response: PendingInputResponse,
  ): Promise<Result<LoginStepResult>> {
    const responded = this.#tasks.respond(taskId, response);
    if (!responded.ok) return responded;
    if (responded.value.outcome === "stale-revision") {
      return fail("INPUT_REVISION_STALE", "credential decision was for a superseded revision");
    }
    if (responded.value.outcome === "expired") {
      return fail("DECISION_CONFLICT", "credential request expired before the decision arrived");
    }
    const decision = response.decision as { username: string; password: string };
    try {
      const page = await this.#runOp("web.login.submit", "effect", () =>
        this.#client.post("/login", {
          username: decision.username,
          password: decision.password,
        }),
      );
      return ok(this.#classifyLoginPage(page));
    } catch {
      return ok({ classification: "target-unreachable" });
    }
  }

  async submitMfa(
    taskId: string,
    response: PendingInputResponse,
  ): Promise<Result<LoginStepResult>> {
    const responded = this.#tasks.respond(taskId, response);
    if (!responded.ok) return responded;
    if (responded.value.outcome !== "accepted") {
      return ok({ classification: "mfa-timeout" });
    }
    const decision = response.decision as { code: string };
    try {
      const page = await this.#runOp("web.mfa.submit", "effect", () =>
        this.#client.post("/mfa", { code: decision.code }),
      );
      if (page.location === "/home" || page.state === "home") {
        return ok({ classification: "logged-in" });
      }
      if (
        page.location?.includes("flash=mfa-timeout") ||
        page.state === "login-mfa-timeout"
      ) {
        return ok({ classification: "mfa-timeout" });
      }
      if (page.state === "mfa-error") {
        return ok({ classification: "mfa-failed", mfaAttempts: page.mfaAttempts });
      }
      if (page.location?.includes("flash=mfa-failed") || page.state === "login-error") {
        return ok({ classification: "mfa-failed" });
      }
      return ok({ classification: "target-unreachable" });
    } catch {
      return ok({ classification: "target-unreachable" });
    }
  }

  /** Observe the MFA page without submitting (the timeout observation). */
  async pollMfaPage(): Promise<LoginStepResult> {
    const page = await this.#client.get("/mfa");
    if (
      page.location?.includes("flash=mfa-timeout") ||
      page.state === "login-mfa-timeout"
    ) {
      return { classification: "mfa-timeout" };
    }
    if (page.state === "mfa-waiting") return { classification: "awaiting-mfa" };
    return { classification: "target-unreachable" };
  }

  async openHome(): Promise<LoginStepResult> {
    const page = await this.#client.get("/home");
    if (page.state === "home") return { classification: "logged-in" };
    if (page.location === "/login") return { classification: "session-expired" };
    return { classification: "target-unreachable" };
  }

  async logout(): Promise<void> {
    await this.#runOp("web.logout", "effect", () => this.#client.post("/logout"));
  }
}
