// Child process runner for every external tool. Never uses a shell; tests inject their own runner.
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { PlatformError } from './errors.ts';

export interface CommandOptions {
  cwd?: string;
  /** Complete environment of the child. Defaults to toolEnvironment(). */
  env?: NodeJS.ProcessEnv;
  /** Written to stdin, then stdin is closed. May carry a secret: never logged or echoed. */
  input?: string;
  timeoutMs?: number;
  /** Own process group: a Ctrl-C in the terminal reaches only the platform command, which then decides. */
  detached?: boolean;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: readonly string[], options?: CommandOptions) => Promise<CommandResult>;

const OUTPUT_LIMIT = 4 * 1024 * 1024;
/** Exit code reported for a child killed at its time limit (as timeout(1) does). */
export const TIMEOUT_CODE = 124;

/** Keeps the last `limit` bytes of a stream. */
class Tail {
  private readonly limit: number;
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(limit: number) {
    this.limit = limit;
  }

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.limit && this.chunks.length > 1) this.size -= this.chunks.shift()!.length;
  }

  text(): string {
    const all = Buffer.concat(this.chunks);
    return all.subarray(Math.max(0, all.length - this.limit)).toString('utf8');
  }
}

export const runCommand: CommandRunner = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const stdout = new Tail(OUTPUT_LIMIT);
    const stderr = new Tail(OUTPUT_LIMIT);
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? toolEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: options.detached === true,
    });
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, options.timeoutMs);
    }
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    // The child may exit before it reads stdin.
    child.stdin.on('error', () => {});
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new PlatformError(`无法运行 ${command}：${error.message}`));
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const signalled = signal ? 128 + (constants.signals[signal] ?? 0) : 1;
      const errors = stderr.text();
      resolve({
        code: timedOut ? TIMEOUT_CODE : (code ?? signalled),
        stdout: stdout.text(),
        stderr: timedOut ? `${errors}\n超时（${options.timeoutMs} 毫秒）` : errors,
      });
    });
    child.stdin.end(options.input ?? '');
  });

/** Minimal environment for PostgreSQL tools, security and launchctl: no PG* settings leak in from the caller. */
export function toolEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (process.env.USER) env.USER = process.env.USER;
  return { ...env, ...extra };
}

/** The caller's environment without PostgreSQL client settings or retired names, for git and npm. */
export function inheritedEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || key.startsWith('PG') || key.startsWith('CIRCLE_SERVER_')) continue;
    env[key] = value;
  }
  return env;
}

/** The last lines of a tool's output, for an error message. */
export function tailLines(text: string, lines = 12): string {
  return text.trim().split('\n').slice(-lines).join('\n');
}
