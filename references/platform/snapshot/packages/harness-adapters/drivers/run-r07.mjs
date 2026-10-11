// R07 cross-harness pairing at L3: the SAME six-call scenario
// (submit an instant task, then fetch its result) is executed once
// through each real harness — OpenCode, Circle, Pi — against fresh
// platform state, and the response envelopes each harness actually
// received are compared after removing request-scoped fields
// (requestId, acceptedAt). Any semantic drift between adapters
// fails the comparison.
//
// Required env: STUB_ENTRY, CIRCLE_DIST, OPENCODE_BIN, PI_BIN.
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

const WORK = mkdtempSync(join(tmpdir(), "infosec-r07-"));
const PORT = 18700 + (process.pid % 500);
const base = { schemaVersion: "1.2.0", tenantId: "tnt_1", scopeId: "scp_1" };

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

async function withLlm(plan, port, fn) {
  const planFile = join(WORK, `plan-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(planFile, JSON.stringify(plan));
  const llm = spawn(process.execPath, [LLM], {
    env: {
      ...process.env,
      SCRIPTED_LLM_PLAN: planFile,
      SCRIPTED_LLM_LOG: join(WORK, "llm.jsonl"),
      SCRIPTED_LLM_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Wait until the endpoint actually answers (an early exit, e.g.
  // EADDRINUSE, must fail loudly here instead of hanging the leg).
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (llm.exitCode !== null) throw new Error("scripted llm exited early");
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
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

function scenarioCalls() {
  return [
    {
      tool: "task_submit",
      envelope: {
        ...base,
        requestId: "req_r07_submit",
        idempotencyKey: "r07-submit-1",
        principalId: "prn_r07",
        payload: { script: "instant", echo: "r07" },
      },
    },
    {
      tool: "task_result",
      envelope: {
        ...base,
        requestId: "req_r07_result",
        idempotencyKey: "r07-result-1",
        principalId: "prn_r07",
        payload: { operationId: "op_1" },
      },
    },
  ];
}

function planFrom(calls) {
  return {
    steps: [
      ...calls.map((c) => ({ tool: c.tool, arguments: { envelope: c.envelope } })),
      { text: "Scenario complete." },
    ],
  };
}

function normalize(envelope) {
  const copy = JSON.parse(JSON.stringify(envelope));
  delete copy.requestId;
  delete copy.acceptedAt;
  return copy;
}

function assert(cond, msg) {
  if (!cond) throw new Error(`R07 assertion failed: ${msg}`);
}

async function viaCircle(dir, stubEnv) {
  const callsFile = join(dir, "calls.json");
  writeFileSync(callsFile, JSON.stringify(scenarioCalls()));
  const res = await run(process.execPath, [CIRCLE_DRIVER, CIRCLE_DIST, callsFile], {
    env: stubEnv,
  });
  assert(res.code === 0, `circle driver exited ${res.code}: ${res.err}`);
  return res.out
    .split("\n")
    .filter((l) => l.startsWith("ENV "))
    .map((l) => JSON.parse(l.slice(4)));
}

async function viaPi(dir, stubEnv, port) {
  const agent = join(dir, "agent");
  mkdirSync(agent, { recursive: true });
  writeFileSync(
    join(agent, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        infosec: { command: "node", args: [STUB_ENTRY], env: stubEnv, exposure: "direct" },
      },
    }),
  );
  writeFileSync(
    join(agent, "models.json"),
    JSON.stringify({
      providers: {
        scripted: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          apiKey: "scripted",
          models: [{ id: "scripted-1" }],
        },
      },
    }),
  );
  const work = join(dir, "work");
  mkdirSync(work, { recursive: true });
  await withLlm(planFrom(scenarioCalls()), port, async () => {
    const res = await run(
      PI_BIN,
      ["--print", "--model", "scripted/scripted-1", "Run the two-step scenario: submit the instant task, then fetch its result."],
      { cwd: work, env: { PI_CODING_AGENT_DIR: agent } },
    );
    assert(res.code === 0, `pi exited ${res.code}: ${res.err.slice(-300)}`);
  });
  const sessionsDir = join(agent, "sessions");
  const files = readdirSync(sessionsDir, { recursive: true }).map(String).filter((f) => f.endsWith(".jsonl")).sort();
  const envelopes = [];
  for (const line of readFileSync(join(sessionsDir, files.pop()), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    if (entry.message?.role === "toolResult") envelopes.push(JSON.parse(entry.message.content[0].text));
  }
  return envelopes;
}

async function viaOpencode(dir, stubEnv, port) {
  const proj = join(dir, "proj");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, "opencode.json"),
    JSON.stringify({
      mcp: {
        infosec: { type: "local", command: ["node", STUB_ENTRY], enabled: true, environment: stubEnv },
      },
      provider: {
        scripted: {
          npm: "@ai-sdk/openai-compatible",
          name: "Scripted",
          options: { baseURL: `http://127.0.0.1:${port}/v1` },
          models: { "scripted-1": { name: "Scripted 1" } },
        },
      },
      model: "scripted/scripted-1",
    }),
  );
  const dataHome = join(dir, "data");
  await withLlm(planFrom(scenarioCalls()), port, async () => {
    const res = await runShell(
      `XDG_DATA_HOME=${dataHome} "${OPENCODE_BIN}" run --model scripted/scripted-1 "Run the two-step scenario: submit the instant task, then fetch its result." < /dev/null`,
      { cwd: proj },
    );
    assert(res.code === 0, `opencode exited ${res.code}: ${res.err.slice(-300)}`);
  });
  // OpenCode stores tool parts (with the received envelope text) in
  // its SQLite database; extract with python3's sqlite3.
  const dbPath = join(dataHome, "opencode", "opencode.db");
  assert(existsSync(dbPath), "opencode db exists");
  const extractor = join(dir, "extract.py");
  writeFileSync(
    extractor,
    [
      "import sqlite3, json, sys",
      "db = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)",
      "out = []",
      "for (data,) in db.execute('SELECT data FROM part ORDER BY time_created'):",
      "    d = json.loads(data)",
      "    if d.get('type') == 'tool' and d.get('state', {}).get('status') == 'completed':",
      "        text = d['state'].get('output', '')",
      "        start = text.find('{')",
      "        if start >= 0:",
      "            out.append(json.loads(text[start:]))",
      "print(json.dumps(out))",
    ].join("\n"),
  );
  const res = await run("python3", [extractor, dbPath], {});
  assert(res.code === 0, `extractor exited ${res.code}: ${res.err}`);
  return JSON.parse(res.out);
}

