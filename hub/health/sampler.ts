// The sampling loop: every tick asks each reading for its fields and writes one wide row. A reading that fails or does not
// answer leaves its fields null and is named in failed_reads; the others and the next tick go on. A reading still pending
// from an earlier tick is not started again: a stuck statfs must not fill the thread pool the requests' file reads use.
import { emptyValues, type ResourceSample, type SampleValues } from './store.ts';

export const SAMPLE_INTERVAL_MS = 10_000;
const READ_TIMEOUT_MS = 5_000;
const WRITE_TIMEOUT_MS = 5_000;
const LOG_EVERY_MS = 60_000;

export interface Reading {
  /** Fixed name, recorded in failed_reads. */
  name: string;
  /** Read at every n-th tick, the first tick included; default 1. */
  every?: number;
  read(): Partial<SampleValues> | Promise<Partial<SampleValues>>;
}

export interface SamplerOptions {
  boot: string;
  readings: readonly Reading[];
  write(sample: ResourceSample): Promise<void>;
  now: () => Date;
  log: (line: string) => void;
  /** Names of what else failed since the last tick, for example the in-flight log. */
  otherFailures?: () => string[];
  intervalMs?: number;
  readTimeoutMs?: number;
  writeTimeoutMs?: number;
}

export interface Sampler {
  /** Takes and writes one sample. Never rejects; a sample that could not be written is counted in the next one. */
  tick(): Promise<ResourceSample>;
  start(): void;
  /** Ends the loop and waits for a tick in progress. */
  stop(): Promise<void>;
}

/** Settles as `work` does, or rejects after `ms`. */
export function bounded<T>(work: T | Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('no answer in time')), ms);
    timer.unref();
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

export function createSampler(options: SamplerOptions): Sampler {
  const { now, log } = options;
  const intervalMs = options.intervalMs ?? SAMPLE_INTERVAL_MS;
  const readTimeoutMs = options.readTimeoutMs ?? READ_TIMEOUT_MS;
  const writeTimeoutMs = options.writeTimeoutMs ?? WRITE_TIMEOUT_MS;
  const pending = new Set<string>();
  let ticks = 0;
  let previous: number | null = null;
  let dropped = 0;
  let loggedAt = Number.NEGATIVE_INFINITY;
  let timer: NodeJS.Timeout | null = null;
  let current: Promise<ResourceSample> | null = null;
  let stopped = false;

  const take = async (reading: Reading, into: SampleValues, failed: string[]): Promise<void> => {
    if (pending.has(reading.name)) {
      failed.push(reading.name);
      return;
    }
    pending.add(reading.name);
    let work: ReturnType<Reading['read']>;
    try {
      work = reading.read();
    } catch {
      pending.delete(reading.name);
      failed.push(reading.name);
      return;
    }
    // The name stays pending until the reading itself settles, which may be long after this tick gave up on it.
    void Promise.resolve(work).catch(() => {}).finally(() => pending.delete(reading.name));
    try {
      Object.assign(into, await bounded(work, readTimeoutMs));
    } catch {
      failed.push(reading.name);
    }
  };

  const once = async (): Promise<ResourceSample> => {
    const at = now();
    const round = ticks;
    ticks += 1;
    const values = emptyValues();
    const failed: string[] = [];
    await Promise.all(options.readings.filter((reading) => round % (reading.every ?? 1) === 0).map((reading) => take(reading, values, failed)));
    try {
      failed.push(...(options.otherFailures?.() ?? []));
    } catch {
      failed.push('other-failures');
    }
    const sample: ResourceSample = {
      ...values,
      sampled_at: at.toISOString(),
      boot: options.boot,
      interval_ms: previous === null ? null : Math.max(0, at.getTime() - previous),
      failed_reads: failed.sort(),
      dropped_samples: dropped,
    };
    previous = at.getTime();
    try {
      await bounded(options.write(sample), writeTimeoutMs);
      dropped = 0;
    } catch (error) {
      dropped += 1;
      if (at.getTime() - loggedAt >= LOG_EVERY_MS) {
        loggedAt = at.getTime();
        log(`资源样本写入失败（这个进程已有 ${dropped} 个样本没有写入，不影响服务）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return sample;
  };

  const tick = (): Promise<ResourceSample> => {
    current = once();
    return current;
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick().finally(schedule);
    }, intervalMs);
    timer.unref();
  };

  return {
    tick,
    start() {
      if (timer === null && !stopped) schedule();
    },
    async stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      await current?.catch(() => {});
    },
  };
}
