// Helpers for the platform tests. Nothing here may reach the login keychain, ~/Library, the user's launchd domain or the
// network: launchctl is always faked, security only runs against a temporary keychain file, data roots are temporary.
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { libpqDirectory } from './backup.ts';
import type { PostgresControl } from './postgres.ts';
import { runCommand, type CommandOptions, type CommandResult, type CommandRunner } from './process.ts';
import { grantTables } from './roles.ts';
import { withSession, type SqlSession } from './sql.ts';

export interface Call {
  command: string;
  args: string[];
  options: CommandOptions;
}

export const ok = (stdout = '', stderr = ''): CommandResult => ({ code: 0, stdout, stderr });
export const exit = (code: number, stderr = '', stdout = ''): CommandResult => ({ code, stdout, stderr });

/** A short temporary directory (the PostgreSQL socket path must stay under 103 bytes). */
export function tempDir(prefix = 'chp-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/** Refuses commands that could reach the user's real environment. */
export function guard(call: Call, keychain?: string): void {
  const name = basename(call.command);
  if (name === 'launchctl') throw new Error(`test tried to run launchctl ${call.args.join(' ')}`);
  if (name === 'security') {
    // Every security call must name the temporary keychain file: as its last argument, or inside the -i input line.
    const input = call.options.input ?? '';
    const targeted = keychain !== undefined && (call.args.at(-1) === keychain || (call.args[0] === '-i' && input.trimEnd().endsWith(`"${keychain}"`)));
    if (!targeted) throw new Error('test tried to use the default keychain');
  }
}

/**
 * A runner that answers a call itself when `handler` returns a result, and otherwise runs the real command (after the
 * guard). Every call is recorded with its options; stdin is recorded so tests can check where secrets went.
 */
export function recordingRunner(
  handler: (call: Call) => CommandResult | undefined | Promise<CommandResult | undefined> = () => undefined,
  options: { keychain?: string; real?: boolean } = {},
): { runner: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: CommandRunner = async (command, args, opts = {}) => {
    const call = { command, args: [...args], options: opts };
    calls.push(call);
    const answer = await handler(call);
    if (answer) return answer;
    if (options.real === false) throw new Error(`unexpected command in test: ${command} ${args.join(' ')}`);
    guard(call, options.keychain);
    return runCommand(command, args, opts);
  };
  return { runner, calls };
}

/** The libpq directory when pg_dump and pg_restore are installed, else undefined. */
export async function libpqAvailable(): Promise<string | undefined> {
  const dir = libpqDirectory(undefined, process.env);
  for (const tool of ['pg_dump', 'pg_restore']) {
    try {
      await access(join(dir, tool));
    } catch {
      return undefined;
    }
  }
  return dir;
}

export const LIBPQ_MISSING = 'skipped: pg_dump and pg_restore are not installed (brew install libpq, or set CIRCLE_HUB_LIBPQ_BIN)';

export interface CapturedIo {
  out: string[];
  err: string[];
  io: { stdout(line: string): void; stderr(line: string): void; env: NodeJS.ProcessEnv; cwd: string };
}

export function captureIo(env: NodeJS.ProcessEnv, cwd: string): CapturedIo {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (line) => out.push(line), stderr: (line) => err.push(line), env, cwd } };
}

/** A free loopback TCP port, released before it is returned. */
export async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** A random port number used only to name a socket file; below the ephemeral ranges (macOS 49152+, Linux 32768+). */
export function socketPort(): number {
  return 20000 + Math.floor(Math.random() * 12000);
}

/**
 * Runs `statements` in the Hub database as the superuser role that owns it, then grants the application role SELECT and
 * INSERT on `tables`, as the records migration does for its history tables. The rows are then written as the
 * application role, like the server writes its own.
 */
export async function ownerTables(control: PostgresControl, statements: readonly string[], tables: readonly string[]): Promise<void> {
  await withSession(control.connector, control.target.database, async (session) => {
    for (const statement of statements) await session.query(statement);
    await grantTables(session, control.application.user, tables);
  });
}

/** The SQLSTATE a statement fails with in its own transaction (always rolled back), or null when it ran. */
export async function sqlState(session: SqlSession, statement: string): Promise<string | null> {
  await session.query('BEGIN');
  try {
    await session.query(statement);
    return null;
  } catch (error) {
    return String((error as { code?: unknown }).code ?? '?');
  } finally {
    await session.query('ROLLBACK');
  }
}
