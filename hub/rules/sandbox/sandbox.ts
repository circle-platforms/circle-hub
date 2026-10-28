import type { CallResult } from '../../../contracts/generated/vocabulary.ts';
// callPackFunction: runs one pure pack function in a fresh, isolated child process and returns its JSON output.
// Layers: pre-flight scan of the pack (no links, no special files), CPU-time ulimit, sandbox-exec on macOS, the Node permission
// model, the bootstrap's lockdown and import policy, and the parent's wall-clock, memory (resident size) and output limits.
// Every failure is a SandboxError; the parent kills the child's whole process group and keeps working. stopAll ends every
// running child (also when the Hub process exits); sweepOrphans (orphans.ts) ends those an earlier Hub process left behind.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { availableParallelism, tmpdir } from 'node:os';
import { extname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SandboxError, isSandboxErrorCode, type SandboxErrorCode } from './errors.ts';
import { BOOTSTRAP, declaredDependencies, isolatedCommand, osIsolationAvailable, osIsolationFailure } from './isolation.ts';
import { ENTRY_EXTENSIONS } from './policy.ts';
import { createResidentWatch, residentFailure, residentTreeSizes, RESIDENT_UNAVAILABLE_MESSAGE } from './resident.ts';
import { createSlotPool } from './slots.ts';
import { retryFunction, type FunctionAttempt } from './retry.ts';

export interface PackFunctionTarget {
  /** The extracted pack directory. */
  packDir: string;
  /** Module path relative to the pack directory, for example functions/project.ts. */
  module: string;
  /** Export to call; default `default`. */
  export?: string;
}

export interface SandboxLimits {
  /** Wall-clock limit from spawn to result. */
  timeoutMs: number;
  /** Memory the function may use: the child is killed when its resident size exceeds memoryMb + RESIDENT_HEADROOM_MB. */
  memoryMb: number;
  /** Maximum size of the JSON output, and of all text the function writes to stdout or stderr. */
  outputBytes: number;
  /** How much of stdout and of stderr is kept for diagnostics. */
  logBytes: number;
  /** Maximum size of the JSON input. */
  inputBytes: number;
}

export interface SandboxOptions {
  /** Engine checks/subjects only: retry a wall-clock timeout once under the same cap. */
  retryWallTimeout?: boolean;
  /**
   * Default true: refuse to run (SANDBOX_UNAVAILABLE) where sandbox-exec cannot deny the network, because Node 24's permission
   * model does not. Only synthetic test environments without it may pass false; the result then reports osIsolation false.
   */
  requireOsIsolation?: boolean;
  /** Parent-side attempt metadata, never function inputs, output or messages. Observer failures are ignored. */
  onAttempt?: (attempt: FunctionAttempt) => void;
}

export interface SandboxResult {
  output: unknown;
  stdout: string;
  stderr: string;
  /** stdout or stderr was cut at logBytes. */
  truncated: boolean;
  durationMs: number;
  /** sandbox-exec was applied. */
  osIsolation: boolean;
}

export const DEFAULT_LIMITS: SandboxLimits = {
  timeoutMs: 10_000,
  memoryMb: 256,
  outputBytes: 8 * 1024 * 1024,
  logBytes: 64 * 1024,
  inputBytes: 32 * 1024 * 1024,
};

const MAX_LIMITS: SandboxLimits = {
  timeoutMs: 120_000,
  memoryMb: 4096,
  outputBytes: 64 * 1024 * 1024,
  logBytes: 1024 * 1024,
  inputBytes: 128 * 1024 * 1024,
};

const MIN_LIMITS: SandboxLimits = { timeoutMs: 100, memoryMb: 32, outputBytes: 1024, logBytes: 0, inputBytes: 1024 };

/** Resident memory allowed on top of memoryMb: Node itself, compiled code and TypeScript stripping take about 80 MB. */
export const RESIDENT_HEADROOM_MB = 192;

