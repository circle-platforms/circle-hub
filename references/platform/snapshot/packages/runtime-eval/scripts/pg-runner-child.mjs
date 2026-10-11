// PG-route runner as a child process, for the real SIGKILL scenario.
// Env: EVAL_PG_CONN, EVAL_SLOW_STAGE (stage whose transaction sleeps).
import { Pool } from "pg";
import { PgFlowRunner } from "../dist/pgflow.js";

const pool = new Pool({ connectionString: process.env.EVAL_PG_CONN });
const runner = new PgFlowRunner(pool);
await runner.migrate();
if (process.env.EVAL_SLOW_STAGE) {
  runner.onInsideTx = async (client, stage) => {
    if (stage === process.env.EVAL_SLOW_STAGE) {
      console.log(`IN_TX_${stage}`);
      await client.query("SELECT pg_sleep(10)");
    }
  };
}
console.log("RUNNER_READY");
for (;;) {
  try {
    await runner.runOnce();
  } catch (error) {
    console.error("runOnce failed", error);
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}
