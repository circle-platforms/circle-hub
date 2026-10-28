// Design adapted from Circle src/windows_stranded.ts at 25863be04d2b169b5d776d7ec21a76ccbd330738,
// Apache-2.0, Copyright (c) 2026 qingshanfeihu and the Circle contributors.
// See https://github.com/circle-platforms/circle. No archived module is imported.
// A Job contains descendants; it does not deny network access or filesystem writes.
import { setTimeout as delay } from 'node:timers/promises';

export interface WindowsJobLimits {
  /** Aggregate user-mode CPU seconds, not total kernel + user CPU time. */
  userCpuSeconds: number;
  /** Aggregate committed virtual memory, not RSS. */
  committedBytes: number;
}

/** Encode the supported x64/ARM64 JOBOBJECT_EXTENDED_LIMIT_INFORMATION ABI. */
export function windowsJobLimits(limits?: WindowsJobLimits): Buffer {
  const data = Buffer.alloc(144);
  let flags = 0x2000; // KILL_ON_JOB_CLOSE, without either breakaway flag.
  if (limits !== undefined) {
    if (!Number.isSafeInteger(limits.userCpuSeconds) || limits.userCpuSeconds < 1 || limits.userCpuSeconds > 3600 ||
        !Number.isSafeInteger(limits.committedBytes) || limits.committedBytes < 1 || limits.committedBytes > Number.MAX_SAFE_INTEGER)
      throw new RangeError('Windows Job 资源上限无效');
    flags |= 0x4 | 0x200; // JOB_TIME and JOB_MEMORY.
    data.writeBigInt64LE(BigInt(limits.userCpuSeconds) * 10_000_000n, 8);
    data.writeBigUInt64LE(BigInt(limits.committedBytes), 120);
  }
  data.writeUInt32LE(flags, 16);
  return data;
}

export interface WindowsJobApi {
  create(limits?: WindowsJobLimits): bigint;
  assign(job: bigint, pid: number): boolean;
  active(job: bigint): number;
  terminate(job: bigint): void;
  close(job: bigint): void;
}

/** Owns a trusted, idle bootstrap only. Assignment after spawn cannot confine earlier descendants. */
export function attachWindowsJob(api: WindowsJobApi, pid: number, limits?: WindowsJobLimits): { stop(): Promise<void> } {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Windows 进程标识无效');
  const job = api.create(limits);
  try {
    if (!api.assign(job, pid)) throw new Error('Windows Job 分配失败');
  } catch (error) {
    api.close(job);
    throw error;
  }
  let stopping: Promise<void> | undefined;
  return {
    stop() {
      // Preserve the original cleanup promise, as Circle preserves its taskkill promise.
      stopping ??= (async () => {
        try {
          api.terminate(job);
          const deadline = Date.now() + 10_000;
          while (api.active(job) !== 0) {
            if (Date.now() >= deadline) throw new Error('Windows Job 进程仍未退出');
            await delay(10);
          }
        } finally { api.close(job); }
      })();
      return stopping;
    },
  };
}

let loading: Promise<WindowsJobApi> | undefined;
/** Only the Windows adapter loads koffi; importing this module elsewhere loads no addon. */
export function loadWindowsJobApi(): Promise<WindowsJobApi> {
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch))
    return Promise.reject(new Error('Windows Job 仅支持原生 x64 或 ARM64'));
  loading ??= loadNative().catch(error => { loading = undefined; throw error; });
  return loading;
}

async function loadNative(): Promise<WindowsJobApi> {
  const { default: koffi } = await import('koffi');
  return createWindowsJobApi(koffi);
}

/** Injectable native boundary for synthetic loader/version checks without loading an addon. */
export function createWindowsJobApi(koffi: {
  version: string;
  load(name: string): { func(declaration: string): (...args: unknown[]) => unknown };
}): WindowsJobApi {
  if (koffi.version !== '3.3.3') throw new Error('Windows Job 的 koffi 版本不匹配');
  // Windows resolves this KnownDLL; no caller-controlled environment path is consulted.
  const kernel = koffi.load('kernel32.dll');
  const create = kernel.func('void * __stdcall CreateJobObjectW(void *attributes, void *name)');
  const set = kernel.func('int __stdcall SetInformationJobObject(void *job, int kind, void *data, uint32_t size)');
  const open = kernel.func('void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)');
  const assign = kernel.func('int __stdcall AssignProcessToJobObject(void *job, void *process)');
  const query = kernel.func('int __stdcall QueryInformationJobObject(void *job, int kind, void *data, uint32_t size, void *returned)');
  const terminate = kernel.func('int __stdcall TerminateJobObject(void *job, uint32_t code)');
  const close = kernel.func('int __stdcall CloseHandle(void *handle)');
  const valid = (handle: unknown): handle is bigint => typeof handle === 'bigint' && handle !== 0n && BigInt.asIntN(64, handle) !== -1n;
  return {
    create(resourceLimits) {
      const limits = windowsJobLimits(resourceLimits);
      const job: unknown = create(null, null);
      if (!valid(job)) throw new Error('Windows Job 创建失败');
      // JOBOBJECT_EXTENDED_LIMIT_INFORMATION on both supported 64-bit ABIs.
      // KILL_ON_JOB_CLOSE is cleanup only; it is not a security isolation policy.
      if (!set(job, 9, limits, limits.length)) {
        close(job);
        throw new Error('Windows Job 清理策略设置失败');
      }
      return job;
    },
    assign(job, pid) {
      const processHandle: unknown = open(0x100 | 0x1, 0, pid);
      if (!valid(processHandle)) return false;
      try { return Boolean(assign(job, processHandle)); }
      finally { close(processHandle); }
    },
    active(job) {
      const accounting = Buffer.alloc(48);
      if (!query(job, 1, accounting, accounting.length, null)) throw new Error('Windows Job 状态读取失败');
      return accounting.readUInt32LE(40);
    },
    terminate(job) { if (!terminate(job, 1)) throw new Error('Windows Job 终止失败'); },
    close(job) { if (!close(job)) throw new Error('Windows Job 句柄关闭失败'); },
  };
}

/** Circle's approval and Job design supplies no kernel network/write boundary for Hub. */
export function windowsIsolationFailure(): string {
  return 'windows_kernel_network_write_isolation_unimplemented';
}
