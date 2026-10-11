import { describe, expect, it } from "vitest";
import { requiresSensitiveChannel } from "@infosec/contracts";
import {
  attemptLogin,
  disposeStack,
  makeStack,
  runAllScenarios,
  submitMfaFromSimulator,
} from "../src/index.js";

describe("SMP-V03-02 scenarios against the SMP-V03-01 test site", () => {
  it("all four scenarios pass every expectation check", async () => {
    const results = await runAllScenarios();
    expect(results.map((r) => r.id)).toEqual([
      "web-s1-wrong-password",
      "web-s2-lockout",
      "web-s3-mfa-timeout",
      "web-s4-session-residue",
    ]);
    for (const r of results) {
      for (const c of r.checks) {
        expect(c.passed, `${r.id} / ${c.name}`).toBe(true);
      }
    }
  });
});

describe("sensitive channel discipline (HUM-04)", () => {
  it("a full MFA login succeeds and no credential material persists in platform records", async () => {
    const s = await makeStack();
    try {
      const login = await attemptLogin(s, "acct_ok", "test-pwd-correct");
      expect(login.classification).toBe("awaiting-mfa");

      // Both pending inputs are flagged for the sensitive channel.
      const credPending = s.driver.beginMfaRequest(s.taskId);
      expect(credPending.ok).toBe(true);
      if (credPending.ok) {
        expect(requiresSensitiveChannel(credPending.value)).toBe(true);
        // Answer THIS pending with the simulator code.
        const sessionId = s.site.sessionIdForCookie(s.client.cookie);
        const code = sessionId ? s.site.simulatorMfaCode(sessionId) : undefined;
        expect(code).toMatch(/^\d{6}$/);
        const task = s.tasks.get(s.taskId);
        if (!task || !code) throw new Error("missing task/code");
        const result = await s.driver.submitMfa(s.taskId, {
          requestId: credPending.value.requestId,
          inputRevisionId: task.inputRevisionId,
          actorId: "act_000001",
          decision: { code },
          respondedAt: new Date(s.clock.now()).toISOString(),
          idempotencyKey: "mfa-scan-1",
        });
        expect(result.ok && result.value.classification).toBe("logged-in");

        // Scan what the platform retained: the task record and results.
        const retained = JSON.stringify({
          task: s.tasks.get(s.taskId),
          login,
          result: result.ok ? result.value : null,
        });
        expect(retained).not.toContain("test-pwd-correct");
        expect(retained).not.toContain(code);
        expect(s.driver.usedSensitiveChannel).toBe(true);
      }
    } finally {
      await disposeStack(s);
    }
  });

  it("a wrong MFA code is classified mfa-failed and the session survives one mistake", async () => {
    const s = await makeStack();
    try {
      const login = await attemptLogin(s, "acct_ok", "test-pwd-correct");
      expect(login.classification).toBe("awaiting-mfa");
      const pending = s.driver.beginMfaRequest(s.taskId);
      if (!pending.ok) throw new Error("mfa request failed");
      const task = s.tasks.get(s.taskId);
      if (!task) throw new Error("task missing");
      const wrong = await s.driver.submitMfa(s.taskId, {
        requestId: pending.value.requestId,
        inputRevisionId: task.inputRevisionId,
        actorId: "act_000001",
        decision: { code: "000000" },
        respondedAt: new Date(s.clock.now()).toISOString(),
        idempotencyKey: "mfa-wrong-1",
      });
      expect(wrong.ok && wrong.value.classification).toBe("mfa-failed");
      expect(wrong.ok && wrong.value.mfaAttempts).toBe(1);
      const recovered = await submitMfaFromSimulator(s);
      expect(recovered.classification).toBe("logged-in");
    } finally {
      await disposeStack(s);
    }
  });
});
