// Resident memory of the sandboxed children, measured by one shared poller: one round per interval for every running child (on
// macOS a single /bin/ps for all of them), instead of one process per child per tick.
import { spawn, spawnSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';

/** Resident bytes by pid; a pid that is gone is left out. */
export type Measure = (pids: readonly number[]) => Promise<Map<number, number>>;

/** VmRSS is occasionally absent during exec or exit; statm supplies the kernel's resident-page count instead. */
export function createLinuxResidentMeasure(options: { status(pid: number): Promise<string>; statm(pid: number): Promise<string>; pageBytes?: number }): Measure {
  return async pids => {
    const sizes = new Map<number, number>();
    await Promise.all(pids.map(async pid => {
      try {
        const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(await options.status(pid));
        if (match) {
          const value = Number(match[1]) * 1024;
          if (Number.isSafeInteger(value)) { sizes.set(pid, value); return; }
        }
      } catch { /* Try the kernel's other resident counter. */ }
      if (!options.pageBytes) return;
      try {
        const match = /^\s*\d+\s+(\d+)(?:\s|$)/.exec(await options.statm(pid));
        if (!match) return;
        const value = Number(match[1]) * options.pageBytes;
        if (Number.isSafeInteger(value)) sizes.set(pid, value);
      } catch { /* The tree watcher distinguishes exited processes from unavailable measurements. */ }
    }));
    return sizes;
  };
}

const pageSize = (): number | undefined => {
  if (process.platform !== 'linux') return undefined;
  const result = spawnSync('/usr/bin/getconf', ['PAGESIZE'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeout: 5_000 });
  const text = result.stdout?.trim();
  if (result.error || result.status !== 0 || !text || !/^\d+$/.test(text)) return undefined;
  const bytes = Number(text);
  return Number.isSafeInteger(bytes) && bytes > 0 && bytes <= 1024 * 1024 && (bytes & (bytes - 1)) === 0 ? bytes : undefined;
};

const linuxResidentSizes = createLinuxResidentMeasure({
  status: pid => readFile(`/proc/${pid}/status`, 'utf8'),
  statm: pid => readFile(`/proc/${pid}/statm`, 'utf8'),
  pageBytes: pageSize(),
});

export const residentSizes: Measure = async (pids) => {
  const sizes = new Map<number, number>();
  if (pids.length === 0) return sizes;
  if (process.platform === 'linux') {
    return linuxResidentSizes(pids);
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
export function createResidentTreeMeasure(options: {
  readThreads(pid: number): Promise<string[]>;
  readChildren(pid: number, tid: string): Promise<string>;
  gone(pid: number): Promise<boolean>;
  threadGone(pid: number, tid: string): Promise<boolean>;
  measure: Measure;
}): Measure {
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
      let complete = false;
      for (let attempt = 0; attempt < 3 && !complete; attempt++) {
        let threads: string[];
        try { threads = (await options.readThreads(pid)).sort(); }
        catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' && await options.gone(pid)) { found.delete(pid); complete = true; break; }
          result.set(root, Number.MAX_SAFE_INTEGER); return;
        }
        if (!threads.length || threads.length > 1024 || threads.some(tid => !/^[1-9]\d*$/.test(tid))) { result.set(root, Number.MAX_SAFE_INTEGER); return; }
        let retry = false;
        for (const tid of threads) {
          let children: string;
          try { children = (await options.readChildren(pid, tid)).trim(); }
          catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' && await options.gone(pid)) { found.delete(pid); complete = true; break; }
            if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' && await options.threadGone(pid, tid)) { retry = true; break; }
            result.set(root, Number.MAX_SAFE_INTEGER); return;
          }
          for (const child of children ? children.split(/\s+/) : []) {
            const number = Number(child);
            if (!/^[1-9]\d*$/.test(child) || !Number.isSafeInteger(number)) { result.set(root, Number.MAX_SAFE_INTEGER); return; }
            pending.push(number);
          }
        }
        if (complete) break;
        if (retry) continue;
        try { complete = threads.join(',') === (await options.readThreads(pid)).sort().join(','); }
        catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' && await options.gone(pid)) { found.delete(pid); complete = true; break; }
          result.set(root, Number.MAX_SAFE_INTEGER); return;
        }
      }
      if (!complete) { result.set(root, Number.MAX_SAFE_INTEGER); return; }
    }
    const sizes = await options.measure([...found]);
    // A status may disappear when a child exits. Unreadable status for a live process remains a failure.
    for (const pid of found) if (!sizes.has(pid)) {
      if (!(await options.gone(pid))) { result.set(root, Number.MAX_SAFE_INTEGER); return; }
    }
    if (sizes.has(root)) result.set(root, [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0));
  }));
  return result;
 };
}

/** A PID namespace may leave Node below bubblewrap's monitor. */
export const residentTreeSizes: Measure = process.platform === 'linux'
  ? createResidentTreeMeasure({
      readThreads: pid => readdir(`/proc/${pid}/task`),
      readChildren: (pid, tid) => readFile(`/proc/${pid}/task/${tid}/children`, 'utf8'),
      measure: residentSizes,
      gone: async pid => {
        try {
          const status = await readFile(`/proc/${pid}/status`, 'utf8');
          // Zombies have exited and carry no resident memory, but may still be waiting for their parent to reap them.
          return /^State:\s+Z\b/m.test(status);
        }
        catch (error) { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }
      },
      threadGone: async (pid, tid) => {
        try { await stat(`/proc/${pid}/task/${tid}`); return false; }
        catch (error) { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }
      },
    })
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
