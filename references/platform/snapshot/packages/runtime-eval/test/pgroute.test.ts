import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { attemptsOf, effectsOf, PgFlowRunner } from "../src/pgflow.js";
import { startPg, type PgInstance } from "./pgHarness.js";

let pg: PgInstance;
let runner: PgFlowRunner;

beforeAll(async () => {
  pg = await startPg("infosec_eval_pg");
  runner = new PgFlowRunner(pg.pool);
  await runner.migrate();
});

afterAll(async () => {
  await pg.stop();
});

async function settle(flowId: string, tries = 25): Promise<void> {
  for (let i = 0; i < tries; i++) {
    await runner.runOnce();
    const state = await runner.flowState(flowId);
    if (state?.stage === "DONE" || state?.stage === "WAIT") {
      // One more pass to be sure nothing else is actionable.
      await runner.runOnce();
      return;
    }
  }
}

describe("PG route: canonical flow", () => {
  it("v1 flow: A -> decision -> B -> DONE, each effect once", async () => {
    await runner.startFlow("flow-pg-basic", 1);
    await settle("flow-pg-basic");
    expect((await runner.flowState("flow-pg-basic"))?.stage).toBe("WAIT");
    expect(await effectsOf(pg.pool, "flow-pg-basic")).toEqual(["A"]);
    await runner.wakeup("flow-pg-basic", "decision", { approve: true });
    await settle("flow-pg-basic");
    expect((await runner.flowState("flow-pg-basic"))?.stage).toBe("DONE");
    expect(await effectsOf(pg.pool, "flow-pg-basic")).toEqual(["A", "B"]);
  });

  it("C-T03b: duplicate and out-of-order wakeups cause no duplicate effects", async () => {
    await runner.startFlow("flow-pg-dup", 1);
    // Decision arrives BEFORE the flow reaches WAIT (out of order),
    // and twice (duplicate); ticks duplicated too.
    await runner.wakeup("flow-pg-dup", "decision", { approve: true });
    await runner.wakeup("flow-pg-dup", "decision", { approve: true });
    await runner.wakeup("flow-pg-dup", "tick");
    await settle("flow-pg-dup");
    expect((await runner.flowState("flow-pg-dup"))?.stage).toBe("DONE");
    expect(await effectsOf(pg.pool, "flow-pg-dup")).toEqual(["A", "B"]);
    const noops = await pg.pool.query(
      "SELECT count(*)::int AS n FROM eval_wakeups WHERE flow_id = 'flow-pg-dup' AND noop = true",
    );
    expect((noops.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(1);
  });

  it("C-T04 (PG route): in-flight v1 flow keeps v1 semantics after the runner's current version moves to v2", async () => {
    await runner.startFlow("flow-pg-v1", 1);
    await settle("flow-pg-v1");
    expect((await runner.flowState("flow-pg-v1"))?.stage).toBe("WAIT");
    // "Upgrade": new flows now start at version 2 (the runner dispatches
    // per-flow by the version pinned on the flow row).
    await runner.startFlow("flow-pg-v2", 2);
    await runner.wakeup("flow-pg-v1", "decision", { approve: true });
    await runner.wakeup("flow-pg-v2", "decision", { approve: true });
    await settle("flow-pg-v1");
    await settle("flow-pg-v2");
    expect(await effectsOf(pg.pool, "flow-pg-v1")).toEqual(["A", "B"]); // no C
    expect(await effectsOf(pg.pool, "flow-pg-v2")).toEqual(["A", "B", "C"]);
  });
});

describe("PG route: real process kill (C-T03a/c)", () => {
  function spawnRunner(slowStage?: string): ChildProcess {
    const child = spawn(process.execPath, ["scripts/pg-runner-child.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        EVAL_PG_CONN: pg.connectionString,
        ...(slowStage ? { EVAL_SLOW_STAGE: slowStage } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return child;
  }

  function waitForOutput(child: ChildProcess, marker: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${marker}`)), 60_000);
      child.stdout?.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes(marker)) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  }

  async function waitStage(flowId: string, stage: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const state = await runner.flowState(flowId);
      if (state?.stage === stage) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`flow ${flowId} never reached ${stage}`);
  }

  it("runner SIGKILLed inside stage A's transaction: no effect, no advance; a fresh runner completes the flow exactly once", async () => {
    await runner.startFlow("flow-pg-kill", 1);
    const child = spawnRunner("A");
    await waitForOutput(child, "IN_TX_A");
    child.kill("SIGKILL");
    await new Promise((resolve) => child.on("exit", resolve));
    // The interrupted transaction must have rolled back.
    expect(await effectsOf(pg.pool, "flow-pg-kill")).toEqual([]);
    expect((await runner.flowState("flow-pg-kill"))?.stage).toBe("A");

    const child2 = spawnRunner();
    await waitForOutput(child2, "RUNNER_READY");
    await waitStage("flow-pg-kill", "WAIT");
    await runner.wakeup("flow-pg-kill", "decision", { approve: true });
    await waitStage("flow-pg-kill", "DONE");
    child2.kill("SIGKILL");
    expect(await effectsOf(pg.pool, "flow-pg-kill")).toEqual(["A", "B"]);
    expect(await attemptsOf(pg.pool, "flow-pg-kill", "A")).toBe(1);
  }, 120_000);

  it("runner killed while the flow waits for a human: state and the later decision survive the restart", async () => {
    await runner.startFlow("flow-pg-wait", 1);
    const child = spawnRunner();
    await waitForOutput(child, "RUNNER_READY");
    await waitStage("flow-pg-wait", "WAIT");
    child.kill("SIGKILL");
    await new Promise((resolve) => child.on("exit", resolve));

    const child2 = spawnRunner();
    await waitForOutput(child2, "RUNNER_READY");
    await runner.wakeup("flow-pg-wait", "decision", { approve: true });
    await waitStage("flow-pg-wait", "DONE");
    child2.kill("SIGKILL");
    expect(await effectsOf(pg.pool, "flow-pg-wait")).toEqual(["A", "B"]);
  }, 120_000);
});