const results = {};
for (const [index, harness] of ["circle", "pi", "opencode"].entries()) {
  const dir = join(WORK, harness);
  mkdirSync(dir, { recursive: true });
  const stubEnv = {
    STUB_STATE_FILE: join(dir, "state.json"),
    STUB_NEGOTIATION_LOG: join(dir, "negotiation.jsonl"),
    STUB_AUDIT_LOG: join(dir, "audit.jsonl"),
    STUB_PRINCIPAL: `r07-${harness}`,
    STUB_ENTRY,
  };
  const port = PORT + index * 7;
  const envelopes =
    harness === "circle"
      ? await viaCircle(dir, stubEnv)
      : harness === "pi"
        ? await viaPi(dir, stubEnv, port)
        : await viaOpencode(dir, stubEnv, port);
  assert(envelopes.length === 2, `${harness} produced ${envelopes.length} envelopes`);
  results[harness] = envelopes.map(normalize);
}

const reference = JSON.stringify(results.circle);
for (const harness of ["pi", "opencode"]) {
  assert(
    JSON.stringify(results[harness]) === reference,
    `${harness} envelopes differ from circle's:\n${JSON.stringify(results[harness], null, 1)}\nvs\n${reference}`,
  );
}
console.log(JSON.stringify({ r07: "pass", workdir: WORK, comparedEnvelopes: 2, harnesses: Object.keys(results) }, null, 1));
