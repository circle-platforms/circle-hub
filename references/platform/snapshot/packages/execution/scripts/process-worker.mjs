// Process worker: a standalone program supervised by the control
// plane's ProcessWorkerSupervisor over stdio JSON lines.
//
// Protocol:
//   in : {type:"execute", opId, action:"append-effect"|"sleep", dir, sleepMs?, holdReceiptMs?}
//   out: {type:"authorize-request", opId}        (exit-point re-check)
//   in : {type:"authorize-response", opId, allowed}
//   out: {type:"effect-done", opId, detail}      (delayed by holdReceiptMs when set)
//   in : {type:"stop", opId}
//   out: {type:"stop-report", opId, childPid, exited}
//
// The worker NEVER performs an effect before the control plane's
// exit-point re-check allows it (ADR 0020).
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const pendingAuth = new Map();
const children = new Map(); // opId -> {child, pidfile}
const sleeperPath = fileURLToPath(new URL("./sleeper.mjs", import.meta.url));

async function authorize(opId) {
  const promise = new Promise((resolve) => pendingAuth.set(opId, resolve));
  send({ type: "authorize-request", opId });
  return promise;
}

async function execute(msg) {
  const { opId, action, dir, sleepMs, holdReceiptMs } = msg;
  mkdirSync(dir, { recursive: true });
  const allowed = await authorize(opId);
  if (!allowed) {
    send({ type: "effect-done", opId, detail: "denied-at-exit-point" });
    return;
  }
  if (action === "append-effect") {
    appendFileSync(join(dir, "effects.log"), `${opId}\n`);
    if (holdReceiptMs) await new Promise((r) => setTimeout(r, holdReceiptMs));
    send({ type: "effect-done", opId, detail: "appended one line to effects.log" });
    return;
  }
  if (action === "sleep") {
    const pidfile = join(dir, `${opId}.pid`);
    const child = spawn(process.execPath, [sleeperPath, pidfile, String(sleepMs ?? 60000)], {
      stdio: "ignore",
    });
    children.set(opId, { child, pidfile });
    child.on("exit", () => send({ type: "child-exited", opId, pid: child.pid }));
    send({ type: "effect-done", opId, detail: `sleeper started pid=${child.pid}` });
    return;
  }
  send({ type: "effect-done", opId, detail: `unknown action ${action}` });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === "authorize-response") {
    pendingAuth.get(msg.opId)?.(msg.allowed);
    pendingAuth.delete(msg.opId);
  } else if (msg.type === "execute") {
    void execute(msg);
  } else if (msg.type === "stop") {
    const entry = children.get(msg.opId);
    if (!entry) {
      send({ type: "stop-report", opId: msg.opId, childPid: null, exited: false });
      return;
    }
    const { child } = entry;
    if (child.exitCode !== null || child.killed) {
      send({ type: "stop-report", opId: msg.opId, childPid: child.pid, exited: true });
      return;
    }
    child.once("exit", () =>
      send({ type: "stop-report", opId: msg.opId, childPid: child.pid, exited: true }),
    );
    child.kill("SIGTERM");
  }
});

send({ type: "ready" });
