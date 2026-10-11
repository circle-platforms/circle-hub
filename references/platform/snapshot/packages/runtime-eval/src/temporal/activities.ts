import { Pool } from "pg";
import { noteAttempt, recordEffect } from "../pgflow.js";

let pool: Pool | undefined;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.EVAL_PG_CONN });
  }
  return pool;
}

/**
 * Activities for the Temporal route. The effect itself goes through
 * the same exactly-once ledger as the PG route: Temporal retries
 * activities at least once, so the ledger (not the workflow) is what
 * makes the effect exactly-once. The attempt is noted in autocommit
 * BEFORE the work, so a worker killed mid-activity still leaves its
 * attempt counted — retries become visible, effects do not double.
 */
export async function applyEffect(flowId: string, stage: string): Promise<boolean> {
  const p = getPool();
  await noteAttempt(p, flowId, stage);
  if (process.env.EVAL_SLOW_ACTIVITY === stage) {
    // Announce, then hang long enough for the test to kill the
    // worker mid-activity. A per-process flag file makes "slow"
    // one-shot per worker process: a retry in a fresh process runs
    // fast, and no state leaks between test runs.
    const { existsSync, writeFileSync } = await import("node:fs");
    const flag = `/tmp/eval-slow-used-${flowId}-${stage}-${process.pid}`;
    if (!existsSync(flag)) {
      writeFileSync(flag, "1");
      console.log(`ACTIVITY_IN_FLIGHT_${stage}`);
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
  }
  const client = await p.connect();
  try {
    return await recordEffect(client, flowId, stage, { countAttempt: false });
  } finally {
    client.release();
  }
}
