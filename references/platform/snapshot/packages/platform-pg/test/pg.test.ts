import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import { DurableTaskService } from "../src/index.js";

/**
 * Test harness: starts a REAL PostgreSQL server from the binaries in
 * @embedded-postgres/linux-x64, staged under /tmp. Staging matters on
 * this VM: it runs as root (PostgreSQL refuses root, so the server runs
 * as the `postgres` system user), and the sandbox overlay under the
 * home directory does not let that user traverse into the workspace.
 * On a normal non-root machine everything simply runs as the user.
 */
const PORT = 15_400 + Math.floor(Math.random() * 400);
const CONN = `postgresql://postgres@127.0.0.1:${PORT}/infosec_test`;
const CTX = { tenantId: "tnt_main", scopeId: "scp_demo_a" };
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

let pool: Pool;
let svc: DurableTaskService;
let seq = 0;
const ids = {
  next: (prefix: string) => `${prefix}_${String(++seq).padStart(6, "0")}`,
};

let pgBinDir = "";
let pgDataDir = "";

let pgLibDir = "";

function run(cmd: string, args: string[]): void {
  // The staged binaries need their bundled lib/ on the loader path.
  if (IS_ROOT) {
    execFileSync(
      "sudo",
      ["-u", "postgres", "env", `LD_LIBRARY_PATH=${pgLibDir}`, cmd, ...args],
      { stdio: "pipe" },
    );
  } else {
    execFileSync(cmd, args, {
      stdio: "pipe",
      env: { ...process.env, LD_LIBRARY_PATH: pgLibDir },
    });
  }
}

beforeAll(async () => {
  if (IS_ROOT) {
    try {
      execFileSync("id", ["postgres"], { stdio: "pipe" });
    } catch {
      execFileSync("useradd", ["-m", "postgres"], { stdio: "pipe" });
    }
  }
  const nativeDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "node_modules",
    "@embedded-postgres",
    "linux-x64",
    "native",
  );
  const stageRoot = mkdtempSync(join(tmpdir(), "infosec-pgbin-"));
  cpSync(nativeDir, stageRoot, { recursive: true });
  // cpSync absolutizes symlinks into the workspace tree, which the
  // postgres user cannot traverse; materialize every link as a file.
  const materialize = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = realpathSync(full);
        unlinkSync(full);
        cpSync(target, full);
      } else if (entry.isDirectory()) {
        materialize(full);
      }
    }
  };
  materialize(stageRoot);
  pgBinDir = join(stageRoot, "bin");
  pgLibDir = join(stageRoot, "lib");
  for (const bin of ["initdb", "pg_ctl", "postgres"]) {
    chmodSync(join(pgBinDir, bin), 0o755);
  }
  pgDataDir = mkdtempSync(join(tmpdir(), "infosec-pgdata-"));
  if (IS_ROOT) {
    execFileSync("chown", ["-R", "postgres:postgres", stageRoot, pgDataDir]);
  }
  run(join(pgBinDir, "initdb"), [
    "-D",
    pgDataDir,
    "--auth=trust",
    "--username=postgres",
    "--lc-messages=C",
  ]);
  run(join(pgBinDir, "pg_ctl"), [
    "-D",
    pgDataDir,
    "-l",
    join(pgDataDir, "server.log"),
    "-o",
    `-p ${PORT} -k ${tmpdir()} -c listen_addresses=127.0.0.1`,
    "start",
  ]);
  // Poll until the server accepts connections, then create the test db.
  const admin = new Client({
    connectionString: `postgresql://postgres@127.0.0.1:${PORT}/postgres`,
  });
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try {
      await admin.connect();
      ready = true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!ready) throw new Error("postgres did not become ready");
  await admin.query("CREATE DATABASE infosec_test");
  await admin.end();

  pool = new Pool({ connectionString: CONN });
  svc = new DurableTaskService(pool, ids);
  await svc.migrate();
});

afterAll(async () => {
  if (pool) await pool.end();
  if (pgDataDir) {
    try {
      run(join(pgBinDir, "pg_ctl"), ["-D", pgDataDir, "-m", "immediate", "stop"]);
    } catch {
      // already stopped
    }
  }
});

function accept(title: string, key: string, hash = "hash-1") {
  return svc.acceptTask({
    ...CTX,
    principalId: "prn_alice",
    title,
    idempotencyKey: key,
    requestHash: hash,
  });
}

