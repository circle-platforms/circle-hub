// Command line of the sandboxed child: a CPU-time limit (ulimit -t, a backstop if the Hub dies), macOS sandbox-exec denying
// network, writes, forks, exec, signals and inspection of other processes, then Node under the permission model with read access
// to the bootstrap, the extracted pack and the declared dependencies only. Node 24's permission model does not restrict the
// network, so the operating-system layer is required unless a caller explicitly accepts running without it.
import { spawn } from 'node:child_process';
import { constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DECLARED_DEPENDENCIES } from './policy.ts';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
// Real paths: the permission model does not follow a symbolic link on the way to a granted file.
export const BOOTSTRAP = realpathSync(fileURLToPath(new URL('./bootstrap.ts', import.meta.url)));
const POLICY = realpathSync(fileURLToPath(new URL('./policy.ts', import.meta.url)));

/** Real path of the Node binary: sandbox-exec matches exec rules against the resolved path. */
export const NODE = realpathSync(process.execPath);

/** sandbox-exec profile (SBPL). Everything not listed stays allowed; the permission model restricts reads. */
export function sandboxProfile(): string {
  const literal = (path: string): string => JSON.stringify(path);
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny process-fork)',
    `(deny process-exec* (require-not (literal ${literal(NODE)})))`,
    '(deny signal (require-not (target self)))',
    '(deny process-info* (require-not (target self)))',
    '(deny file-write* (require-not (literal "/dev/null")))',
  ].join('');
}

/** A probe's answer. A lasting absence (another platform, no sandbox-exec) is kept; a failed run of the probe is retried. */
export type ProbeOutcome = { available: true } | { available: false; lasting: boolean; reason: string };

export interface IsolationProbe {
  available(): Promise<boolean>;
  /** Why the last probe failed, while no success is known; for SANDBOX_UNAVAILABLE details and the admin log. */
  lastFailure(): string | undefined;
}

/** Caches a success and a lasting absence; after a failed probe, answers false without probing again for `retryMs`. */
export function createIsolationProbe(options: { probe: () => Promise<ProbeOutcome>; retryMs: number; now?: () => number }): IsolationProbe {
  const now = options.now ?? Date.now;
  let settled: boolean | undefined;
  let pending: Promise<boolean> | undefined;
  let failedAt: number | undefined;
  let failure: string | undefined;
  return {
    available(): Promise<boolean> {
      if (settled !== undefined) return Promise.resolve(settled);
      if (pending) return pending;
      if (failedAt !== undefined && now() - failedAt < options.retryMs) return Promise.resolve(false);
      pending = options
        .probe()
        .catch((error: unknown): ProbeOutcome => ({ available: false, lasting: false, reason: error instanceof Error ? error.message : String(error) }))
        .then((outcome) => {
          pending = undefined;
          if (outcome.available) {
            settled = true;
            failure = undefined;
          } else {
            failure = outcome.reason;
            if (outcome.lasting) settled = false;
            else failedAt = now();
          }
          return outcome.available;
        });
      return pending;
    },
    lastFailure: () => failure,
  };
}

/** Runs sandbox-exec with the real profile once. */
async function probeSandboxExec(): Promise<ProbeOutcome> {
  if (process.platform !== 'darwin') return { available: false, lasting: true, reason: 'platform' };
  try {
    await access(SANDBOX_EXEC, constants.X_OK);
  } catch {
    return { available: false, lasting: true, reason: 'no_sandbox_exec' };
  }
  return new Promise<ProbeOutcome>((resolve) => {
    const child = spawn(SANDBOX_EXEC, ['-p', sandboxProfile(), NODE, '-e', ''], { stdio: 'ignore', env: {} });
    child.on('error', (error) => resolve({ available: false, lasting: false, reason: `spawn_failed: ${(error as NodeJS.ErrnoException).code ?? error.message}` }));
    child.on('exit', (code, signal) =>
      resolve(code === 0 ? { available: true } : { available: false, lasting: false, reason: signal ? `signal ${signal}` : `exit ${code}` }),
    );
  });
}

/** How long a failed probe is believed before sandbox-exec is tried again. */
export const PROBE_RETRY_MS = 5_000;

const probe = createIsolationProbe({ probe: probeSandboxExec, retryMs: PROBE_RETRY_MS });

/** Whether sandbox-exec is present and can apply a profile here (it cannot inside some outer sandboxes). */
export function osIsolationAvailable(): Promise<boolean> {
  return probe.available();
}

/** Why the operating-system isolation is not available, when a probe failed. */
export function osIsolationFailure(): string | undefined {
  return probe.lastFailure();
}

export interface Dependency {
  name: string;
  /** Real path of the package directory. */
  dir: string;
  /** File URL inside the node_modules directory that holds the package, used as the parent when resolving it. */
  base: string;
}

let dependencyCache: { roots: Dependency[]; reads: string[] } | undefined;

/** Declared dependencies with the directories they need to read (their own dependencies, recursively). */
export function declaredDependencies(): { roots: Dependency[]; reads: string[] } {
  if (dependencyCache) return dependencyCache;
  const reads = new Set<string>();
  const find = (name: string, from: string): string | undefined => {
    for (let dir = from; ; dir = dirname(dir)) {
      const candidate = join(dir, 'node_modules', name);
      if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
      if (dirname(dir) === dir) return undefined;
    }
  };
  const visit = (dir: string): void => {
    if (reads.has(dir)) return;
    reads.add(dir);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      const found = find(name, dir);
      if (found) visit(found);
    }
  };
  const roots: Dependency[] = [];
  for (const name of DECLARED_DEPENDENCIES) {
    const dir = find(name, dirname(BOOTSTRAP));
    if (!dir) continue;
    visit(dir);
    const container = name.startsWith('@') ? dirname(dirname(dir)) : dirname(dir);
    roots.push({ name, dir, base: pathToFileURL(join(container, '__resolve__.js')).href });
  }
  dependencyCache = { roots, reads: [...reads].sort() };
  return dependencyCache;
}

export interface IsolatedCommand {
  command: string;
  args: string[];
  os: boolean;
}

/**
 * The full command line for one child. `entry` is the script Node runs (the bootstrap, or a probe in tests), `reads` the extra
 * paths it may read. The CPU limit is in seconds of processor time across all threads. `heapMb` is V8's heap limit: a backstop
 * set well above the resident limit the parent enforces, because V8 aborts on heap exhaustion (which leaves a crash report).
 */
export function isolatedCommand(options: { entry: string; reads: string[]; heapMb: number; cpuSeconds: number; os: boolean }): IsolatedCommand {
  const node = [
    '--permission',
    ...[options.entry, POLICY, ...options.reads].map((path) => `--allow-fs-read=${path}`),
    `--max-old-space-size=${options.heapMb}`,
    '--disallow-code-generation-from-strings',
    '--no-addons',
    '--no-experimental-websocket',
    options.entry,
  ];
  const program = options.os ? [SANDBOX_EXEC, '-p', sandboxProfile(), NODE, ...node] : [NODE, ...node];
  return {
    command: '/bin/sh',
    args: ['-c', 'ulimit -t "$1" || exit 70; shift; exec "$@"', 'sh', String(options.cpuSeconds), ...program],
    os: options.os,
  };
}
