import type { Pool, PoolClient } from "pg";
import { TASK_TRANSITIONS, type TaskPhase } from "@infosec/contracts";
import { fail, ok, type Result } from "@infosec/platform";
import { SCHEMA_SQL } from "./schema.js";

export interface TaskRow {
  taskId: string;
  tenantId: string;
  scopeId: string;
  principalId: string;
  title: string;
  phase: string;
  inputRevisionId: string;
  revision: number;
}

interface Ctx {
  tenantId: string;
  scopeId: string;
}

const SIGNOFF_ROLES = new Set(["approver", "reviewer"]);

/**
 * The durable C task core (P3-1). Every mutating call runs in a
 * PostgreSQL transaction; a task counts as accepted only after its
 * task row, idempotency record and outbox event have committed
 * together (ADR 0017). Writes are bound to
 * (tenantId, scopeId, taskId, expectedRevision).
 */
export class DurableTaskService {
  #pool: Pool;
  #ids: { next(prefix: string): string };

  constructor(pool: Pool, ids: { next(prefix: string): string }) {
    this.#pool = pool;
    this.#ids = ids;
  }

  async migrate(): Promise<void> {
    await this.#pool.query(SCHEMA_SQL);
  }

  async #tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const value = await fn(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async #outbox(client: PoolClient, taskId: string, kind: string, payload: unknown): Promise<void> {
    await client.query(
      "INSERT INTO outbox (event_id, task_id, kind, payload) VALUES ($1, $2, $3, $4)",
      [this.#ids.next("evt"), taskId, kind, JSON.stringify(payload)],
    );
  }

