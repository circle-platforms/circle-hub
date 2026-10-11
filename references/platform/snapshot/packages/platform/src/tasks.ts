import {
  canTaskTransition,
  evaluateCompletion,
  evaluatePendingResponse,
  PendingInputSchema,
  type CompletionChecklist,
  type DecisionType,
  type PendingInput,
  type PendingInputResponse,
  type PendingResponseOutcome,
  type TaskPhase,
} from "@infosec/contracts";
import { iso, type Clock } from "./clock.js";
import { fail, ok, type Result } from "./result.js";
import type { IdGen } from "./idgen.js";

/**
 * Object C minimum: task lifecycle on the frozen FZ-02 phase machine,
 * structured pending inputs (FZ-09), and the completion gate (VER-03).
 * Delivery is impossible outside under-review and impossible while any
 * required checklist item is unsatisfied.
 */
export interface TaskRecord {
  taskId: string;
  tenantId: string;
  scopeId: string;
  principalId: string;
  title: string;
  phase: TaskPhase;
  runId?: string;
  inputRevisionId: string;
  checklist?: CompletionChecklist;
  pending: PendingInput[];
  createdAt: number;
  updatedAt: number;
}

export class TaskService {
  #clock: Clock;
  #ids: IdGen;
  #tasks = new Map<string, TaskRecord>();

  constructor(clock: Clock, ids: IdGen) {
    this.#clock = clock;
    this.#ids = ids;
  }

  createTask(input: {
    tenantId: string;
    scopeId: string;
    principalId: string;
    title: string;
  }): TaskRecord {
    const now = this.#clock.now();
    const task: TaskRecord = {
      taskId: this.#ids.next("task"),
      tenantId: input.tenantId,
      scopeId: input.scopeId,
      principalId: input.principalId,
      title: input.title,
      phase: "draft",
      inputRevisionId: this.#ids.next("inrev"),
      pending: [],
      createdAt: now,
      updatedAt: now,
    };
    this.#tasks.set(task.taskId, task);
    return task;
  }

  get(taskId: string): TaskRecord | undefined {
    return this.#tasks.get(taskId);
  }

  transition(taskId: string, to: TaskPhase): Result<TaskRecord> {
    const task = this.#tasks.get(taskId);
    if (!task) return fail("TARGET_NOT_FOUND", `task ${taskId} not found`);
    if (!canTaskTransition(task.phase, to)) {
      return fail(
        "INVARIANT_VIOLATION",
        `task phase ${task.phase} -> ${to} is not an allowed transition`,
      );
    }
    task.phase = to;
    task.updatedAt = this.#clock.now();
    if (to === "running" && !task.runId) task.runId = this.#ids.next("run");
    return ok(task);
  }

  /** A new input revision voids any attached checklist (ST-04). */
  bumpInputRevision(taskId: string): Result<TaskRecord> {
    const task = this.#tasks.get(taskId);
    if (!task) return fail("TARGET_NOT_FOUND", `task ${taskId} not found`);
    task.inputRevisionId = this.#ids.next("inrev");
    task.checklist = undefined;
    task.updatedAt = this.#clock.now();
    return ok(task);
  }

  requestInput(
    taskId: string,
    input: {
      decisionType: DecisionType;
      question: string;
      options?: string[];
      sensitiveChannel?: boolean;
      ttlMs?: number;
    },
  ): Result<PendingInput> {
    const task = this.#tasks.get(taskId);
    if (!task) return fail("TARGET_NOT_FOUND", `task ${taskId} not found`);
    if (task.phase !== "running") {
      return fail(
        "INVARIANT_VIOLATION",
        `input can only be requested while running (phase: ${task.phase})`,
      );
    }
    const now = this.#clock.now();
    const pending = PendingInputSchema.parse({
      requestId: this.#ids.next("pin"),
      taskId,
      inputRevisionId: task.inputRevisionId,
      decisionType: input.decisionType,
      question: input.question,
      ...(input.options ? { options: input.options } : {}),
      sensitiveChannel: input.sensitiveChannel ?? false,
      requestedAt: iso(now),
      ...(input.ttlMs ? { expiresAt: iso(now + input.ttlMs) } : {}),
    });
    task.pending.push(pending);
    const moved = this.transition(taskId, "waiting-input");
    if (!moved.ok) return moved;
    return ok(pending);
  }

  /**
   * The outcome is data, not an exception: stale and expired responses are
   * recorded rejections and never advance the task (HUM-02).
   */
  respond(
    taskId: string,
    response: PendingInputResponse,
  ): Result<{ outcome: PendingResponseOutcome }> {
    const task = this.#tasks.get(taskId);
    if (!task) return fail("TARGET_NOT_FOUND", `task ${taskId} not found`);
    const pending = task.pending.find((p) => p.requestId === response.requestId);
    if (!pending) {
      return fail(
        "TARGET_NOT_FOUND",
        `no pending request ${response.requestId} on task ${taskId}`,
      );
    }
    const outcome = evaluatePendingResponse(pending, response);
    if (outcome === "accepted") {
      task.pending = task.pending.filter((p) => p.requestId !== response.requestId);
      if (task.phase === "waiting-input" && task.pending.length === 0) {
        const moved = this.transition(taskId, "running");
        if (!moved.ok) return moved;
      }
    }
    return ok({ outcome });
  }

  attachChecklist(
    taskId: string,
    checklist: CompletionChecklist,
  ): Result<TaskRecord> {
    const task = this.#tasks.get(taskId);
    if (!task) return fail("TARGET_NOT_FOUND", `task ${taskId} not found`);
    if (checklist.taskId !== taskId) {
      return fail("MISSING_BINDING", "checklist is bound to another task");
    }
    if (checklist.inputRevisionId !== task.inputRevisionId) {
      return fail(
        "INPUT_REVISION_STALE",
        "checklist is bound to a superseded input revision",
      );
    }
    task.checklist = checklist;
    task.updatedAt = this.#clock.now();
    return ok(task);
  }

  satisfyItem(taskId: string, itemId: string): Result<TaskRecord> {
    const task = this.#tasks.get(taskId);
    if (!task) return fail("TARGET_NOT_FOUND", `task ${taskId} not found`);
    if (!task.checklist) {
      return fail("MISSING_BINDING", "task has no completion checklist");
    }
    const item = task.checklist.items.find((i) => i.itemId === itemId);
    if (!item) return fail("TARGET_NOT_FOUND", `checklist item ${itemId} not found`);
    item.satisfied = true;
    task.updatedAt = this.#clock.now();
    return ok(task);
  }

  /** VER-03 gate: only from under-review, only with all required items met. */
  deliver(taskId: string): Result<TaskRecord> {
    const task = this.#tasks.get(taskId);
    if (!task) return fail("TARGET_NOT_FOUND", `task ${taskId} not found`);
    if (task.phase !== "under-review") {
      return fail(
        "INVARIANT_VIOLATION",
        `delivery requires under-review (phase: ${task.phase})`,
      );
    }
    if (!task.checklist) {
      return fail("MISSING_BINDING", "task has no completion checklist");
    }
    const gate = evaluateCompletion(task.checklist);
    if (!gate.canDeliver) {
      return fail(
        "DECISION_CONFLICT",
        `completion gate blocks delivery; unsatisfied required items: ${gate.missing.join(", ")}`,
      );
    }
    return this.transition(taskId, "delivered");
  }
}