/** V8 heap limit: far enough above the resident limit that the parent's watchdog (SIGKILL) acts first. */
export const heapBackstopMb = (memoryMb: number): number => Math.max(memoryMb * 4, memoryMb + 1024);
/** One resident-size round for all running children per interval. */
export const POLL_MS = 100;
const MAX_PACK_ENTRIES = 20_000;
const MAX_PACK_DEPTH = 32;

function resolveLimits(limits: Partial<SandboxLimits>): SandboxLimits {
  const out = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof SandboxLimits)[]) {
    const value = limits[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError(`沙箱上限 ${key} 不是有限数值`);
    out[key] = Math.min(MAX_LIMITS[key], Math.max(MIN_LIMITS[key], Math.floor(value)));
  }
  return out;
}

// A bounded number of children at a time, so a burst of checks cannot exhaust the machine, and a bounded waiting line. A call
// that waits holds no copy of its input: it is serialized, and the pack scanned, only once the call has a slot.
export const MAX_CONCURRENT = Math.max(2, Math.min(8, availableParallelism()));
export const MAX_WAITING = 10_000;
const slots = createSlotPool({
  running: MAX_CONCURRENT,
  waiting: MAX_WAITING,
  full: () => new SandboxError('SANDBOX_UNAVAILABLE', { reason: 'queue_full', limit: 'queue', waiting: MAX_WAITING }),
});
const residentWatch = createResidentWatch({ intervalMs: POLL_MS, measure: residentTreeSizes, unavailable: () => null, timeoutMs: 1_000 });

// Running children by pid, with the function that stops each.
const live = new Map<number, (code: SandboxErrorCode, detail: Record<string, unknown>) => void>();
let exitHook = false;
let stopEpoch = 0;

/** Pids of the running children. */
export function livePids(): number[] {
  return [...live.keys()];
}

/**
 * Ends every running child and refuses every call still waiting for a slot (SANDBOX_UNAVAILABLE, reason stopping); returns how
 * many children were stopped. Synchronous, so a signal handler can call it before exiting; it also runs when the process exits.
 */
export function stopAll(): number {
  stopEpoch++;
  slots.rejectWaiting(() => new SandboxError('SANDBOX_UNAVAILABLE', { reason: 'stopping' }));
  const stops = [...live.values()];
  for (const stop of stops) stop('SANDBOX_UNAVAILABLE', { reason: 'stopping' });
  return stops.length;
}

interface PreparedPack {
  dir: string;
  entry: string;
  exportName: string;
}

