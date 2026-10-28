// Resident memory of the sandboxed children, measured by one shared poller: one round per interval for every running child (on
// macOS a single /bin/ps for all of them), instead of one process per child per tick.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

/** Resident bytes by pid; a pid that is gone is left out. */
export type Measure = (pids: readonly number[]) => Promise<Map<number, number>>;

export const residentSizes: Measure = async (pids) => {
  const sizes = new Map<number, number>();
  if (pids.length === 0) return sizes;
  if (process.platform === 'linux') {
    await Promise.all(
      pids.map(async (pid) => {
        try {
          const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(await readFile(`/proc/${pid}/status`, 'utf8'));
          if (match) sizes.set(pid, Number(match[1]) * 1024);
        } catch {
          // Gone.
        }
      }),
    );
    return sizes;
  }
  return new Promise((resolve) => {
    const ps = spawn('/bin/ps', ['-o', 'pid=,rss=', '-p', pids.join(',')], { stdio: ['ignore', 'pipe', 'ignore'], env: {} });
    let text = '';
    ps.stdout.setEncoding('utf8');
    ps.stdout.on('data', (chunk: string) => (text += chunk));
    ps.on('error', () => resolve(sizes));
    ps.on('close', () => {
      for (const line of text.split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
        if (m) sizes.set(Number(m[1]), Number(m[2]) * 1024);
      }
      resolve(sizes);
    });
  });
};

/** Sum a Linux supervisor and descendants; a live but unreadable process tree is an unprovable memory bound. */
export function createResidentTreeMeasure(options: { readChildren(pid: number): Promise<string>; measure: Measure }): Measure {
 return async (pids) => {
  const result = new Map<number, number>();
  await Promise.all(pids.map(async (root) => {
    const found = new Set<number>();
    const pending = [root];
    while (pending.length) {
      const pid = pending.pop()!;
      if (found.has(pid)) continue;
      found.add(pid);
      // An unexpectedly broad process tree must trigger the watchdog, not evade it.
      if (found.size > 256) { result.set(root, Number.MAX_SAFE_INTEGER); return; }
      try {
        const children = (await options.readChildren(pid)).trim();
        for (const child of children ? children.split(/\s+/) : []) {
          const number = Number(child);
          if (!/^[1-9]\d*$/.test(child) || !Number.isSafeInteger(number)) { result.set(root, Number.MAX_SAFE_INTEGER); return; }
          pending.push(number);
        }
      } catch (error) {
        // ENOENT can mean a process exited between samples; any other failure, or a still-live process, fails closed.
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT' || (await options.measure([pid])).has(pid)) {
          result.set(root, Number.MAX_SAFE_INTEGER);
          return;
        }
        found.delete(pid);
      }
    }
    const sizes = await options.measure([...found]);
    // An unreadable status is indistinguishable from an exit after enumeration. The watcher checks liveness before killing.
    for (const pid of found) if (!sizes.has(pid)) {
      result.set(root, Number.MAX_SAFE_INTEGER);
      return;
    }
    if (sizes.has(root)) result.set(root, [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0));
  }));
  return result;
 };
}

/** A PID namespace may leave Node below bubblewrap's monitor. */
export const residentTreeSizes: Measure = process.platform === 'linux'
  ? createResidentTreeMeasure({ readChildren: pid => readFile(`/proc/${pid}/task/${pid}/children`, 'utf8'), measure: residentSizes })
  : residentSizes;

export interface ResidentWatch {
  /** Calls `onBytes` with the child's resident size once per round until the returned function is called. */
  watch(pid: number, onBytes: (bytes: number) => void): () => void;
  readonly watching: number;
}

export function createResidentWatch(options: { intervalMs: number; measure: Measure }): ResidentWatch {
  const watched = new Map<number, (bytes: number) => void>();
  let timer: NodeJS.Timeout | undefined;
  let measuring = false;
  const round = (): void => {
    if (measuring || watched.size === 0) return;
    measuring = true;
    options
      .measure([...watched.keys()])
      .then(
        (sizes) => {
          for (const [pid, bytes] of sizes) watched.get(pid)?.(bytes);
        },
        () => {
          // A failed round is followed by the next one.
        },
      )
      .finally(() => {
        measuring = false;
      });
  };
  return {
    watch(pid, onBytes) {
      watched.set(pid, onBytes);
      timer ??= setInterval(round, options.intervalMs);
      return () => {
        watched.delete(pid);
        if (watched.size === 0 && timer) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
    get watching() {
      return watched.size;
    },
  };
}
