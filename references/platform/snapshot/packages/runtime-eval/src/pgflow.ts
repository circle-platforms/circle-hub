import type { Pool, PoolClient } from "pg";

export const EVAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS eval_effects (
  flow_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (flow_id, stage)
);
CREATE TABLE IF NOT EXISTS eval_attempts (
  flow_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (flow_id, stage)
);
CREATE TABLE IF NOT EXISTS eval_flows (
  flow_id TEXT PRIMARY KEY,
  flow_version INTEGER NOT NULL,
  stage TEXT NOT NULL,
  decision JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS eval_wakeups (
  id BIGSERIAL PRIMARY KEY,
  flow_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload JSONB,
  processed BOOLEAN NOT NULL DEFAULT false,
  noop BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

/** Record an effect exactly once per (flow, stage); returns true if new. */
export async function recordEffect(
  client: Pool | PoolClient,
  flowId: string,
  stage: string,
  opts: { countAttempt?: boolean } = {},
): Promise<boolean> {
  if (opts.countAttempt !== false) {
    await client.query(
      `INSERT INTO eval_attempts (flow_id, stage, attempts) VALUES ($1, $2, 1)
       ON CONFLICT (flow_id, stage) DO UPDATE SET attempts = eval_attempts.attempts + 1`,
      [flowId, stage],
    );
  }
  const res = await client.query(
    `INSERT INTO eval_effects (flow_id, stage) VALUES ($1, $2)
     ON CONFLICT (flow_id, stage) DO NOTHING RETURNING stage`,
    [flowId, stage],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Count one execution attempt in autocommit. Used by routes whose
 * execution engine retries work outside any ledger transaction
 * (Temporal activities): a killed attempt still leaves its count,
 * while the effect insert itself stays exactly-once.
 */
export async function noteAttempt(
  pool: Pool,
  flowId: string,
  stage: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO eval_attempts (flow_id, stage, attempts) VALUES ($1, $2, 1)
     ON CONFLICT (flow_id, stage) DO UPDATE SET attempts = eval_attempts.attempts + 1`,
    [flowId, stage],
  );
}

export async function effectsOf(pool: Pool, flowId: string): Promise<string[]> {
  const res = await pool.query(
    "SELECT stage FROM eval_effects WHERE flow_id = $1 ORDER BY created_at, stage",
    [flowId],
  );
  return res.rows.map((r) => (r as { stage: string }).stage);
}

export async function attemptsOf(
  pool: Pool,
  flowId: string,
  stage: string,
): Promise<number> {
  const res = await pool.query(
    "SELECT attempts FROM eval_attempts WHERE flow_id = $1 AND stage = $2",
    [flowId, stage],
  );
  return (res.rows[0] as { attempts: number } | undefined)?.attempts ?? 0;
}

export type EvalStage = "A" | "WAIT" | "B" | "C" | "DONE";

/**
 * The PostgreSQL task-table route: a staged flow whose every stage
 * transition commits together with its effect, and whose wakeups are
 * durable rows that may arrive duplicated or out of order.
 * Stage order: A -> WAIT(decision) -> B -> (v2 only: C) -> DONE.
 */
export class PgFlowRunner {
  #pool: Pool;
  /** Test hook invoked inside the stage transaction before commit. */
  onInsideTx: ((client: PoolClient, stage: EvalStage) => Promise<void>) | undefined;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async migrate(): Promise<void> {
    await this.#pool.query(EVAL_SCHEMA_SQL);
  }

  async startFlow(flowId: string, flowVersion: number): Promise<void> {
    await this.#pool.query(
      "INSERT INTO eval_flows (flow_id, flow_version, stage) VALUES ($1, $2, 'A') ON CONFLICT DO NOTHING",
      [flowId, flowVersion],
    );
    await this.wakeup(flowId, "tick");
  }

  /** Wakeups are durable and unconditional: duplicates are expected. */
  async wakeup(flowId: string, kind: "tick" | "decision", payload?: unknown): Promise<void> {
    await this.#pool.query(
      "INSERT INTO eval_wakeups (flow_id, kind, payload) VALUES ($1, $2, $3)",
      [flowId, kind, payload === undefined ? null : JSON.stringify(payload)],
    );
  }

  async flowState(flowId: string): Promise<{ stage: EvalStage; flowVersion: number } | undefined> {
    const res = await this.#pool.query(
      "SELECT stage, flow_version FROM eval_flows WHERE flow_id = $1",
      [flowId],
    );
    const row = res.rows[0] as { stage: EvalStage; flow_version: number } | undefined;
    return row ? { stage: row.stage, flowVersion: row.flow_version } : undefined;
  }

  /** Process pending wakeups and actionable stages once. */
  async runOnce(): Promise<void> {
    const flows = await this.#pool.query(
      `SELECT DISTINCT flow_id FROM eval_wakeups WHERE processed = false
       UNION SELECT flow_id FROM eval_flows
       WHERE stage IN ('A', 'B', 'C') OR (stage = 'WAIT' AND decision IS NOT NULL)`,
    );
    for (const row of flows.rows as { flow_id: string }[]) {
      await this.#processFlow(row.flow_id);
    }
  }

  async #processFlow(flowId: string): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const stateRes = await client.query(
        "SELECT stage, flow_version, decision FROM eval_flows WHERE flow_id = $1 FOR UPDATE",
        [flowId],
      );
      const state = stateRes.rows[0] as
        | { stage: EvalStage; flow_version: number; decision: unknown }
        | undefined;
      if (!state) {
        await client.query("ROLLBACK");
        return;
      }
      const wakeups = await client.query(
        "SELECT id, kind, payload FROM eval_wakeups WHERE flow_id = $1 AND processed = false ORDER BY id FOR UPDATE",
        [flowId],
      );
      let decision = state.decision as Record<string, unknown> | null;
      let consumedDecision = false;
      for (const wakeup of wakeups.rows as { id: number; kind: string; payload: unknown }[]) {
        if (wakeup.kind === "decision" && decision === null && state.stage === "WAIT") {
          decision = wakeup.payload as Record<string, unknown>;
          consumedDecision = true;
          await client.query("UPDATE eval_wakeups SET processed = true WHERE id = $1", [
            wakeup.id,
          ]);
        } else if (wakeup.kind === "decision" && decision === null && state.stage !== "WAIT") {
          // Early decision: hold it on the flow so order does not matter.
          decision = wakeup.payload as Record<string, unknown>;
          consumedDecision = true;
          await client.query("UPDATE eval_wakeups SET processed = true WHERE id = $1", [
            wakeup.id,
          ]);
        } else {
          // Duplicate or inapplicable wakeup: a recorded no-op.
          await client.query(
            "UPDATE eval_wakeups SET processed = true, noop = true WHERE id = $1",
            [wakeup.id],
          );
        }
      }
      if (consumedDecision) {
        await client.query("UPDATE eval_flows SET decision = $1 WHERE flow_id = $2", [
          JSON.stringify(decision),
          flowId,
        ]);
      }

      let stage = state.stage;
      // Advance through all immediately-actionable stages in this tx.
      for (;;) {
        if (stage === "A") {
          await recordEffect(client, flowId, "A");
          if (this.onInsideTx) await this.onInsideTx(client, "A");
          stage = "WAIT";
        } else if (stage === "WAIT") {
          if (decision === null) break;
          stage = "B";
        } else if (stage === "B") {
          await recordEffect(client, flowId, "B");
          if (this.onInsideTx) await this.onInsideTx(client, "B");
          stage = state.flow_version >= 2 ? "C" : "DONE";
        } else if (stage === "C") {
          await recordEffect(client, flowId, "C");
          if (this.onInsideTx) await this.onInsideTx(client, "C");
          stage = "DONE";
        } else {
          break;
        }
        if (stage === "WAIT" || stage === "DONE") break;
      }
      await client.query(
        "UPDATE eval_flows SET stage = $1, updated_at = now() WHERE flow_id = $2",
        [stage, flowId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