const inside = (dir: string, path: string): boolean => {
  const rel = relative(dir, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/** Refuses links and special files anywhere in the pack: the permission model follows symbolic links out of granted paths. */
async function scanPack(dir: string): Promise<void> {
  let entries = 0;
  const walk = async (path: string, depth: number): Promise<void> => {
    if (depth > MAX_PACK_DEPTH) throw new SandboxError('SANDBOX_VIOLATION', { reason: 'pack_too_deep', path: relative(dir, path) });
    for (const name of await readdir(path)) {
      entries += 1;
      if (entries > MAX_PACK_ENTRIES) throw new SandboxError('SANDBOX_VIOLATION', { reason: 'pack_too_large', limit: MAX_PACK_ENTRIES });
      const child = join(path, name);
      const info = await lstat(child);
      if (info.isSymbolicLink()) throw new SandboxError('SANDBOX_VIOLATION', { reason: 'symbolic_link', path: relative(dir, child) });
      if (info.isDirectory()) await walk(child, depth + 1);
      else if (!info.isFile()) throw new SandboxError('SANDBOX_VIOLATION', { reason: 'special_file', path: relative(dir, child) });
      else if (info.nlink > 1) throw new SandboxError('SANDBOX_VIOLATION', { reason: 'hard_link', path: relative(dir, child) });
    }
  };
  try {
    await walk(dir, 0);
  } catch (error) {
    if (error instanceof SandboxError) throw error;
    // An unreadable or vanishing directory: a typed error, without the system message (it names host paths).
    throw new SandboxError('FUNCTION_NOT_FOUND', { reason: 'pack_unreadable', code: (error as NodeJS.ErrnoException).code ?? 'unknown' });
  }
}

async function preparePack(target: PackFunctionTarget): Promise<PreparedPack> {
  const exportName = target.export ?? 'default';
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exportName)) throw new SandboxError('FUNCTION_NOT_FOUND', { reason: 'export_name', export: exportName });
  if (typeof target.module !== 'string' || target.module === '' || target.module.includes('\0')) {
    throw new SandboxError('FUNCTION_NOT_FOUND', { reason: 'module_path' });
  }
  if (isAbsolute(target.module)) throw new SandboxError('SANDBOX_VIOLATION', { reason: 'module_outside_pack', module: target.module });
  let dir: string;
  try {
    dir = await realpath(target.packDir);
    if (!(await stat(dir)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new SandboxError('FUNCTION_NOT_FOUND', { reason: 'pack_missing' });
  }
  const modulePath = normalize(target.module);
  const entry = join(dir, modulePath);
  if (!inside(dir, entry)) throw new SandboxError('SANDBOX_VIOLATION', { reason: 'module_outside_pack', module: target.module });
  if (!ENTRY_EXTENSIONS.includes(extname(entry))) throw new SandboxError('FUNCTION_NOT_FOUND', { reason: 'module_extension', module: target.module });
  await scanPack(dir);
  try {
    if (!(await lstat(entry)).isFile()) throw new Error('not a file');
  } catch {
    throw new SandboxError('FUNCTION_NOT_FOUND', { reason: 'module_missing', module: modulePath.split(sep).join('/') });
  }
  return { dir, entry, exportName };
}

function serializeInput(input: unknown, limit: number): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(input);
  } catch {
    text = undefined;
  }
  if (text === undefined) throw new TypeError('包内函数的输入必须是 JSON 值');
  if (Buffer.byteLength(text) > limit) throw new RangeError(`包内函数的输入超过 ${limit} 字节`);
  return text;
}

interface Frame {
  status: Extract<CallResult, 'ok' | 'error'>;
  output?: unknown;
  code?: unknown;
  detail?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  truncated?: unknown;
}

function parseFrame(raw: Buffer, nonce: string): Frame | 'invalid' | undefined {
  if (raw.length === 0) return undefined;
  const text = raw.toString('utf8');
  const newline = text.indexOf('\n');
  if (newline < 0 || text.slice(0, newline) !== nonce) return 'invalid';
  try {
    const frame = JSON.parse(text.slice(newline + 1)) as Frame;
    return frame && (frame.status === 'ok' || frame.status === 'error') ? frame : 'invalid';
  } catch {
    return 'invalid';
  }
}

/**
 * Runs `export` (default `default`) of `module` inside `packDir` with `input` (any JSON value) and returns its JSON output.
 * Throws SandboxError for every failure of the function or the sandbox; TypeError or RangeError for an invalid call.
 */
export type SandboxBatchItem = { ok: true; result: SandboxResult } | { ok: false; error: SandboxError };

export async function callPackFunction(target: PackFunctionTarget, input: unknown, limits: Partial<SandboxLimits> = {}, options: SandboxOptions = {}): Promise<SandboxResult> {
  return executePack(target, input, limits, options, false);
}

