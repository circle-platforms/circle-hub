import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { attemptsOf, effectsOf, PgFlowRunner } from "../src/pgflow.js";
import { startPg, type PgInstance } from "./pgHarness.js";
import * as activities from "../src/temporal/activities.js";

const TASK_QUEUE = "eval-queue";
const workflowsV1 = fileURLToPath(
  new URL("../dist/temporal/workflows-v1.js", import.meta.url),
);
const workflowsV2 = fileURLToPath(
  new URL("../dist/temporal/workflows-v2.js", import.meta.url),
);

let pg: PgInstance;
let testEnv: TestWorkflowEnvironment;

beforeAll(async () => {
  pg = await startPg("infosec_eval_temporal");
  process.env.EVAL_PG_CONN = pg.connectionString;
  await new PgFlowRunner(pg.pool).migrate();
  testEnv = await TestWorkflowEnvironment.createLocal({
    server: { port: 17_400 + Math.floor(Math.random() * 300) },
  });
});

afterAll(async () => {
  await testEnv?.teardown();
  await pg.stop();
});

interface RunningWorker {
  worker: Worker;
  done: Promise<void>;
}

async function startInProcessWorker(workflowsPath: string): Promise<RunningWorker> {
  const worker = await Worker.create({
    connection: testEnv.nativeConnection,
    namespace: "default",
    taskQueue: TASK_QUEUE,
    workflowsPath,
    activities,
  });
  const done = worker.run();
  done.catch(() => undefined);
  return { worker, done };
}

async function stopWorker(running: RunningWorker): Promise<void> {
  running.worker.shutdown();
  await running.done.catch(() => undefined);
}

async function waitEffects(flowId: string, want: string[]): Promise<void> {
  for (let i = 0; i < 150; i++) {
    const got = await effectsOf(pg.pool, flowId);
    if (JSON.stringify(got) === JSON.stringify(want)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `effects for ${flowId} never became ${JSON.stringify(want)}; last=${JSON.stringify(await effectsOf(pg.pool, flowId))}`,
  );
}

async function startFlow(flowId: string, semanticsVersion = 1): Promise<void> {
  await testEnv.client.workflow.start("evalFlow", {
    taskQueue: TASK_QUEUE,
    workflowId: flowId,
    args: [flowId, semanticsVersion],
  });
}

async function signalDecision(flowId: string): Promise<void> {
  await testEnv.client.workflow.getHandle(flowId).signal("decision", { approve: true });
}

async function flowResult(flowId: string): Promise<string> {
  return (await testEnv.client.workflow.getHandle(flowId).result()) as string;
}

describe("Temporal route: canonical flow", () => {
  it("basic v1 flow with a duplicated decision signal: each effect exactly once", async () => {
    const running = await startInProcessWorker(workflowsV1);
    try {
      await startFlow("flow-t-basic");
      await waitEffects("flow-t-basic", ["A"]);
      await signalDecision("flow-t-basic");
      await signalDecision("flow-t-basic"); // duplicate: handler keeps the first
      expect(await flowResult("flow-t-basic")).toBe("done-v1");
      expect(await effectsOf(pg.pool, "flow-t-basic")).toEqual(["A", "B"]);
      expect(await attemptsOf(pg.pool, "flow-t-basic", "A")).toBe(1);
      expect(await attemptsOf(pg.pool, "flow-t-basic", "B")).toBe(1);
    } finally {
      await stopWorker(running);
    }
  }, 180_000);

  it("worker shutdown and a fresh worker while the flow waits for a human: the flow resumes and completes", async () => {
    const first = await startInProcessWorker(workflowsV1);
    await startFlow("flow-t-wait");
    await waitEffects("flow-t-wait", ["A"]);
    await stopWorker(first); // our process goes away; the server keeps history

    const second = await startInProcessWorker(workflowsV1);
    try {
      await signalDecision("flow-t-wait");
      expect(await flowResult("flow-t-wait")).toBe("done-v1");
      expect(await effectsOf(pg.pool, "flow-t-wait")).toEqual(["A", "B"]);
    } finally {
      await stopWorker(second);
    }
  }, 180_000);

  it("C-T04: worker upgraded v1 -> v2 mid-flight: with the semantics version pinned in the workflow input, the in-flight flow keeps v1 semantics; a new v2 flow gains the marker stage", async () => {
    const v1 = await startInProcessWorker(workflowsV1);
    await startFlow("flow-t-upgrade-old", 1);
    await waitEffects("flow-t-upgrade-old", ["A"]);
    await stopWorker(v1);

    const v2 = await startInProcessWorker(workflowsV2);
    try {
      await signalDecision("flow-t-upgrade-old");
      await flowResult("flow-t-upgrade-old");
      // Executed by v2 code, pinned to v1 semantics by its input.
      expect(await effectsOf(pg.pool, "flow-t-upgrade-old")).toEqual(["A", "B"]);

      await startFlow("flow-t-upgrade-new", 2);
      await waitEffects("flow-t-upgrade-new", ["A"]);
      await signalDecision("flow-t-upgrade-new");
      expect(await flowResult("flow-t-upgrade-new")).toBe("done-v2");
      expect(await effectsOf(pg.pool, "flow-t-upgrade-new")).toEqual(["A", "B", "C"]);
    } finally {
      await stopWorker(v2);
    }
  }, 180_000);
});

describe("Temporal route: worker SIGKILL mid-activity (C-T03a)", () => {
  function spawnWorker(slowStage?: string): ChildProcess {
    return spawn(process.execPath, ["scripts/temporal-worker.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        EVAL_TEMPORAL_ADDRESS: testEnv.address,
        EVAL_PG_CONN: pg.connectionString,
        EVAL_WORKFLOWS: "v1",
        ...(slowStage ? { EVAL_SLOW_ACTIVITY: slowStage } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  function waitForOutput(child: ChildProcess, marker: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${marker}`)), 90_000);
      child.stdout?.on("data", (chunk: Buffer) => {
        process.stdout.write(`[worker] ${chunk.toString()}`);
        if (chunk.toString().includes(marker)) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.stderr?.on("data", (chunk: Buffer) =>
        process.stderr.write(`[worker:err] ${chunk.toString()}`),
      );
    });
  }

  it("worker killed during activity A: the server reassigns, the retry completes, the effect stays exactly once", async () => {
    const child = spawnWorker("A");
    await waitForOutput(child, "WORKER_READY");
    await startFlow("flow-t-kill");
    await waitForOutput(child, "ACTIVITY_IN_FLIGHT_A");
    child.kill("SIGKILL");
    await new Promise((resolve) => child.on("exit", resolve));

    const running = await startInProcessWorker(workflowsV1);
    try {
      await signalDecision("flow-t-kill");
      expect(await flowResult("flow-t-kill")).toBe("done-v1");
      expect(await effectsOf(pg.pool, "flow-t-kill")).toEqual(["A", "B"]);
      // The killed attempt was counted, the retry executed the
      // activity again — at-least-once execution, exactly-once effect.
      expect(await attemptsOf(pg.pool, "flow-t-kill", "A")).toBe(2);
    } finally {
      await stopWorker(running);
    }
  }, 240_000);
});
