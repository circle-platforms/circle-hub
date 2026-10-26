// Test support for the assembly's CLI tests: one temporary socket-only PostgreSQL per test file (passwordless on a private
// socket directory, so the CLI's configuration comes from CIRCLE_HUB_* variables alone, which never carry secrets), a
// runtime role, and deployments: a fresh database and data directory, its CIRCLE_HUB_* environment, a vault key in a
// temporary file, and `run`, which calls the server CLI's main in-process with the output captured.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { FileKeyProvider } from '../../records/index.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import type { CliIo } from '../api.ts';
import { main, type CliOptions } from '../cli.ts';
import { removeTree } from './files.ts';
import { memoryOperatorTokens } from './operator-token.ts';

export const RUNTIME_ROLE = 'hub_runtime';

export interface RunResult {
  code: number;
  out: string[];
  err: string[];
  /** stdout and stderr together. */
  text: string;
}

export interface Deployment {
  env: NodeJS.ProcessEnv;
  dataDir: string;
  key: FileKeyProvider;
  /** Every line any run of this deployment printed, for secret scans. */
  printed: string[];
  run(argv: string[], overrides?: Partial<CliOptions>, extraEnv?: Record<string, string>): Promise<RunResult>;
}

export interface CliHarness {
  postgres: TemporaryPostgres;
  scratch: string;
  /** A fresh database and data directory; migrated (as the owner role, the runtime role granted) unless `migrate` is false. */
  deployment(options?: { migrate?: boolean; key?: boolean; extra?: Record<string, string> }): Promise<Deployment>;
  close(): Promise<void>;
}

export async function openCliHarness(): Promise<CliHarness> {
  const postgres = await startPostgres({ socket: true, passwordless: true });
  const scratch = await mkdtemp(join(tmpdir(), 'circle-hub-assemble-'));
  const client = new pg.Client({ host: postgres.socketDir, port: postgres.config.port, user: postgres.config.user, database: 'postgres' });
  await client.connect();
  try {
    await client.query(`CREATE ROLE ${RUNTIME_ROLE} LOGIN NOSUPERUSER`);
  } finally {
    await client.end();
  }
  let count = 0;
  return {
    postgres,
    scratch,
    async deployment(options = {}) {
      count += 1;
      const database = await postgres.createDatabase();
      const dataDir = join(scratch, `data-${count}`);
      const env: NodeJS.ProcessEnv = {
        CIRCLE_HUB_DATA_DIR: dataDir,
        CIRCLE_HUB_PORT: '0',
        CIRCLE_HUB_DATABASE_SOCKET_DIR: postgres.socketDir,
        CIRCLE_HUB_DATABASE_PORT: String(postgres.config.port),
        CIRCLE_HUB_DATABASE_NAME: database.database,
        CIRCLE_HUB_DATABASE_USER: RUNTIME_ROLE,
        ...options.extra,
      };
      const key = new FileKeyProvider(join(scratch, `vault-${count}.key`));
      if (options.key !== false) await key.initKey();
      const printed: string[] = [];
      const deployment: Deployment = {
        env,
        dataDir,
        key,
        printed,
        async run(argv, overrides = {}, extraEnv = {}) {
          const out: string[] = [];
          const err: string[] = [];
          const io: CliIo = { stdout: (line) => out.push(line), stderr: (line) => err.push(line), env: { ...env, ...extraEnv }, cwd: scratch };
          // The built-in commands never reach the owner's keychain: an empty store unless the test gives its own.
          const empty = memoryOperatorTokens(null, '测试的空钥匙串');
          const code = await main(argv, { io, keyProvider: () => key, ownerRole: postgres.config.user, operatorTokens: () => empty, ...overrides });
          printed.push(...out, ...err);
          return { code, out, err, text: [...out, ...err].join('\n') };
        },
      };
      if (options.migrate !== false) {
        const migrated = await deployment.run(['serve', '--migrate-only']);
        if (migrated.code !== 0) throw new Error(`migration failed: ${migrated.text}`);
      }
      return deployment;
    },
    async close() {
      await postgres.stop();
      // Data directories hold extracted packs, which are read-only.
      await removeTree(scratch);
    },
  };
}