describe("transactional accept (ADR 0017)", () => {
  it("commits task + idempotency + outbox together; duplicates dedupe; different hash conflicts", async () => {
    const first = await accept("durable task", "accept-key-1");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.phase).toBe("admitted");
    expect(first.value.deduplicated).toBe(false);
    const outbox = await pool.query("SELECT kind FROM outbox WHERE task_id = $1", [
      first.value.taskId,
    ]);
    expect(outbox.rows.map((r) => (r as { kind: string }).kind)).toContain("task.accepted");

    const dupe = await accept("durable task", "accept-key-1");
    expect(dupe.ok && dupe.value.taskId).toBe(first.value.taskId);
    expect(dupe.ok && dupe.value.deduplicated).toBe(true);

    const mismatch = await accept("durable task", "accept-key-1", "hash-2");
    expect(!mismatch.ok && mismatch.error.code).toBe("IDEMPOTENCY_MISMATCH");
  });

  async function runChild(mode: "hold" | "commit", taskId: string, key: string): Promise<void> {
    const child: ChildProcess = spawn(
      process.execPath,
      ["scripts/accept-child.mjs", mode, CONN, taskId, key],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    await new Promise<void>((resolve, reject) => {
      child.stdout?.on("data", () => resolve());
      child.on("error", reject);
      setTimeout(() => reject(new Error("child did not signal")), 30_000);
    });
    child.kill("SIGKILL");
    await new Promise((resolve) => child.on("exit", resolve));
  }

  it("a process killed BEFORE commit leaves no task and no idempotency record", async () => {
    await runChild("hold", "tsk_crash_hold", "accept-crash-hold");
    const task = await pool.query("SELECT task_id FROM tasks WHERE task_id = 'tsk_crash_hold'");
    const idem = await pool.query(
      "SELECT idem_key FROM idempotency WHERE idem_key = 'accept-crash-hold'",
    );
    expect(task.rowCount).toBe(0);
    expect(idem.rowCount).toBe(0);
  });

  it("a process killed AFTER commit leaves the accepted task intact", async () => {
    await runChild("commit", "tsk_crash_commit", "accept-crash-commit");
    const got = await svc.getTask(CTX, "tsk_crash_commit");
    expect(got.ok && got.value.phase).toBe("admitted");
  });
});

describe("C-T01: the completion checklist is authoritative", () => {
  it("every bypass path is rejected; only a fully backed checklist delivers", async () => {
    const accepted = await accept("checklist task", "accept-key-ct01");
    if (!accepted.ok) throw new Error("accept failed");
    const taskId = accepted.value.taskId;
    let revision = accepted.value.revision;
    const step = async (to: "running" | "under-review") => {
      const moved = await svc.transition(CTX, taskId, to, revision);
      if (!moved.ok) throw new Error(`transition to ${to} failed`);
      revision = moved.value.revision;
    };
    await step("running");
    await step("under-review");

    // No checklist at all.
    const noChecklist = await svc.deliver(CTX, taskId, revision);
    expect(!noChecklist.ok && noChecklist.error.code).toBe("INPUT_REVISION_STALE");

    // Empty checklist.
    await svc.attachChecklist(CTX, taskId, []);
    const empty = await svc.deliver(CTX, taskId, revision);
    expect(!empty.ok && empty.error.code).toBe("INVARIANT_VIOLATION");

    await svc.attachChecklist(CTX, taskId, [
      { itemId: "verify-1", kind: "verification", required: true },
      { itemId: "signoff", kind: "human-decision", required: true },
    ]);
    // A freely asserted satisfied/ref does not exist in verifications.
    const bogus = await svc.satisfyItem(CTX, taskId, "verify-1", {
      refId: "ver_made_up",
      actorId: "act_alice",
    });
    expect(!bogus.ok && bogus.error.code).toBe("EVIDENCE_INSUFFICIENT");

    await svc.registerVerification(taskId, "ver_real_1", "verification", "checked the thing");
    const real = await svc.satisfyItem(CTX, taskId, "verify-1", {
      refId: "ver_real_1",
      actorId: "act_alice",
    });
    expect(real.ok).toBe(true);

    // Sign-off by an actor with no role in the scope is rejected.
    const noRole = await svc.satisfyItem(CTX, taskId, "signoff", {
      refId: "decision-1",
      actorId: "act_stranger",
    });
    expect(!noRole.ok && noRole.error.code).toBe("FORBIDDEN_SCOPE");

    await svc.addScopeMember(CTX, "act_reviewer", "reviewer");
    const signed = await svc.satisfyItem(CTX, taskId, "signoff", {
      refId: "decision-1",
      actorId: "act_reviewer",
    });
    expect(signed.ok).toBe(true);

    const delivered = await svc.deliver(CTX, taskId, revision);
    expect(delivered.ok && delivered.value.phase).toBe("delivered");
  });
});