/** One pure module invocation per item inside one evaluation-scoped isolated process. */
export async function callPackFunctionBatch(target: PackFunctionTarget, inputs: readonly unknown[], limits: Partial<SandboxLimits> = {}, options: SandboxOptions = {}): Promise<SandboxBatchItem[]> {
  if (!Array.isArray(inputs)) throw new TypeError('批量输入必须是数组');
  if (!inputs.length) return [];
  const batch = await executePack(target, inputs, limits, options, true);
  if (!Array.isArray(batch.output) || batch.output.length !== inputs.length) throw new SandboxError('SANDBOX_VIOLATION', { reason: 'invalid_batch_frame' });
  return batch.output.map((item: unknown): SandboxBatchItem => {
    if (item === null || typeof item !== 'object') throw new SandboxError('SANDBOX_VIOLATION', { reason: 'invalid_batch_item' });
    const row = item as Record<string, unknown>;
    if (typeof row.stdout !== 'string' || typeof row.stderr !== 'string' || typeof row.truncated !== 'boolean' || typeof row.durationMs !== 'number') throw new SandboxError('SANDBOX_VIOLATION', { reason: 'invalid_batch_item' });
    const logs = { stdout: row.stdout, stderr: row.stderr };
    if (row.ok === true && Object.hasOwn(row, 'output')) return { ok: true, result: { ...batch, ...logs, output: row.output, durationMs: row.durationMs, truncated: row.truncated } };
    if (row.ok === false && isSandboxErrorCode(row.code) && row.detail !== null && typeof row.detail === 'object') return { ok: false, error: new SandboxError(row.code, row.detail as Record<string, unknown>, logs) };
    throw new SandboxError('SANDBOX_VIOLATION', { reason: 'invalid_batch_item' });
  });
}

async function executePack(
  target: PackFunctionTarget,
  input: unknown,
  limits: Partial<SandboxLimits> = {},
  options: SandboxOptions,
  batch: boolean,
): Promise<SandboxResult> {
  const epoch = stopEpoch;
  const lim = resolveLimits(limits);
  const os = await osIsolationAvailable();
  if (!os && options.requireOsIsolation !== false) {
    throw new SandboxError('SANDBOX_UNAVAILABLE', { reason: 'os_isolation', platform: process.platform, probe: osIsolationFailure() ?? null });
  }
  return retryFunction(() => {
    if (epoch !== stopEpoch) return Promise.reject(new SandboxError('SANDBOX_UNAVAILABLE', { reason: 'stopping' }));
    return slots.run(async () => {
      const inputText = serializeInput(input, lim.inputBytes);
      const pack = await preparePack(target);
      if (epoch !== stopEpoch) throw new SandboxError('SANDBOX_UNAVAILABLE', { reason: 'stopping' });
      return runChild(pack, inputText, lim, os, batch);
    });
  }, lim.timeoutMs, options.onAttempt, options);
}

/** Preserve host startup diagnostics only on the private error; the public sandbox message stays fixed. */
function spawnFailure(error: unknown): SandboxError {
  if (error instanceof SandboxError) return error;
  const errno = typeof error === 'object' && error !== null ? (error as {code?:unknown}).code : undefined;
  return new SandboxError('SANDBOX_UNAVAILABLE', {reason:'spawn_failed',
    ...(typeof errno === 'string' || typeof errno === 'number' ? {errno} : {}),
    message:error instanceof Error ? error.message : String(error),
  });
}

