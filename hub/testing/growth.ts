// Growth-ratio timing for tests that guard against super-linear work.
//
// An absolute millisecond budget measures the runner as much as the code: the same linear parser takes 2 s on one
// machine and 5 s on a busy CI runner, so a budget tight enough to catch a regression turns red on a slow day. A ratio
// between two input sizes, timed on the same machine at the same moment, cancels the machine's speed and any steady
// load. With a size factor k, a linear cost grows about k times, a quadratic one about k² times; the default bound 2k
// passes linear (and n log n) work with margin and fails quadratic work.
//
// Time is the calling thread's CPU time, not wall-clock time: on a crowded runner a process waits for a core, and
// that wait says nothing about the code. Background threads (concurrent GC sweeping, the optimizing compiler) are left
// out too, since their work lands on whichever run follows and adds a near-constant term that hides growth. Small and large runs are interleaved so what load still leaks in (cache and memory
// bandwidth) hits both, and the fastest run of each size is kept: interference only ever adds time, so the minimum is
// the closest estimate of the intrinsic cost.
import assert from 'node:assert/strict';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

// A full collection before each timed run, so garbage left by earlier tests in the same file is not collected on
// whichever run happens to cross a heap limit. Exposing gc at run time is a documented V8 flag, not a test dependency.
setFlagsFromString('--expose-gc');
const collect = runInNewContext('gc') as () => void;

export interface GrowthOptions {
  /** The small input size; the large one is `factor` times it. Units are whatever `make` takes. */
  small: number;
  /** Size factor between the two inputs. Default 8. */
  factor?: number;
  /** Timed small/large pairs after one untimed warm-up pair. Default 3. */
  runs?: number;
  /** Largest accepted ratio of large to small time. Default 2 × factor. */
  maxRatio?: number;
  /**
   * Below this many milliseconds for the large input the cost is within timer and scheduler noise and the ratio says
   * nothing; the check then passes and only the caller's catastrophic ceiling applies. Default 25.
   */
  noiseFloorMs?: number;
}

export interface Growth {
  small: number;
  large: number;
  smallMs: number;
  largeMs: number;
  ratio: number;
  maxRatio: number;
  /** True when the large run stayed below the noise floor, so the ratio was not judged. */
  belowNoise: boolean;
}

function timeOnce(run: () => unknown): number {
  collect();
  const start = process.threadCpuUsage();
  try {
    run();
  } catch {
    // A refusal (for example a parser limit) is a valid outcome here; the caller checks the outcome separately.
  }
  return cpuMs(start);
}

/** The same for work that is awaited: only what the calling thread does until it settles counts, not time spent waiting. */
async function timeOnceAsync(run: () => Promise<unknown>): Promise<number> {
  collect();
  const start = process.threadCpuUsage();
  try {
    await run();
  } catch {
    // As in timeOnce.
  }
  return cpuMs(start);
}

function cpuMs(start: NodeJS.CpuUsage): number {
  const used = process.threadCpuUsage(start);
  return (used.user + used.system) / 1000;
}

type Plan = { small: number; large: number; runs: number; maxRatio: number; noiseFloorMs: number };

function plan(options: GrowthOptions): Plan {
  const factor = options.factor ?? 8;
  const runs = options.runs ?? 3;
  if (!(factor > 1) || !(runs >= 1) || !(options.small > 0)) throw new Error('growth: small > 0, factor > 1 and runs >= 1 are required');
  return { small: options.small, large: Math.round(options.small * factor), runs, maxRatio: options.maxRatio ?? 2 * factor, noiseFloorMs: options.noiseFloorMs ?? 25 };
}

function result({ small, large, maxRatio, noiseFloorMs }: Plan, smallMs: number, largeMs: number): Growth {
  return { small, large, smallMs, largeMs, ratio: largeMs / Math.max(smallMs, Number.EPSILON), maxRatio, belowNoise: largeMs < noiseFloorMs };
}

/** Times `run` on inputs of size `small` and `factor × small` and returns the ratio of the fastest runs. */
export function measureGrowth<T>(make: (size: number) => T, run: (input: T) => unknown, options: GrowthOptions): Growth {
  const sizes = plan(options);
  const smallInput = make(sizes.small);
  const largeInput = make(sizes.large);
  // Warm-up: JIT compilation and first-touch allocation would otherwise land on whichever size runs first.
  timeOnce(() => run(smallInput));
  timeOnce(() => run(largeInput));
  let smallMs = Infinity;
  let largeMs = Infinity;
  for (let i = 0; i < sizes.runs; i++) {
    smallMs = Math.min(smallMs, timeOnce(() => run(smallInput)));
    largeMs = Math.min(largeMs, timeOnce(() => run(largeInput)));
  }
  return result(sizes, smallMs, largeMs);
}

/**
 * measureGrowth for work that is awaited. Only work the calling thread does counts, so `run` must not hand its work to
 * another thread or process, and nothing else may run on the thread meanwhile (tests of one file run one at a time).
 */
export async function measureGrowthAsync<T>(make: (size: number) => T, run: (input: T) => Promise<unknown>, options: GrowthOptions): Promise<Growth> {
  const sizes = plan(options);
  const smallInput = make(sizes.small);
  const largeInput = make(sizes.large);
  await timeOnceAsync(() => run(smallInput));
  await timeOnceAsync(() => run(largeInput));
  let smallMs = Infinity;
  let largeMs = Infinity;
  for (let i = 0; i < sizes.runs; i++) {
    smallMs = Math.min(smallMs, await timeOnceAsync(() => run(smallInput)));
    largeMs = Math.min(largeMs, await timeOnceAsync(() => run(largeInput)));
  }
  return result(sizes, smallMs, largeMs);
}

/** Message for a failed growth check, with the measurements so a CI log shows what was seen. */
export function describeGrowth(label: string, growth: Growth): string {
  return `${label}: ${growth.small} → ${growth.large} took ${growth.smallMs.toFixed(1)} → ${growth.largeMs.toFixed(1)} ms of CPU, ratio ${growth.ratio.toFixed(2)} (limit ${growth.maxRatio})`;
}

function judge(label: string, growth: Growth): Growth {
  assert.ok(growth.belowNoise || growth.ratio <= growth.maxRatio, `super-linear growth: ${describeGrowth(label, growth)}`);
  return growth;
}

/** Throws when the cost of `run` grows faster than the bound allows between the two sizes. */
export function assertLinearGrowth<T>(label: string, make: (size: number) => T, run: (input: T) => unknown, options: GrowthOptions): Growth {
  return judge(label, measureGrowth(make, run, options));
}

/** assertLinearGrowth for work that is awaited (see measureGrowthAsync). */
export async function assertLinearGrowthAsync<T>(label: string, make: (size: number) => T, run: (input: T) => Promise<unknown>, options: GrowthOptions): Promise<Growth> {
  return judge(label, await measureGrowthAsync(make, run, options));
}
