import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemClock } from "@infosec/platform";
import { ControlPlane, type SubmitSpec } from "../src/control-plane.js";
import { ProcessWorkerSupervisor } from "../src/process-supervisor.js";

const supervisors: ProcessWorkerSupervisor[] = [];
const dirs: string[] = [];

function spec(resourceId: string, key: string): SubmitSpec {
  return {
    tenantId: "t1",
    scopeId: "scope-a",
    principalId: "user-1",
    name: "append-effect",
    resourceId,
    idempotencyKey: key,
    requestHash: `hash-${key}`,
  };
}

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "infosec-exec-"));
  dirs.push(dir);
  return dir;
}

function effectLines(dir: string): string[] {
  const file = join(dir, "effects.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean);
}

async function waitFor(predicate: () => boolean, what: string, ms = 30_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function started(
  cp: ControlPlane,
  workerId: string,
): Promise<ProcessWorkerSupervisor> {
  const sup = new ProcessWorkerSupervisor(cp, workerId);
  supervisors.push(sup);
  await sup.start();
  return sup;
}

afterEach(async () => {
  while (supervisors.length) await supervisors.pop()!.shutdown();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("process worker against the control plane", () => {
  it("happy path: exit-point check passes, the effect lands once, the report is trusted", async () => {
    const cp = new ControlPlane(systemClock);
    const dir = workspace();
    const sup = await started(cp, "worker-1");
    const sub = cp.submit(spec("ws-happy", "k-happy"));
    if (!sub.ok) throw new Error("submit failed");
    const opId = sub.value.op.operationId;
    const fencing = sup.acquire("ws-happy");
    expect(cp.assign(opId, "worker-1", fencing).ok).toBe(true);
    const detail = await sup.execute(opId, { kind: "append-effect", dir });
    expect(detail).toContain("appended");
    expect(effectLines(dir)).toEqual([opId]);
    const op = cp.getOperationById(opId);
    expect(op?.status).toBe("succeeded");
    expect(op?.trustedRecord?.source).toBe("worker-report");
  });

  it("R02 / D-T02: worker SIGKILLed after the effect but before its receipt — the operation goes unknown, the resource freezes, and reconcile by observation finds exactly one effect", async () => {
    const cp = new ControlPlane(systemClock);
    const dir = workspace();
    const sup = await started(cp, "worker-doomed");
    const sub = cp.submit(spec("ws-r02", "k-r02"));
    if (!sub.ok) throw new Error("submit failed");
    const opId = sub.value.op.operationId;
    const fencing = sup.acquire("ws-r02");
    cp.assign(opId, "worker-doomed", fencing);

    const executing = sup.execute(opId, {
      kind: "append-effect",
      dir,
      holdReceiptMs: 60_000, // the effect lands; the receipt never arrives
    });
    executing.catch(() => undefined);
    await waitFor(() => effectLines(dir).length === 1, "the effect to land");
    sup.kill("SIGKILL");
    await waitFor(() => cp.getOperationById(opId)?.status === "unknown", "operation to go unknown");

    // D-T02: the resource is not handed out as writable before reconcile.
    const other = new ProcessWorkerSupervisor(cp, "worker-next");
    supervisors.push(other);
    expect(() => other.acquire("ws-r02")).toThrowError(/RESOURCE_BUSY/);
    expect(cp.isResourceWritable("ws-r02")).toBe(false);

    const settled = await cp.reconcile(opId, async () => {
      const lines = effectLines(dir);
      return lines.length === 1
        ? { determined: true, finalStatus: "succeeded", observation: `effects.log holds exactly ${lines.length} line for ${opId}` }
        : { determined: false, observation: `unexpected effect count ${lines.length}` };
    });
    expect(settled.ok).toBe(true);
    // R02 at process level: recovery did not re-execute the effect.
    expect(effectLines(dir)).toEqual([opId]);
    expect(cp.getOperationById(opId)?.status).toBe("succeeded");
    expect(cp.isResourceWritable("ws-r02")).toBe(true);
  });

  it("D-T03: cancel reaches stopped-observed only through the four stages plus observation of the real subprocess", async () => {
    const cp = new ControlPlane(systemClock);
    const dir = workspace();
    const sup = await started(cp, "worker-cancel");
    const sub = cp.submit(spec("ws-cancel", "k-cancel"));
    if (!sub.ok) throw new Error("submit failed");
    const opId = sub.value.op.operationId;
    const fencing = sup.acquire("ws-cancel");
    cp.assign(opId, "worker-cancel", fencing);
    await sup.execute(opId, { kind: "sleep", dir, sleepMs: 120_000 });
    const pidfile = join(dir, `${opId}.pid`);
    await waitFor(() => existsSync(pidfile), "the sleeper pidfile");
    const pid = Number(readFileSync(pidfile, "utf8"));
    expect(pidAlive(pid)).toBe(true);
    expect(cp.getOperationById(opId)?.status).toBe("running");
    const cancel = cp.requestCancel(opId);
    expect(cancel.ok).toBe(true);
    expect(cp.getOperationById(opId)?.cancelStage).toBe(1);
    const report = await sup.stop(opId);
    expect(report.exited).toBe(true);
    expect(cp.getOperationById(opId)?.cancelStage).toBe(3);
    const observed = await cp.observeStop(opId, async () => ({
      stopped: !pidAlive(pid),
      detail: `pid ${pid} liveness checked via signal 0`,
    }));
    expect(observed.ok).toBe(true);
    expect(cp.getOperationById(opId)?.status).toBe("stopped-observed");
    expect(cp.getOperationById(opId)?.cancelStage).toBe(4);
    expect(pidAlive(pid)).toBe(false);
  });

  it("D-T03: when the worker is killed mid-cancel, the operation is stop-unconfirmed — never reported stopped while the subprocess still runs", async () => {
    const cp = new ControlPlane(systemClock);
    const dir = workspace();
    const sup = await started(cp, "worker-killed-mid-cancel");
    const sub = cp.submit(spec("ws-unconf", "k-unconf"));
    if (!sub.ok) throw new Error("submit failed");
    const opId = sub.value.op.operationId;
    const fencing = sup.acquire("ws-unconf");
    cp.assign(opId, "worker-killed-mid-cancel", fencing);
    await sup.execute(opId, { kind: "sleep", dir, sleepMs: 120_000 });
    const pidfile = join(dir, `${opId}.pid`);
    await waitFor(() => existsSync(pidfile), "the sleeper pidfile");
    const pid = Number(readFileSync(pidfile, "utf8"));

    expect(cp.requestCancel(opId).ok).toBe(true);
    sup.kill("SIGKILL"); // the worker dies before it can stop the sleeper
    await waitFor(
      () => cp.getOperationById(opId)?.status === "stop-unconfirmed",
      "operation to become stop-unconfirmed",
    );
    // Observation is the only path forward, and it tells the truth:
    // the subprocess is still alive, so no stopped state is granted.
    const observed = await cp.observeStop(opId, async () => ({
      stopped: !pidAlive(pid),
      detail: `pid ${pid} still running after worker death`,
    }));
    expect(observed.ok).toBe(true);
    expect(cp.getOperationById(opId)?.status).toBe("stop-unconfirmed");

    // Cleanup of the orphaned sleeper, then observation can settle it.
    process.kill(pid, "SIGKILL");
    await waitFor(() => !pidAlive(pid), "the orphaned sleeper to die");
    const settled = await cp.observeStop(opId, async () => ({
      stopped: !pidAlive(pid),
      detail: `pid ${pid} confirmed gone`,
    }));
    expect(settled.ok).toBe(true);
    expect(cp.getOperationById(opId)?.status).toBe("stopped-observed");
  });
});