async function runChild(pack: PreparedPack, inputText: string, lim: SandboxLimits, os: boolean, batch: boolean): Promise<SandboxResult> {
  if (!os || process.platform !== 'linux') return runChildWithProbe(pack, inputText, lim, os, batch);
  let dir: string | undefined;
  const server = createServer(socket => socket.destroy());
  let listening = false;
  try {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'circle-hub-sandbox-probe-')));
    await chmod(dir, 0o700);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(join(dir!, 'probe.sock'), () => { listening = true; resolve(); });
    });
    return await runChildWithProbe(pack, inputText, lim, os, batch, dir);
  } catch (error) {
    if (error instanceof SandboxError) throw error;
    throw new SandboxError('SANDBOX_UNAVAILABLE', { reason: 'linux_isolation_selftest_unavailable' });
  } finally {
    if (listening) await new Promise<void>(resolve => server.close(() => resolve()));
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

function runChildWithProbe(pack: PreparedPack, inputText: string, lim: SandboxLimits, os: boolean, batch: boolean, probeDir?: string): Promise<SandboxResult> {
  const deps = declaredDependencies();
  const nonce = randomBytes(16).toString('hex');
  const dirUrl = (dir: string): string => `${pathToFileURL(dir).href}/`;
  const header = JSON.stringify({
    nonce,
    batch,
    linuxOsIsolation: os && process.platform === 'linux',
    linuxProbeDir: probeDir,
    pack: dirUrl(pack.dir),
    entry: pathToFileURL(pack.entry).href,
    exportName: pack.exportName,
    dependencies: deps.roots.map((d) => ({ name: d.name, url: dirUrl(d.dir), base: d.base })),
    dependencyDirs: deps.reads.map(dirUrl),
    outputBytes: lim.outputBytes,
    logBytes: lim.logBytes,
  });
  const request = `${header.slice(0, -1)},"input":${inputText}}`;
  let command: ReturnType<typeof isolatedCommand>;
  try {
    command = isolatedCommand({
      entry: BOOTSTRAP,
      reads: [pack.dir, ...deps.reads],
      heapMb: heapBackstopMb(lim.memoryMb),
      cpuSeconds: Math.ceil(lim.timeoutMs / 1000) * 2 + 1,
      os,
      probeDir,
    });
  } catch {
    throw new SandboxError('SANDBOX_UNAVAILABLE', { reason: 'linux_runtime_bindings_unavailable' });
  }

  return new Promise<SandboxResult>((resolve, reject) => {
    const started = Date.now();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command.command, command.args, {
        cwd: pack.dir,
        env: { TZ: 'UTC' },
        stdio: probeDir ? ['pipe', 'pipe', 'pipe', 'ignore', 'pipe'] : ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      reject(spawnFailure(error));
      return;
    }
    const frameCap = lim.outputBytes + 16 * lim.logBytes + 65_536;
    const frameChunks: Buffer[] = [];
    let frameBytes = 0;
    let stderrText = '';
    let stderrBytes = 0;
    let linuxAttestation = '';
    let stopped: { code: SandboxErrorCode; detail: Record<string, unknown> } | undefined;
    let settled = false;

    const alive = (): boolean => child.exitCode === null && child.signalCode === null;
    const kill = (): void => {
      // Once reaped, its process group id may belong to an unrelated process: never signal a finished child.
      if (!alive()) return;
      try {
        if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }
    };
    const stop = (code: SandboxErrorCode, detail: Record<string, unknown>): void => {
      stopped ??= { code, detail };
      kill();
    };
    if (probeDir) child.stdio[4]?.on('data', (chunk: Buffer) => {
      linuxAttestation += chunk.toString('utf8');
      if (linuxAttestation.length > nonce.length) stop('SANDBOX_UNAVAILABLE', { reason: 'linux_isolation_attestation' });
    });
    const pid = child.pid;
    if (pid !== undefined) live.set(pid, stop);
    if (!exitHook) {
      exitHook = true;
      // Exit listeners run synchronously; SIGKILL to each group is sent before the process is gone.
      process.on('exit', () => stopAll());
    }

    const timer = setTimeout(() => stop('SANDBOX_TIMEOUT', { limit: 'time', timeoutMs: lim.timeoutMs }), lim.timeoutMs);
    const residentLimit = (lim.memoryMb + RESIDENT_HEADROOM_MB) * 1024 * 1024;
    const unwatch =
      pid === undefined
        ? () => {}
        : residentWatch.watch(pid, (bytes) => {
            const failure = residentFailure(bytes, residentLimit, lim.memoryMb);
            if (failure && !settled && !stopped && alive()) stop(failure.code, failure.detail);
          });
    const forget = (): void => {
      clearTimeout(timer);
      unwatch();
      if (pid !== undefined) live.delete(pid);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      frameBytes += chunk.length;
      if (frameBytes > frameCap) return stop('SANDBOX_OUTPUT_TOO_LARGE', { limit: 'output', stream: 'result' });
      frameChunks.push(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > lim.outputBytes) return stop('SANDBOX_OUTPUT_TOO_LARGE', { limit: 'output', stream: 'stderr' });
      if (stderrText.length < lim.logBytes) stderrText += chunk.slice(0, lim.logBytes - stderrText.length);
    });
    child.stdin.on('error', () => {
      // The child may exit before reading everything (for example when it is killed); the exit tells why.
    });
    child.stdin.end(request);

    let finalizer: NodeJS.Timeout | undefined;
    const settle = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (finalizer) clearTimeout(finalizer);
      kill();
      forget();
      child.stdout.destroy();
      child.stderr.destroy();
      const durationMs = Date.now() - started;
      const raw = Buffer.concat(frameChunks);
      const frame = stopped ? undefined : parseFrame(raw, nonce);
      const childStdout = frame && frame !== 'invalid' && typeof frame.stdout === 'string' ? frame.stdout : '';
      const childStderr = frame && frame !== 'invalid' && typeof frame.stderr === 'string' ? frame.stderr : '';
      const logs = { stdout: childStdout, stderr: [childStderr, stderrText].filter(Boolean).join('\n') };
      if (stopped) return reject(new SandboxError(stopped.code, { ...stopped.detail, durationMs }, logs, stopped.detail.reason === 'resident_observation_unavailable' ? RESIDENT_UNAVAILABLE_MESSAGE : undefined));
      // A real external signal remains an observed process failure even if it arrived during the startup attestation.
      if (probeDir && linuxAttestation !== nonce && signal === 'SIGXCPU') return reject(new SandboxError('SANDBOX_TIMEOUT', { limit: 'cpu', durationMs }, logs));
      if (probeDir && linuxAttestation !== nonce && signal) return reject(new SandboxError('SANDBOX_VIOLATION', { reason: 'signal', signal, durationMs, resourceObservation: 'absent' }, logs));
      if (probeDir && linuxAttestation !== nonce) return reject(new SandboxError('SANDBOX_UNAVAILABLE', { reason: 'linux_isolation_attestation', durationMs }, logs));
      if (frame && frame !== 'invalid') {
        if (frame.status === 'ok') {
          return resolve({ output: frame.output, ...logs, truncated: frame.truncated === true || stderrText.length >= lim.logBytes, durationMs, osIsolation: os });
        }
        const code = isSandboxErrorCode(frame.code) ? frame.code : 'SANDBOX_VIOLATION';
        const detail = frame.detail && typeof frame.detail === 'object' ? (frame.detail as Record<string, unknown>) : {};
        return reject(new SandboxError(code, { ...detail, durationMs }, logs));
      }
      if (frame === 'invalid') return reject(new SandboxError('SANDBOX_VIOLATION', { reason: 'invalid_result_frame', durationMs }, logs));
      if (signal === 'SIGXCPU') return reject(new SandboxError('SANDBOX_TIMEOUT', { limit: 'cpu', durationMs }, logs));
      // No result frame: the process ended before it reported anything structured. What is observed is the exit itself
      // (signal or exit code); why the runtime aborted is not. The text of the streams is never read to name a cause: a
      // memory cause is reported only by the resident watchdog above, which measured the bytes (detail.residentBytes).
      // What is missing is that measurement; the next step is the administrator's: raise memoryMb or the poller's reach
      // and rerun, or read the captured streams as a human. No cause is claimed here.
      if (exitCode === 70) return reject(new SandboxError('SANDBOX_UNAVAILABLE', { reason: 'cpu_limit', durationMs }, logs));
      if (exitCode === 72) return reject(new SandboxError('SANDBOX_UNAVAILABLE', { reason: 'linux_isolation_attestation', durationMs }, logs));
      if (signal) return reject(new SandboxError('SANDBOX_VIOLATION', { reason: 'signal', signal, durationMs, resourceObservation: 'absent' }, logs));
      return reject(new SandboxError('FUNCTION_THREW', { reason: 'exit_without_result', exitCode, durationMs, resourceObservation: 'absent' }, logs));
    };
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      kill();
      forget();
      reject(spawnFailure(error));
    });
    // close follows exit once the pipes are drained; a descendant holding them open must not keep the call waiting.
    child.on('exit', (exitCode, signal) => {
      finalizer = setTimeout(() => settle(exitCode, signal), 2_000);
    });
    child.on('close', (exitCode, signal) => settle(exitCode, signal));
  });
}
