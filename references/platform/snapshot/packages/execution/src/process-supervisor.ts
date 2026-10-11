import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ControlPlane } from "./control-plane.js";

interface PendingExecute {
  resolve: (detail: string) => void;
  reject: (error: Error) => void;
}

/**
 * Supervises one process-worker child on behalf of the control
 * plane: relays the worker's exit-point re-checks into
 * ControlPlane.authorizeEffect, turns effect-done messages into
 * fencing-valid worker reports, and reports worker death so running
 * operations go unknown (never silently final).
 */
export class ProcessWorkerSupervisor {
  #cp: ControlPlane;
  readonly workerId: string;
  #child: ChildProcess | undefined;
  #fencing = new Map<string, number>(); // resourceId -> token
  #pending = new Map<string, PendingExecute>();
  #stopWaiters = new Map<string, (report: { childPid: number | null; exited: boolean }) => void>();
  #exitHandlers: (() => void)[] = [];
  #readyResolve: (() => void) | undefined;

  constructor(cp: ControlPlane, workerId: string) {
    this.#cp = cp;
    this.workerId = workerId;
  }

  async start(): Promise<void> {
    const script = fileURLToPath(new URL("../scripts/process-worker.mjs", import.meta.url));
    this.#child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
    const rl = createInterface({ input: this.#child.stdout! });
    rl.on("line", (line) => this.#onLine(line));
    this.#child.on("exit", () => {
      this.#cp.onWorkerExit(this.workerId);
      for (const pending of this.#pending.values()) {
        pending.reject(new Error("worker exited before reporting"));
      }
      this.#pending.clear();
      for (const handler of this.#exitHandlers) handler();
    });
    // A single readline owns the stream: a second interface on the
    // same stdout starves the first (observed: ready arrives, later
    // protocol lines never do).
    await new Promise<void>((resolve) => {
      this.#readyResolve = resolve;
    });
  }

  #send(msg: unknown): void {
    this.#child?.stdin?.write(`${JSON.stringify(msg)}\n`);
  }

  #onLine(line: string): void {
    let msg: {
      type: string;
      opId: string;
      detail?: string;
      childPid?: number | null;
      exited?: boolean;
      pid?: number;
    };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return;
    }
    if (msg.type === "ready") {
      this.#readyResolve?.();
      this.#readyResolve = undefined;
    } else if (msg.type === "authorize-request") {
      // The resource is derivable from the operation record.
      const op = this.#cp.getOperationById(msg.opId);
      const fencing = op ? this.#fencing.get(op.resourceId) : undefined;
      const allowed =
        op !== undefined &&
        fencing !== undefined &&
        this.#cp.authorizeEffect(msg.opId, this.workerId, fencing).ok;
      this.#send({ type: "authorize-response", opId: msg.opId, allowed });
    } else if (msg.type === "effect-done") {
      const pending = this.#pending.get(msg.opId);
      this.#pending.delete(msg.opId);
      pending?.resolve(msg.detail ?? "");
    } else if (msg.type === "child-exited") {
      // A sleep operation's subprocess ended naturally: file the
      // worker's completion report if the operation is still running
      // under this worker's fencing and no cancel is in flight.
      const op = this.#cp.getOperationById(msg.opId);
      if (op && op.status === "running" && (op.cancelStage ?? 0) === 0) {
        const fencing = this.#fencing.get(op.resourceId);
        if (fencing !== undefined) {
          this.#cp.reportEffect(
            msg.opId,
            this.workerId,
            fencing,
            "succeeded",
            `subprocess exited (pid ${msg.pid ?? "?"})`,
          );
        }
      }
    } else if (msg.type === "stop-report") {
      const waiter = this.#stopWaiters.get(msg.opId);
      this.#stopWaiters.delete(msg.opId);
      waiter?.({ childPid: msg.childPid ?? null, exited: msg.exited ?? false });
    }
  }

  /** Acquire (or renew) the lease for a resource and remember the fencing token. */
  acquire(resourceId: string): number {
    const res = this.#cp.acquireLease(resourceId, this.workerId);
    if (!res.ok) throw new Error(`acquire failed: ${res.error.code} ${res.error.message}`);
    this.#fencing.set(resourceId, res.value.fencingToken);
    return res.value.fencingToken;
  }

  fencingFor(resourceId: string): number | undefined {
    return this.#fencing.get(resourceId);
  }

  /**
   * Execute an already-assigned operation in the worker. Resolves
   * with the worker's detail once its report has been filed with the
   * control plane; rejects if the worker dies first.
   */
  async execute(
    operationId: string,
    action: { kind: "append-effect" | "sleep"; dir: string; sleepMs?: number; holdReceiptMs?: number },
  ): Promise<string> {
    const op = this.#cp.getOperationById(operationId);
    if (!op) throw new Error(`unknown operation ${operationId}`);
    const fencing = this.#fencing.get(op.resourceId);
    if (fencing === undefined) throw new Error(`no lease held for ${op.resourceId}`);
    const done = new Promise<string>((resolve, reject) => {
      this.#pending.set(operationId, { resolve, reject });
    });
    this.#send({
      type: "execute",
      opId: operationId,
      action: action.kind,
      dir: action.dir,
      sleepMs: action.sleepMs,
      holdReceiptMs: action.holdReceiptMs,
    });
    const detail = await done;
    if (detail !== "denied-at-exit-point" && action.kind !== "sleep") {
      const report = this.#cp.reportEffect(operationId, this.workerId, fencing, "succeeded", detail);
      if (!report.ok) {
        throw new Error(`report rejected: ${report.error.code} ${report.error.message}`);
      }
    }
    // A sleep operation stays `running`: its subprocess is the
    // continuing effect. It settles via natural exit (child-exited),
    // cancel + observation, or reconcile — never via the start ack.
    return detail;
  }

  /** Ask the worker to stop the operation's subprocess (cancel stages 2-3). */
  async stop(operationId: string): Promise<{ childPid: number | null; exited: boolean }> {
    this.#cp.noteStopSignalled(operationId);
    const reportPromise = new Promise<{ childPid: number | null; exited: boolean }>((resolve) => {
      this.#stopWaiters.set(operationId, resolve);
    });
    this.#send({ type: "stop", opId: operationId });
    const report = await reportPromise;
    this.#cp.noteStopReported(operationId, `worker reports child ${report.childPid} exited=${report.exited}`);
    return report;
  }

  kill(signal: NodeJS.Signals = "SIGKILL"): void {
    this.#child?.kill(signal);
  }

  onExit(handler: () => void): void {
    this.#exitHandlers.push(handler);
  }

  async shutdown(): Promise<void> {
    if (this.#child && this.#child.exitCode === null) {
      this.#child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (this.#child.exitCode === null) this.#child.kill("SIGKILL");
    }
  }
}
