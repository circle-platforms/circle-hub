// Resident memory of the sandboxed children, measured by one shared poller: one round per interval for every running child (on
// macOS a single /bin/ps for all of them), instead of one process per child per tick.
import { spawn, spawnSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import type { SandboxErrorCode } from './errors.ts';

/** Resident bytes by pid; a pid that is gone is left out. */
export type Measure = (pids: readonly number[]) => Promise<Map<number, number>>;
/** null is an unobservable tree, not a measured number of bytes. */
export type TreeMeasure = (pids: readonly number[]) => Promise<Map<number, number | null>>;
export const RESIDENT_UNAVAILABLE_MESSAGE = '缺少沙箱进程树完整的内存观测；下一步：请管理员检查进程观测权限和系统负载后重试';

/** A missing observation is not evidence that a memory limit was exceeded. */
export function residentFailure(bytes: number | null, limit: number, memoryMb: number): { code: SandboxErrorCode; detail: Record<string, unknown> } | undefined {
  if (bytes === null || !Number.isSafeInteger(bytes) || bytes < 0) return { code: 'SANDBOX_UNAVAILABLE', detail: { reason: 'resident_observation_unavailable', missing: '沙箱进程树完整的内存观测', next_action: '请管理员检查进程观测权限和系统负载后重试' } };
  return bytes > limit ? { code: 'SANDBOX_VIOLATION', detail: { limit: 'memory', residentBytes: bytes, memoryMb } } : undefined;
}

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
  pause?: () => Promise<void>;
}): TreeMeasure {
 return async (pids) => {
  const result = new Map<number, number | null>();
  await Promise.all(pids.map(async (root) => {
    const found = new Set<number>();
    const pending = [root];
    while (pending.length) {
      const pid = pending.pop()!;
      if (found.has(pid)) continue;
      found.add(pid);
      // An unexpectedly broad process tree must trigger the watchdog, not evade it.
      if (found.size > 256) { result.set(root, null); return; }
      let complete = false;
      for (let attempt = 0; attempt < 12 && !complete; attempt++) {
        let threads: string[];
        try { threads = (await options.readThreads(pid)).sort(); }
        catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' && await options.gone(pid)) { found.delete(pid); complete = true; break; }
          result.set(root, null); return;
        }
        if (!threads.length) {
          if (await options.gone(pid)) { found.delete(pid); complete = true; break; }
          await (options.pause?.() ?? new Promise<void>(resolve => setTimeout(resolve, 2)));
          continue;
        }
        if (threads.length > 1024 || threads.some(tid => !/^[1-9]\d*$/.test(tid))) { result.set(root, null); return; }
        let retry = false;
        for (const tid of threads) {
          let children: string;
          try { children = (await options.readChildren(pid, tid)).trim(); }
          catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' && await options.gone(pid)) { found.delete(pid); complete = true; break; }
            if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' && await options.threadGone(pid, tid)) { retry = true; break; }
            result.set(root, null); return;
          }
          for (const child of children ? children.split(/\s+/) : []) {
            const number = Number(child);
            if (!/^[1-9]\d*$/.test(child) || !Number.isSafeInteger(number)) { result.set(root, null); return; }
            pending.push(number);
          }
        }
        if (complete) break;
        if (retry) { await (options.pause?.() ?? new Promise<void>(resolve => setTimeout(resolve, 2))); continue; }
        try { complete = threads.join(',') === (await options.readThreads(pid)).sort().join(','); }
        catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' && await options.gone(pid)) { found.delete(pid); complete = true; break; }
          result.set(root, null); return;
        }
        if (!complete) await (options.pause?.() ?? new Promise<void>(resolve => setTimeout(resolve, 2)));
      }
      if (!complete) { result.set(root, null); return; }
    }
    const sizes = await options.measure([...found]);
    // A status may disappear when a child exits. Unreadable status for a live process remains a failure.
    for (const pid of found) if (!sizes.has(pid)) {
      if (!(await options.gone(pid))) { result.set(root, null); return; }
    }
    const total = [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0);
    result.set(root, sizes.has(root) && Number.isSafeInteger(total) && total >= 0 ? total : null);
  }));
  return result;
 };
}

/** A PID namespace may leave Node below bubblewrap's monitor. */
export const residentTreeSizes: TreeMeasure = process.platform === 'linux'
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
  : async pids => { const sizes = await residentSizes(pids); return new Map(pids.map(pid => [pid, sizes.get(pid) ?? null])); };

export interface ResidentWatch<T = number> {
  /** Calls `onBytes` with the child's resident size once per round until the returned function is called. */
  watch(pid: number, onBytes: (bytes: T) => void): () => void;
  readonly watching: number;
}

export function createResidentWatch<T = number>(options: { intervalMs: number; measure: (pids: readonly number[]) => Promise<Map<number, T>>; unavailable?: () => T; timeoutMs?: number }): ResidentWatch<T> {
  const watched = new Map<number, (bytes: T) => void>();
  let timer: NodeJS.Timeout | undefined;
  let measuring = false;
  const round = (): void => {
    if (measuring || watched.size === 0) return;
    measuring = true;
    const snapshot = new Map(watched);
    const pids = [...snapshot.keys()];
    let timeout: NodeJS.Timeout | undefined;
    const work = Promise.resolve().then(() => options.measure(pids));
    const measurement = options.timeoutMs === undefined ? work : Promise.race([
      work,
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('resident observation timeout')), options.timeoutMs); }),
    ]);
    measurement
      .then(
        (sizes) => {
          for (const [pid, callback] of snapshot) {
            if (watched.get(pid) !== callback) continue;
            if (sizes.has(pid)) callback(sizes.get(pid)!);
            else if (options.unavailable) callback(options.unavailable());
          }
        },
        () => { if (options.unavailable) for (const [pid, callback] of snapshot) if (watched.get(pid) === callback) callback(options.unavailable()); },
      )
      .finally(() => {
        if (timeout) clearTimeout(timeout);
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
