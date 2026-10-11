// R06 takeover sequence (L3): Circle submits a long task, its
// process exits; Pi (a different actor) takes the task over and
// answers the pending input; OpenCode (a third actor) inspects the
// delivery. Task state lives only in the platform stub's state file
// (the C side) — no harness holds it (R01 re-check: the state
// survives every harness exit). All three model loops are driven by
// the scripted provider; the harnesses, their MCP clients and the
// tool dispatch are the real pinned builds.
//
// Required env: STUB_ENTRY (stub MCP entry), CIRCLE_DIST (built
// circle dist dir), OPENCODE_BIN, PI_BIN.
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LLM = join(HERE, "..", "src", "scripted-llm.mjs");
const CIRCLE_DRIVER = join(HERE, "circle-driver.mjs");
const { STUB_ENTRY, CIRCLE_DIST, OPENCODE_BIN, PI_BIN } = process.env;
for (const [k, v] of Object.entries({ STUB_ENTRY, CIRCLE_DIST, OPENCODE_BIN, PI_BIN })) {
  if (!v) throw new Error(`missing env ${k}`);
}

const WORK = mkdtempSync(join(tmpdir(), "infosec-r06-"));
const stateFile = join(WORK, "r06-state.json");
const negLog = join(WORK, "negotiation.jsonl");
const auditLog = join(WORK, "audit.jsonl");
const PORT = 18200 + (process.pid % 500);

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} timed out`));
    }, opts.timeoutMs ?? 180_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}


function runShell(command, opts = {}) {
  return run("sh", ["-c", command], opts);
}

async function withLlm(plan, fn) {
  const planFile = join(WORK, `plan-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(planFile, JSON.stringify(plan));
  const llm = spawn(process.execPath, [LLM], {
    env: {
      ...process.env,
      SCRIPTED_LLM_PLAN: planFile,
      SCRIPTED_LLM_LOG: join(WORK, "llm.jsonl"),
      SCRIPTED_LLM_PORT: String(PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let llmErr = "";
  llm.stderr.on("data", (d) => (llmErr += d));
  // Wait until the endpoint actually answers (an early exit, e.g.
  // EADDRINUSE, must fail loudly here instead of hanging the leg).
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (llm.exitCode !== null) throw new Error(`scripted llm exited early: ${llmErr}`);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
        method: "POST",
        body: "{}",
      });
      if (res.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error("scripted llm did not come up");
    await new Promise((r) => setTimeout(r, 200));
  }
  try {
    return await fn();
  } finally {
    llm.kill("SIGKILL");
  }
}

const base = { schemaVersion: "1.2.0", tenantId: "tnt_1", scopeId: "scp_1" };
const stubEnv = (principal) => ({
  STUB_STATE_FILE: stateFile,
  STUB_NEGOTIATION_LOG: negLog,
  STUB_AUDIT_LOG: auditLog,
  STUB_PRINCIPAL: principal,
  STUB_ENTRY,
});

function assert(cond, msg) {
  if (!cond) throw new Error(`R06 assertion failed: ${msg}`);
}

/* ---- leg 1: Circle submits ------------------------------------ */
const circleCalls = join(WORK, "circle-calls.json");
writeFileSync(
  circleCalls,
  JSON.stringify([
    {
      tool: "task_submit",
      envelope: {
        ...base,
        requestId: "req_r06_submit",
        idempotencyKey: "r06-submit-1",
        principalId: "prn_circle_user",
        payload: { script: "needs-input", echo: "r06-shared-task" },
      },
    },
  ]),
);
const leg1 = await run(process.execPath, [CIRCLE_DRIVER, CIRCLE_DIST, circleCalls], {
  env: stubEnv("circle-actor-1"),
});
assert(leg1.code === 0, `circle driver exited ${leg1.code}: ${leg1.err}`);
const submitEnv = JSON.parse(leg1.out.split("\n").find((l) => l.startsWith("ENV ")).slice(4));
assert(submitEnv.status === "accepted", `submit status ${submitEnv.status}`);
assert(submitEnv.result.operationId === "op_1", "operation id");
assert(existsSync(stateFile), "R01: task state must persist after Circle exits");

/* ---- leg 2: Pi takes over ------------------------------------- */
const piAgent = join(WORK, "pi-agent");
mkdirSync(piAgent, { recursive: true });
writeFileSync(
  join(piAgent, "mcp.json"),
  JSON.stringify({
    mcpServers: {
      infosec: {
        command: "node",
        args: [STUB_ENTRY],
        env: stubEnv("pi-actor-2"),
        exposure: "direct",
      },
    },
  }),
);
writeFileSync(
  join(piAgent, "models.json"),
  JSON.stringify({
    providers: {
      scripted: {
        baseUrl: `http://127.0.0.1:${PORT}/v1`,
        api: "openai-completions",
        apiKey: "scripted",
        models: [{ id: "scripted-1" }],
      },
    },
  }),
);
const piPlan = {
  steps: [
    { tool: "task_status", arguments: { envelope: { ...base, requestId: "req_r06_status1", idempotencyKey: "r06-status-1", principalId: "prn_pi_user", payload: { operationId: "op_1" } } } },
    { tool: "task_input", arguments: { envelope: { ...base, requestId: "req_r06_input", idempotencyKey: "r06-input-1", principalId: "prn_pi_user", inputRevisionId: "inrev_1", payload: { operationId: "op_1" } } } },
    { tool: "task_status", arguments: { envelope: { ...base, requestId: "req_r06_status2", idempotencyKey: "r06-status-2", principalId: "prn_pi_user", payload: { operationId: "op_1" } } } },
    { text: "Takeover complete." },
  ],
};
const piWork = join(WORK, "pi-work");
mkdirSync(piWork, { recursive: true });
await withLlm(piPlan, async () => {
  const leg2 = await run(
    PI_BIN,
    ["--print", "--model", "scripted/scripted-1", "Take over the shared long task op_1: check its status, answer its pending input, then check status again."],
    { cwd: piWork, env: { PI_CODING_AGENT_DIR: piAgent } },
  );
  assert(leg2.code === 0, `pi exited ${leg2.code}: ${leg2.err.slice(-300)}`);
});
const sessionsDir = join(piAgent, "sessions");
const sessionFile = readdirSync(sessionsDir, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith(".jsonl"))
  .sort()
  .pop();
const piEnvelopes = [];
for (const line of readFileSync(join(sessionsDir, sessionFile), "utf8").split("\n")) {
  if (!line.trim()) continue;
  const entry = JSON.parse(line);
  if (entry.message?.role === "toolResult") {
    piEnvelopes.push(JSON.parse(entry.message.content[0].text));
  }
}
assert(piEnvelopes.length === 3, `pi tool results: ${piEnvelopes.length}`);
assert(piEnvelopes[0].status === "running" && piEnvelopes[0].pendingInputs.length === 1, "pi sees the pending input");
assert(piEnvelopes[2].status === "succeeded", "task succeeded after pi input");
assert(piEnvelopes[2].result.echo === "r06-shared-task" && piEnvelopes[2].result.decided === true, "result payload");

/* ---- leg 3: OpenCode inspects delivery ------------------------ */
const ocProj = join(WORK, "oc-proj");
mkdirSync(ocProj, { recursive: true });
writeFileSync(
  join(ocProj, "opencode.json"),
  JSON.stringify({
    mcp: {
      infosec: {
        type: "local",
        command: ["node", STUB_ENTRY],
        enabled: true,
        environment: stubEnv("opencode-actor-3"),
      },
    },
    provider: {
      scripted: {
        npm: "@ai-sdk/openai-compatible",
        name: "Scripted",
        options: { baseURL: `http://127.0.0.1:${PORT}/v1` },
        models: { "scripted-1": { name: "Scripted 1" } },
      },
    },
    model: "scripted/scripted-1",
  }),
);
const ocPlan = {
  steps: [
    { tool: "task_result", arguments: { envelope: { ...base, requestId: "req_r06_result", idempotencyKey: "r06-result-1", principalId: "prn_oc_user", payload: { operationId: "op_1" } } } },
    { text: "Delivery inspection done." },
  ],
};
const ocData = join(WORK, "oc-data");
await withLlm(ocPlan, async () => {
  const leg3 = await runShell(
    // Driven through a shell with stdin closed: every manual
    // verification of this leg used that shape, while a direct
    // spawn was observed to misroute the session (see record).
    `XDG_DATA_HOME=${ocData} "${OPENCODE_BIN}" run --model scripted/scripted-1 "Inspect delivery of the shared long task op_1: fetch its result." < /dev/null`,
    { cwd: ocProj },
  );
  assert(leg3.code === 0, `opencode exited ${leg3.code}: ${leg3.err.slice(-300)}`);
});

/* ---- cross-leg assertions -------------------------------------- */
const audit = readFileSync(auditLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const sequence = audit.map((a) => `${a.principal}:${a.tool}:${a.responseStatus}`);
const expected = [
  "circle-actor-1:task_submit:accepted",
  "pi-actor-2:task_status:running",
  "pi-actor-2:task_input:running",
  "pi-actor-2:task_status:succeeded",
  "opencode-actor-3:task_result:succeeded",
];
assert(
  JSON.stringify(sequence) === JSON.stringify(expected),
  `audit sequence ${JSON.stringify(sequence)}`,
);
const negotiations = readFileSync(negLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
console.log(JSON.stringify({ r06: "pass", workdir: WORK, sequence, negotiations }, null, 1));