  async acceptTask(input: {
    tenantId: string;
    scopeId: string;
    principalId: string;
    title: string;
    idempotencyKey: string;
    requestHash: string;
  }): Promise<Result<TaskRow & { deduplicated: boolean }>> {
    return this.#tx(async (client) => {
      const taskId = this.#ids.next("tsk");
      const inserted = await client.query(
        `INSERT INTO idempotency (principal_id, op_name, idem_key, request_hash, task_id)
         VALUES ($1, 'task.accept', $2, $3, $4)
         ON CONFLICT (principal_id, op_name, idem_key) DO NOTHING
         RETURNING task_id`,
        [input.principalId, input.idempotencyKey, input.requestHash, taskId],
      );
      if (inserted.rowCount === 0) {
        const existing = await client.query(
          "SELECT request_hash, task_id FROM idempotency WHERE principal_id = $1 AND op_name = 'task.accept' AND idem_key = $2",
          [input.principalId, input.idempotencyKey],
        );
        const row = existing.rows[0] as { request_hash: string; task_id: string };
        if (row.request_hash !== input.requestHash) {
          return fail(
            "IDEMPOTENCY_MISMATCH",
            "idempotency key was already used with a different request",
          );
        }
        const task = await this.#taskById(client, row.task_id);
        return ok({ ...(task as TaskRow), deduplicated: true });
      }
      const inputRevisionId = this.#ids.next("rev");
      await client.query(
        `INSERT INTO tasks (task_id, tenant_id, scope_id, principal_id, title, phase, input_revision_id)
         VALUES ($1, $2, $3, $4, $5, 'admitted', $6)`,
        [taskId, input.tenantId, input.scopeId, input.principalId, input.title, inputRevisionId],
      );
      await this.#outbox(client, taskId, "task.accepted", { taskId });
      const task = await this.#taskById(client, taskId);
      return ok({ ...(task as TaskRow), deduplicated: false });
    });
  }

  async #taskById(client: PoolClient | Pool, taskId: string): Promise<TaskRow | undefined> {
    const res = await client.query(
      `SELECT task_id, tenant_id, scope_id, principal_id, title, phase, input_revision_id, revision
       FROM tasks WHERE task_id = $1`,
      [taskId],
    );
    const row = res.rows[0] as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      taskId: row.task_id as string,
      tenantId: row.tenant_id as string,
      scopeId: row.scope_id as string,
      principalId: row.principal_id as string,
      title: row.title as string,
      phase: row.phase as string,
      inputRevisionId: row.input_revision_id as string,
      revision: row.revision as number,
    };
  }

  async getTask(ctx: Ctx, taskId: string): Promise<Result<TaskRow>> {
    const task = await this.#taskById(this.#pool, taskId);
    if (!task) return fail("TARGET_NOT_FOUND", `task ${taskId} not found`);
    if (task.tenantId !== ctx.tenantId || task.scopeId !== ctx.scopeId) {
      return fail("FORBIDDEN_SCOPE", "task belongs to a different tenant/scope partition");
    }
    return ok(task);
  }

  async transition(
    ctx: Ctx,
    taskId: string,
    to: TaskPhase,
    expectedRevision: number,
  ): Promise<Result<TaskRow>> {
    return this.#tx(async (client) => {
      const task = await this.#taskById(client, taskId);
      if (!task) return fail("TARGET_NOT_FOUND", `task ${taskId} not found`);
      if (task.tenantId !== ctx.tenantId || task.scopeId !== ctx.scopeId) {
        return fail("FORBIDDEN_SCOPE", "task belongs to a different tenant/scope partition");
      }
      const allowed = TASK_TRANSITIONS[task.phase as TaskPhase] ?? [];
      if (!allowed.includes(to)) {
        return fail("INVARIANT_VIOLATION", `phase transition ${task.phase} -> ${to} is not allowed`);
      }
      const updated = await client.query(
        `UPDATE tasks SET phase = $1, revision = revision + 1, updated_at = now()
         WHERE task_id = $2 AND revision = $3 RETURNING task_id`,
        [to, taskId, expectedRevision],
      );
      if (updated.rowCount === 0) {
        return fail(
          "DECISION_CONFLICT",
          `revision conflict: expected ${expectedRevision}, the task has moved on`,
        );
      }
      await this.#outbox(client, taskId, "task.transitioned", { to });
      const next = await this.#taskById(client, taskId);
      return ok(next as TaskRow);
    });
  }

  /** Replace the task's input: new revision id, checklist voided. */
  async reviseInput(ctx: Ctx, taskId: string, expectedRevision: number): Promise<Result<TaskRow>> {
    return this.#tx(async (client) => {
      const task = await this.#taskById(client, taskId);
      if (!task) return fail("TARGET_NOT_FOUND", `task ${taskId} not found`);
      if (task.tenantId !== ctx.tenantId || task.scopeId !== ctx.scopeId) {
        return fail("FORBIDDEN_SCOPE", "task belongs to a different tenant/scope partition");
      }
      const newRevisionId = this.#ids.next("rev");
      const updated = await client.query(
        `UPDATE tasks SET input_revision_id = $1, checklist_input_revision_id = NULL,
                revision = revision + 1, updated_at = now()
         WHERE task_id = $2 AND revision = $3 RETURNING task_id`,
        [newRevisionId, taskId, expectedRevision],
      );
      if (updated.rowCount === 0) {
        return fail("DECISION_CONFLICT", "revision conflict on input revision");
      }
      await client.query("DELETE FROM checklist_items WHERE task_id = $1", [taskId]);
      await this.#outbox(client, taskId, "task.input-revised", { inputRevisionId: newRevisionId });
      const next = await this.#taskById(client, taskId);
      return ok(next as TaskRow);
    });
  }

  async addScopeMember(ctx: Ctx, actorId: string, role: string): Promise<void> {
    await this.#pool.query(
      `INSERT INTO scope_members (tenant_id, scope_id, actor_id, role) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, scope_id, actor_id) DO UPDATE SET role = EXCLUDED.role`,
      [ctx.tenantId, ctx.scopeId, actorId, role],
    );
  }

  async requestInput(
    ctx: Ctx,
    taskId: string,
    input: { decisionType: string; sensitiveChannel?: boolean; ttlMs: number },
    nowMs: number,
  ): Promise<Result<{ requestId: string }>> {
    const task = await this.getTask(ctx, taskId);
    if (!task.ok) return task;
    const requestId = this.#ids.next("pin");
    await this.#pool.query(
      `INSERT INTO pending_inputs (request_id, task_id, decision_type, sensitive, input_revision_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        requestId,
        taskId,
        input.decisionType,
        input.sensitiveChannel ?? false,
        task.value.inputRevisionId,
        new Date(nowMs + input.ttlMs),
      ],
    );
    const moved = await this.transition(ctx, taskId, "waiting-input", task.value.revision);
    if (!moved.ok) return moved;
    return ok({ requestId });
  }

  async respond(
    ctx: Ctx,
    taskId: string,
    response: {
      requestId: string;
      inputRevisionId: string;
      actorId: string;
      role: string;
    },
    nowMs: number,
  ): Promise<Result<{ outcome: "accepted" | "stale-revision" | "expired" }>> {
    return this.#tx(async (client) => {
      const task = await this.#taskById(client, taskId);
      if (!task) return fail("TARGET_NOT_FOUND", `task ${taskId} not found`);
      if (task.tenantId !== ctx.tenantId || task.scopeId !== ctx.scopeId) {
        return fail("FORBIDDEN_SCOPE", "task belongs to a different tenant/scope partition");
      }
      const pendingRes = await client.query(
        "SELECT expires_at, status FROM pending_inputs WHERE request_id = $1 AND task_id = $2",
        [response.requestId, taskId],
      );
      const pending = pendingRes.rows[0] as { expires_at: Date; status: string } | undefined;
      if (!pending || pending.status !== "open") {
        return fail("INVARIANT_VIOLATION", "no open pending input for this request");
      }
      let outcome: "accepted" | "stale-revision" | "expired";
      if (response.inputRevisionId !== task.inputRevisionId) {
        outcome = "stale-revision";
      } else if (nowMs > new Date(pending.expires_at).getTime()) {
        outcome = "expired";
        await client.query(
          "UPDATE pending_inputs SET status = 'expired' WHERE request_id = $1",
          [response.requestId],
        );
      } else {
        outcome = "accepted";
        await client.query(
          "UPDATE pending_inputs SET status = 'answered' WHERE request_id = $1",
          [response.requestId],
        );
      }
      // Every response — including rejections — is persisted (C-T02).
      await client.query(
        "INSERT INTO decisions (request_id, task_id, actor_id, role, outcome) VALUES ($1, $2, $3, $4, $5)",
        [response.requestId, taskId, response.actorId, response.role, outcome],
      );
      if (outcome === "accepted") {
        await client.query(
          `UPDATE tasks SET phase = 'running', revision = revision + 1, updated_at = now()
           WHERE task_id = $1`,
          [taskId],
        );
      }
      return ok({ outcome });
    });
  }

  async registerVerification(
    taskId: string,
    refId: string,
    kind: string,
    note: string,
  ): Promise<void> {
    await this.#pool.query(
      `INSERT INTO verifications (ref_id, task_id, kind, note) VALUES ($1, $2, $3, $4)
       ON CONFLICT (task_id, ref_id) DO NOTHING`,
      [refId, taskId, kind, note],
    );
  }

  async attachChecklist(
    ctx: Ctx,
    taskId: string,
    items: { itemId: string; kind: string; required: boolean }[],
  ): Promise<Result<{ itemCount: number }>> {
    const task = await this.getTask(ctx, taskId);
    if (!task.ok) return task;
    return this.#tx(async (client) => {
      await client.query("DELETE FROM checklist_items WHERE task_id = $1", [taskId]);
      for (const item of items) {
        await client.query(
          "INSERT INTO checklist_items (task_id, item_id, kind, required) VALUES ($1, $2, $3, $4)",
          [taskId, item.itemId, item.kind, item.required],
        );
      }
      await client.query(
        "UPDATE tasks SET checklist_input_revision_id = $1 WHERE task_id = $2",
        [task.value.inputRevisionId, taskId],
      );
      return ok({ itemCount: items.length });
    });
  }

  async satisfyItem(
    ctx: Ctx,
    taskId: string,
    itemId: string,
    input: { refId: string; actorId: string },
  ): Promise<Result<{ satisfied: true }>> {
    return this.#tx(async (client) => {
      const task = await this.#taskById(client, taskId);
      if (!task) return fail("TARGET_NOT_FOUND", `task ${taskId} not found`);
      if (task.tenantId !== ctx.tenantId || task.scopeId !== ctx.scopeId) {
        return fail("FORBIDDEN_SCOPE", "task belongs to a different tenant/scope partition");
      }
      const itemRes = await client.query(
        "SELECT kind FROM checklist_items WHERE task_id = $1 AND item_id = $2",
        [taskId, itemId],
      );
      const item = itemRes.rows[0] as { kind: string } | undefined;
      if (!item) return fail("TARGET_NOT_FOUND", `checklist item ${itemId} not found`);
      if (item.kind === "human-decision") {
        // Sign-off authority comes from scope membership, never from a
        // self-declared role (ADR 0012). (Interim error mapping:
        // FORBIDDEN_SCOPE covers partition-level authorization.)
        const member = await client.query(
          "SELECT role FROM scope_members WHERE tenant_id = $1 AND scope_id = $2 AND actor_id = $3",
          [ctx.tenantId, ctx.scopeId, input.actorId],
        );
        const role = (member.rows[0] as { role: string } | undefined)?.role;
        if (!role || !SIGNOFF_ROLES.has(role)) {
          return fail(
            "FORBIDDEN_SCOPE",
            `actor ${input.actorId} holds no sign-off role (approver/reviewer) in this scope`,
          );
        }
      } else {
        const verification = await client.query(
          "SELECT ref_id FROM verifications WHERE task_id = $1 AND ref_id = $2",
          [taskId, input.refId],
        );
        if (verification.rowCount === 0) {
          return fail(
            "EVIDENCE_INSUFFICIENT",
            `no registered verification backs ref ${input.refId}; 'satisfied' cannot be asserted freely`,
          );
        }
      }
      await client.query(
        "UPDATE checklist_items SET satisfied = true, ref_id = $1 WHERE task_id = $2 AND item_id = $3",
        [input.refId, taskId, itemId],
      );
      return ok({ satisfied: true as const });
    });
  }

  /** The C-T01 delivery gate: every bypass path is rejected. */
  async deliver(ctx: Ctx, taskId: string, expectedRevision: number): Promise<Result<TaskRow>> {
    return this.#tx(async (client) => {
      const task = await this.#taskById(client, taskId);
      if (!task) return fail("TARGET_NOT_FOUND", `task ${taskId} not found`);
      if (task.tenantId !== ctx.tenantId || task.scopeId !== ctx.scopeId) {
        return fail("FORBIDDEN_SCOPE", "task belongs to a different tenant/scope partition");
      }
      if (task.phase !== "under-review") {
        return fail("INVARIANT_VIOLATION", `delivery requires phase under-review, got ${task.phase}`);
      }
      const bound = await client.query(
        "SELECT checklist_input_revision_id FROM tasks WHERE task_id = $1",
        [taskId],
      );
      const boundRevision = (bound.rows[0] as { checklist_input_revision_id: string | null })
        .checklist_input_revision_id;
      if (!boundRevision || boundRevision !== task.inputRevisionId) {
        return fail(
          "INPUT_REVISION_STALE",
          "no checklist bound to the current input revision (missing or voided)",
        );
      }
      const itemsRes = await client.query(
        "SELECT item_id, kind, required, satisfied, ref_id FROM checklist_items WHERE task_id = $1",
        [taskId],
      );
      const items = itemsRes.rows as {
        item_id: string;
        kind: string;
        required: boolean;
        satisfied: boolean;
        ref_id: string | null;
      }[];
      if (items.length === 0) {
        return fail("INVARIANT_VIOLATION", "an empty checklist cannot authorize delivery");
      }
      for (const item of items) {
        if (!item.required) continue;
        if (!item.satisfied || !item.ref_id) {
          return fail(
            "EVIDENCE_INSUFFICIENT",
            `required checklist item ${item.item_id} is not satisfied with a backing reference`,
          );
        }
        if (item.kind !== "human-decision") {
          const verification = await client.query(
            "SELECT ref_id FROM verifications WHERE task_id = $1 AND ref_id = $2",
            [taskId, item.ref_id],
          );
          if (verification.rowCount === 0) {
            return fail(
              "EVIDENCE_INSUFFICIENT",
              `checklist item ${item.item_id} cites an unregistered reference ${item.ref_id}`,
            );
          }
        }
      }
      const updated = await client.query(
        `UPDATE tasks SET phase = 'delivered', revision = revision + 1, updated_at = now()
         WHERE task_id = $1 AND revision = $2 RETURNING task_id`,
        [taskId, expectedRevision],
      );
      if (updated.rowCount === 0) {
        return fail("DECISION_CONFLICT", "revision conflict at delivery time");
      }
      await this.#outbox(client, taskId, "task.delivered", { taskId });
      const next = await this.#taskById(client, taskId);
      return ok(next as TaskRow);
    });
  }

  /** Publish pending outbox events once per batch; handler dedupes by event id. */
  async publishOutbox(
    limit: number,
    handler: (event: { eventId: string; taskId: string; kind: string }) => Promise<void>,
  ): Promise<number> {
    return this.#tx(async (client) => {
      const res = await client.query(
        `SELECT event_id, task_id, kind FROM outbox
         WHERE published_at IS NULL ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      let published = 0;
      for (const row of res.rows as { event_id: string; task_id: string; kind: string }[]) {
        await handler({ eventId: row.event_id, taskId: row.task_id, kind: row.kind });
        await client.query("UPDATE outbox SET published_at = now() WHERE event_id = $1", [
          row.event_id,
        ]);
        published += 1;
      }
      return published;
    });
  }
}
