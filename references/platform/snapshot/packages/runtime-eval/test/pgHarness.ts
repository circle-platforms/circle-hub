import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";

/**
 * Starts a real PostgreSQL server from @embedded-postgres/linux-x64
 * binaries staged under /tmp (same arrangement as platform-pg's
 * harness: this VM runs as root and its overlay blocks other users
 * from traversing the home directory).
 */
export interface PgInstance {
  pool: Pool;
  connectionString: string;
  port: number;
  stop: () => Promise<void>;
}

const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

export async function startPg(dbName: string): Promise<PgInstance> {
  const port = 16_400 + Math.floor(Math.random() * 400);
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
  const binDir = join(stageRoot, "bin");
  const libDir = join(stageRoot, "lib");
  for (const bin of ["initdb", "pg_ctl", "postgres"]) {
    chmodSync(join(binDir, bin), 0o755);
  }
  const dataDir = mkdtempSync(join(tmpdir(), "infosec-pgdata-"));
  if (IS_ROOT) {
    execFileSync("chown", ["-R", "postgres:postgres", stageRoot, dataDir]);
  }
  const run = (cmd: string, args: string[]): void => {
    if (IS_ROOT) {
      execFileSync("sudo", ["-u", "postgres", "env", `LD_LIBRARY_PATH=${libDir}`, cmd, ...args], {
        stdio: "pipe",
      });
    } else {
      execFileSync(cmd, args, {
        stdio: "pipe",
        env: { ...process.env, LD_LIBRARY_PATH: libDir },
      });
    }
  };
  run(join(binDir, "initdb"), [
    "-D",
    dataDir,
    "--auth=trust",
    "--username=postgres",
    "--lc-messages=C",
  ]);
  run(join(binDir, "pg_ctl"), [
    "-D",
    dataDir,
    "-l",
    join(dataDir, "server.log"),
    "-o",
    `-p ${port} -k ${tmpdir()} -c listen_addresses=127.0.0.1`,
    "start",
  ]);
  const admin = new Client({
    connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`,
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
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const connectionString = `postgresql://postgres@127.0.0.1:${port}/${dbName}`;
  const pool = new Pool({ connectionString });
  return {
    pool,
    connectionString,
    port,
    stop: async () => {
      await pool.end();
      try {
        run(join(binDir, "pg_ctl"), ["-D", dataDir, "-m", "immediate", "stop"]);
      } catch {
        // already stopped
      }
      // /tmp is a small tmpfs on this VM: staged binaries and data
      // directories must not accumulate across runs.
      rmSync(stageRoot, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
