// Temporal worker as a child process, for the real SIGKILL scenario.
// Env: EVAL_TEMPORAL_ADDRESS, EVAL_PG_CONN, EVAL_WORKFLOWS (v1|v2),
//      EVAL_SLOW_ACTIVITY (stage whose activity hangs once).
import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "../dist/temporal/activities.js";

const connection = await NativeConnection.connect({
  address: process.env.EVAL_TEMPORAL_ADDRESS,
});
const workflowsPath = fileURLToPath(
  new URL(
    process.env.EVAL_WORKFLOWS === "v2"
      ? "../dist/temporal/workflows-v2.js"
      : "../dist/temporal/workflows-v1.js",
    import.meta.url,
  ),
);
const worker = await Worker.create({
  connection,
  namespace: "default",
  taskQueue: "eval-queue",
  workflowsPath,
  activities,
});
console.log("WORKER_READY");
await worker.run();