describe("C-T02: stale, cross-scope, role and concurrency rejections", () => {
  it("a stale-revision decision is persisted as a rejection and does not advance the task", async () => {
    const accepted = await accept("stale decision task", "accept-key-ct02");
    if (!accepted.ok) throw new Error("accept failed");
    const taskId = accepted.value.taskId;
    await svc.transition(CTX, taskId, "running", accepted.value.revision);
    const pending = await svc.requestInput(
      CTX,
      taskId,
      { decisionType: "approval", ttlMs: 60_000 },
      Date.now(),
    );
    if (!pending.ok) throw new Error("requestInput failed");
    const current = await svc.getTask(CTX, taskId);
    if (!current.ok) throw new Error("get failed");
    // The input changes while the human is deciding.
    const revised = await svc.reviseInput(CTX, taskId, current.value.revision);
    expect(revised.ok).toBe(true);

    const stale = await svc.respond(
      CTX,
      taskId,
      {
        requestId: pending.value.requestId,
        inputRevisionId: accepted.value.inputRevisionId, // the OLD revision
        actorId: "act_reviewer",
        role: "reviewer",
      },
      Date.now(),
    );
    expect(stale.ok && stale.value.outcome).toBe("stale-revision");
    const after = await svc.getTask(CTX, taskId);
    expect(after.ok && after.value.phase).toBe("waiting-input");
    const decisions = await pool.query(
      "SELECT outcome FROM decisions WHERE task_id = $1",
      [taskId],
    );
    expect(decisions.rows.map((r) => (r as { outcome: string }).outcome)).toContain(
      "stale-revision",
    );
  });

  it("cross-scope reads are forbidden, and two writers on one revision conflict", async () => {
    const accepted = await accept("concurrency task", "accept-key-ct02b");
    if (!accepted.ok) throw new Error("accept failed");
    const cross = await svc.getTask(
      { tenantId: "tnt_main", scopeId: "scp_other" },
      accepted.value.taskId,
    );
    expect(!cross.ok && cross.error.code).toBe("FORBIDDEN_SCOPE");

    // Two writers revising the input on the same expected revision:
    // exactly one commits; the other hits the revision guard.
    const current = await svc.getTask(CTX, accepted.value.taskId);
    if (!current.ok) throw new Error("get failed");
    const [a, b] = await Promise.all([
      svc.reviseInput(CTX, accepted.value.taskId, current.value.revision),
      svc.reviseInput(CTX, accepted.value.taskId, current.value.revision),
    ]);
    const outcomes = [a, b].map((r) => (r.ok ? "ok" : r.error.code));
    expect(outcomes.filter((o) => o === "ok")).toHaveLength(1);
    expect(outcomes).toContain("DECISION_CONFLICT");
  });
});

describe("restart recovery and outbox relay", () => {
  it("state survives a service restart; the relay delivers each event once to a deduping consumer", async () => {
    const accepted = await accept("restart task", "accept-key-restart");
    if (!accepted.ok) throw new Error("accept failed");
    await svc.transition(CTX, accepted.value.taskId, "running", accepted.value.revision);

    // Restart: a brand-new pool and service over the same database.
    const pool2 = new Pool({ connectionString: CONN });
    const svc2 = new DurableTaskService(pool2, ids);
    const got = await svc2.getTask(CTX, accepted.value.taskId);
    expect(got.ok && got.value.phase).toBe("running");

    await pool2.query(
      "CREATE TABLE IF NOT EXISTS consumer_ledger (event_id TEXT PRIMARY KEY)",
    );
    // Scope the assertions to THIS task's events; the shared outbox also
    // holds earlier tests' events, which the relay legitimately drains.
    const mine = await pool2.query(
      "SELECT event_id FROM outbox WHERE task_id = $1",
      [accepted.value.taskId],
    );
    const myEvents = new Set(
      mine.rows.map((r) => (r as { event_id: string }).event_id),
    );
    const total = myEvents.size;
    let handlerCalls = 0;
    let processed = 0;
    const handler = async (event: { eventId: string }) => {
      if (!myEvents.has(event.eventId)) return;
      handlerCalls += 1;
      const inserted = await pool2.query(
        "INSERT INTO consumer_ledger (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id",
        [event.eventId],
      );
      if ((inserted.rowCount ?? 0) > 0) processed += 1;
    };
    await svc2.publishOutbox(50, handler);
    expect(processed).toBe(total);

    // Force a redelivery of one event: the consumer ledger must not double-count.
    await pool2.query(
      "UPDATE outbox SET published_at = NULL WHERE task_id = $1 AND kind = 'task.accepted'",
      [accepted.value.taskId],
    );
    const callsBefore = handlerCalls;
    await svc2.publishOutbox(50, handler);
    expect(handlerCalls).toBeGreaterThan(callsBefore);
    expect(processed).toBe(total);
    await pool2.end();
  });
});
