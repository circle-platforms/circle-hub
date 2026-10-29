// Design adapted from Circle src/windows_stranded.ts at 25863be04d2b169b5d776d7ec21a76ccbd330738,
// Apache-2.0, Copyright (c) 2026 qingshanfeihu and the Circle contributors.
// See https://github.com/circle-platforms/circle. No archived module is imported.
// A Job contains descendants; it does not deny network access or filesystem writes.
import { randomUUID } from 'node:crypto';
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

export interface WindowsRestrictedToken {
  readonly handle: bigint;
  close(): void;
}

/** A write-restricted token primitive, not a complete network/exec isolation backend. */
export async function loadWindowsRestrictedToken(): Promise<WindowsRestrictedToken> {
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch))
    throw new Error('Windows 受限令牌仅支持原生 x64 或 ARM64');
  const { default: koffi } = await import('koffi');
  return createWindowsRestrictedToken(koffi);
}

/** No impersonation, privilege enabling, account login, or credential-store access. */
export function createWindowsRestrictedToken(koffi: {
  version: string;
  load(name: string): { func(declaration: string): (...args: unknown[]) => unknown };
}): WindowsRestrictedToken {
  if (koffi.version !== '3.3.3') throw new Error('Windows 令牌的 koffi 版本不匹配');
  const kernel = koffi.load('kernel32.dll');
  const security = koffi.load('advapi32.dll');
  const current = kernel.func('void * __stdcall GetCurrentProcess()');
  const close = kernel.func('int __stdcall CloseHandle(void *handle)');
  const free = kernel.func('void * __stdcall LocalFree(void *memory)');
  const open = security.func('int __stdcall OpenProcessToken(void *process, uint32_t access, void *token)');
  const sidFromString = security.func('int __stdcall ConvertStringSidToSidW(void *text, void *sid)');
  const restrict = security.func('int __stdcall CreateRestrictedToken(void *existing, uint32_t flags, uint32_t disabledCount, void *disabled, uint32_t deletedCount, void *deleted, uint32_t restrictedCount, void *restricted, void *token)');
  const query = security.func('int __stdcall GetTokenInformation(void *token, uint32_t kind, void *data, uint32_t size, void *needed)');
  const equal = security.func('int __stdcall EqualSid(void *first, void *second)');
  const isRestricted = security.func('int __stdcall IsTokenRestricted(void *token)');
  const valid = (handle: bigint): boolean => handle !== 0n && BigInt.asIntN(64, handle) !== -1n;
  let original: bigint | undefined;
  let sid: bigint | undefined;
  let token: bigint | undefined;
  try {
    const output = Buffer.alloc(8);
    // TOKEN_DUPLICATE | TOKEN_QUERY. Never request privilege adjustment rights.
    if (!open(current(), 0xa, output)) throw new Error('Windows 当前进程令牌读取失败');
    original = output.readBigUInt64LE();
    if (!valid(original)) throw new Error('Windows 当前进程令牌无效');
    output.fill(0);
    // RESTRICTED (S-1-5-12) is the well-known SID that system objects grant to restricted code; a write needs a grant
    // to it as well as the normal check. The NULL SID (no grants) was tried first: with an AppContainer every process,
    // even one with no other mitigation, then failed DLL initialisation (0xC0000142, issue 73). AppContainer SIDs are
    // rejected as restricting SIDs (87). Actual write denial still requires native behavioral validation.
    if (!sidFromString(Buffer.from('S-1-5-12\0', 'utf16le'), output)) throw new Error('Windows 限制 SID 创建失败');
    sid = output.readBigUInt64LE();
    if (!valid(sid)) throw new Error('Windows 限制 SID 无效');
    const entry = Buffer.alloc(16); // SID_AND_ATTRIBUTES on both supported 64-bit ABIs.
    entry.writeBigUInt64LE(sid);
    output.fill(0);
    // DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED; no SANDBOX_INERT or LUA fallback.
    if (!restrict(original, 0x9, 0, null, 0, null, 1, entry, output)) throw new Error('Windows 受限令牌创建失败');
    token = output.readBigUInt64LE();
    if (!valid(token) || !isRestricted(token)) throw new Error('Windows 受限令牌核验失败');
    // Verify the exact derived restricting SID, not merely TokenHasRestrictions.
    const groups = Buffer.alloc(4096);
    const needed = Buffer.alloc(4);
    if (!query(token, 11, groups, groups.length, needed) || needed.readUInt32LE() < 24 ||
        needed.readUInt32LE() > groups.length || groups.readUInt32LE() !== 1 ||
        !equal(groups.readBigUInt64LE(8), sid)) throw new Error('Windows 受限 SID 核验失败');
    const owned = token;
    let closed = false;
    token = undefined;
    return {
      get handle() { if (closed) throw new Error('Windows 受限令牌已关闭'); return owned; },
      close() {
        if (closed) return;
        if (!close(owned)) throw new Error('Windows 受限令牌关闭失败');
        closed = true;
      },
    };
  } finally {
    if (token !== undefined && valid(token)) close(token);
    if (sid !== undefined && valid(sid)) free(sid);
    if (original !== undefined && valid(original)) close(original);
  }
}

/** Windows argv quoting; no command shell is involved. */
export function quoteWindowsArgument(value: string): string {
  if (value.includes('\0')) throw new TypeError('Windows 参数含空字符');
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}

// Windows needs these to start a process (libuv adds the same kind of set to every spawn), and kernelbase
// derives the AppContainer folders from the profile ones; an empty block fails with ERROR_ENVVAR_NOT_FOUND.
// Only non-secret system and profile locations are copied; every other parent variable stays out.
const windowsProbeEnvironment = [
  'APPDATA', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP',
  'USERPROFILE', 'WINDIR',
] as const;

/** A sorted CREATE_UNICODE_ENVIRONMENT block holding only the fixed allow-list, read case-insensitively. */
export function windowsEnvironmentBlock(environment: Record<string, string | undefined>): Buffer {
  const values = new Map<string, string>();
  for (const [name, value] of Object.entries(environment)) {
    const key = name.toUpperCase();
    if (value === undefined || !(windowsProbeEnvironment as readonly string[]).includes(key) || values.has(key)) continue;
    if (value === '' || value.includes('\0')) throw new TypeError('Windows 环境变量无效');
    values.set(key, value);
  }
  if (!values.has('SYSTEMROOT')) throw new Error('Windows 环境缺少 SystemRoot');
  const entries = [...values].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return Buffer.from(entries.map(([name, value]) => `${name}=${value}\0`).join('') + '\0', 'utf16le');
}

export function windowsProbeFailure(stage: string, code: number, diagnostics: {
  executableExists: boolean; executableBinary: boolean; directoryExists: boolean;
}): Error {
  // Only stages and bounded primitive observations; no paths, command/source, SID, token or environment.
  return new Error(`Windows LPAC ${stage}失败 (${code}); ${JSON.stringify({
    executableExists: diagnostics.executableExists === true,
    executableBinary: diagnostics.executableBinary === true,
    directoryExists: diagnostics.directoryExists === true,
  })}`);
}

/**
 * Trusted synthetic probe launcher only: no pack integration or readiness claim.
 * A suspended LPAC is checked and assigned before any supplied JavaScript runs.
 */
export async function runWindowsIsolationProbe(source: string): Promise<number> {
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) throw new Error('Windows LPAC 平台不可用');
  if (source.length > 8192 || source.includes('\0')) throw new TypeError('Windows 探针代码无效');
  const { default: koffi } = await import('koffi');
  if (koffi.version !== '3.3.3') throw new Error('Windows LPAC 的 koffi 版本不匹配');
  const kernel = koffi.load('kernel32.dll');
  const security = koffi.load('advapi32.dll');
  const systemDirectory = kernel.func('uint32_t __stdcall GetSystemDirectoryW(void *buffer, uint32_t size)');
  const system = Buffer.alloc(65536);
  const systemLength = Number(systemDirectory(system, system.length / 2));
  if (!systemLength || systemLength >= system.length / 2) throw new Error('Windows 系统目录读取失败');
  const directory = system.subarray(0, systemLength * 2).toString('utf16le');
  // userenv is not assumed to be a KnownDLL: use the kernel-reported protected directory.
  const userenv = koffi.load(directory + '\\userenv.dll');
  const createProfile = userenv.func('int32_t __stdcall CreateAppContainerProfile(void *name, void *display, void *description, void *capabilities, uint32_t count, void *sid)');
  const deleteProfile = userenv.func('int32_t __stdcall DeleteAppContainerProfile(void *name)');
  const freeSid = security.func('void * __stdcall FreeSid(void *sid)');
  const initialize = kernel.func('int __stdcall InitializeProcThreadAttributeList(void *list, uint32_t count, uint32_t flags, void *size)');
  const update = kernel.func('int __stdcall UpdateProcThreadAttribute(void *list, uint32_t flags, uintptr_t kind, void *value, uintptr_t size, void *previous, void *returned)');
  const deleteAttributes = kernel.func('void __stdcall DeleteProcThreadAttributeList(void *list)');
  const heap = kernel.func('void * __stdcall GetProcessHeap()')();
  const allocate = kernel.func('void * __stdcall HeapAlloc(void *heap, uint32_t flags, uintptr_t size)');
  const release = kernel.func('int __stdcall HeapFree(void *heap, uint32_t flags, void *memory)');
  const copy = kernel.func('void __stdcall RtlMoveMemory(void *target, void *source, uintptr_t size)');
  const create = security.func('int __stdcall CreateProcessAsUserW(void *token, void *application, void *command, void *processSecurity, void *threadSecurity, int inherit, uint32_t flags, void *environment, void *directory, void *startup, void *information)');
  const openToken = security.func('int __stdcall OpenProcessToken(void *process, uint32_t rights, void *token)');
  const query = security.func('int __stdcall GetTokenInformation(void *token, uint32_t kind, void *data, uint32_t size, void *needed)');
  const equal = security.func('int __stdcall EqualSid(void *left, void *right)');
  const resume = kernel.func('uint32_t __stdcall ResumeThread(void *thread)');
  const terminate = kernel.func('int __stdcall TerminateProcess(void *process, uint32_t code)');
  const wait = kernel.func('uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t timeout)');
  const exitCode = kernel.func('int __stdcall GetExitCodeProcess(void *process, void *code)');
  const close = kernel.func('int __stdcall CloseHandle(void *handle)');
  const lastError = kernel.func('uint32_t __stdcall GetLastError()');
  const createFile = kernel.func('void * __stdcall CreateFileW(void *name, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *template)');
  const localFree = kernel.func('void * __stdcall LocalFree(void *memory)');
  // kernelbase is a KnownDLL; no caller-controlled path is consulted.
  const deriveCapability = koffi.load('kernelbase.dll').func('int __stdcall DeriveCapabilitySidsFromName(void *name, void *groupSids, void *groupCount, void *sids, void *count)');
  const diagnostics = { executableExists: false, executableBinary: false, directoryExists: false };
  const failed = (stage: string, code = Number(lastError())): never => {
    throw windowsProbeFailure(stage, code, diagnostics);
  };
  const valid = (value: unknown): value is bigint => typeof value === 'bigint' && value !== 0n && BigInt.asIntN(64, value) !== -1n;
  const w = (value: string): Buffer => Buffer.from(value + '\0', 'utf16le');
  const allocations: bigint[] = [];
  const native = (buffer: Buffer): bigint => {
    const pointer: unknown = allocate(heap, 8, buffer.length);
    if (!valid(pointer)) return failed('分配');
    allocations.push(pointer);
    copy(pointer, buffer, buffer.length);
    return pointer;
  };
  const profileName = 'circle-hub.probe.' + randomUUID();
  let profileCreated = false;
  let sid: bigint | undefined;
  let attributes: bigint | undefined;
  let attributesInitialized = false;
  let processHandle: bigint | undefined;
  let thread: bigint | undefined;
  let childToken: bigint | undefined;
  let nul: bigint | undefined;
  let capabilityArrays: { groups: bigint; groupCount: number; sids: bigint; count: number } | undefined;
  let job: { stop(): Promise<void> } | undefined;
  const restricted = createWindowsRestrictedToken(koffi);
  let launchFailure: unknown;
  try {
    const output = Buffer.alloc(8);
    // Deriving a SID alone does not create the profile Windows needs at launch.
    // A unique temporary profile prevents reuse or deletion of any existing profile.
    const profileResult = Number(createProfile(w(profileName), w('Hub synthetic probe'), w('Temporary isolated fixture'), null, 0, output));
    if (profileResult !== 0) failed('临时 profile 创建', profileResult);
    profileCreated = true;
    sid = output.readBigUInt64LE();
    if (!valid(sid)) failed('包 SID');
    // The single capability: registryRead. Zero-capability LPAC cannot read the Winsock catalog, so WSAStartup fails
    // (10107) and Node aborts before running any code (issue 73). The capability grants registry reads only where a key's
    // DACL grants it; it adds no network, file or device capability.
    const groupsOut = Buffer.alloc(8), groupCountOut = Buffer.alloc(4), sidsOut = Buffer.alloc(8), countOut = Buffer.alloc(4);
    if (!deriveCapability(w('registryRead'), groupsOut, groupCountOut, sidsOut, countOut)) failed('能力 SID 派生');
    capabilityArrays = { groups: groupsOut.readBigUInt64LE(), groupCount: groupCountOut.readUInt32LE(), sids: sidsOut.readBigUInt64LE(), count: countOut.readUInt32LE() };
    if (capabilityArrays.count !== 1 || !valid(capabilityArrays.sids)) failed('能力 SID 数量', -2);
    const capabilityPointer = Buffer.alloc(8);
    copy(capabilityPointer, capabilityArrays.sids, 8);
    const registryRead = capabilityPointer.readBigUInt64LE();
    if (!valid(registryRead)) failed('能力 SID', -2);
    // Inheritable NUL device handle for stdin, stdout and stderr; it is the only handle the child inherits.
    const inheritable = Buffer.alloc(24); // SECURITY_ATTRIBUTES, bInheritHandle = TRUE.
    inheritable.writeUInt32LE(inheritable.length);
    inheritable.writeUInt32LE(1, 16);
    const nulHandle: unknown = createFile(w('\\\\.\\NUL'), 0xc0000000, 3, inheritable, 3, 0, null);
    if (!valid(nulHandle)) return failed('NUL 打开');
    nul = nulHandle;
    const nulDevice: bigint = nulHandle;
    const size = Buffer.alloc(8);
    initialize(null, 4, 0, size);
    const bytes = Number(size.readBigUInt64LE());
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 65536) failed('属性大小');
    attributes = native(Buffer.alloc(bytes));
    if (!initialize(attributes, 4, 0, size)) failed('属性初始化');
    attributesInitialized = true;
    const capabilityList = Buffer.alloc(16); // One SID_AND_ATTRIBUTES, SE_GROUP_ENABLED.
    capabilityList.writeBigUInt64LE(registryRead);
    capabilityList.writeUInt32LE(4, 8);
    const capabilities = Buffer.alloc(24); // SECURITY_CAPABILITIES with the single capability above.
    capabilities.writeBigUInt64LE(sid);
    capabilities.writeBigUInt64LE(native(capabilityList), 8);
    capabilities.writeUInt32LE(1, 16);
    const one = Buffer.alloc(4); one.writeUInt32LE(1);
    const handles = Buffer.alloc(8); handles.writeBigUInt64LE(nulDevice);
    // No Win32k system-call lockdown: Node statically imports USER32, and under that mitigation node.exe (and whoami.exe)
    // fail DLL initialisation (0xC0000142) even with no other restriction (issue 73). The handle list limits
    // inheritance to the NUL handle.
    for (const [kind, value] of [[0x20009, capabilities], [0x2000f, one], [0x2000e, one], [0x20002, handles]] as const) {
      const pointer = native(value);
      if (!update(attributes, 0, kind, pointer, value.length, null, null)) failed('属性设置');
    }
    const startup = Buffer.alloc(112); // STARTUPINFOEXW, x64/ARM64.
    startup.writeUInt32LE(startup.length);
    startup.writeUInt32LE(0x100, 60); // STARTF_USESTDHANDLES
    startup.writeBigUInt64LE(nulDevice, 80);
    startup.writeBigUInt64LE(nulDevice, 88);
    startup.writeBigUInt64LE(nulDevice, 96);
    startup.writeBigUInt64LE(attributes, 104);
    const info = Buffer.alloc(24);
    const getAttributes = kernel.func('uint32_t __stdcall GetFileAttributesW(void *path)');
    const getBinaryType = kernel.func('int __stdcall GetBinaryTypeW(void *path, void *kind)');
    diagnostics.executableExists = getAttributes(w(process.execPath)) !== 0xffffffff;
    diagnostics.directoryExists = getAttributes(w(directory)) !== 0xffffffff;
    const binary = Buffer.alloc(4);
    diagnostics.executableBinary = Boolean(getBinaryType(w(process.execPath), binary));
    if (!diagnostics.executableExists || !diagnostics.executableBinary || !diagnostics.directoryExists) failed('父侧路径预检');
    const command = w([process.execPath, '--no-addons', '--no-experimental-websocket', '-e', source].map(quoteWindowsArgument).join(' '));
    // CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | DETACHED_PROCESS.
    // No console: with CREATE_NO_WINDOW the system must start a console host for the child, which the child-process
    // restriction refuses, and the child failed DLL initialisation (0xC0000142, issue 73). Node needs valid standard
    // handles when detached (it aborts otherwise), so all three are the NUL device.
    // Only the NUL handle is inherited; no shell, no pack bytes, and only the allow-listed system and profile locations.
    const environment = windowsEnvironmentBlock(process.env);
    if (!create(restricted.handle, w(process.execPath), command, null, null, 1, 0x0008040c,
      environment, w(directory), startup, info)) failed('挂起创建');
    processHandle = info.readBigUInt64LE();
    thread = info.readBigUInt64LE(8);
    if (!valid(processHandle) || !valid(thread)) failed('进程句柄');
    const tokenOut = Buffer.alloc(8);
    if (!openToken(processHandle, 8, tokenOut)) failed('子令牌读取');
    childToken = tokenOut.readBigUInt64LE();
    if (!valid(childToken)) failed('子令牌句柄');
    const tokenInfo = (handle: bigint, kind: number): Buffer => {
      const data = Buffer.alloc(65536), needed = Buffer.alloc(4);
      if (!query(handle, kind, data, data.length, needed) || needed.readUInt32LE() > data.length) failed(`子令牌核验 ${kind}`);
      return data;
    };
    // TokenSecurityAttributes returns TOKEN_SECURITY_ATTRIBUTES_INFORMATION, whose V1 entries name themselves
    // with a UNICODE_STRING (40 bytes each on x64/ARM64). It holds absolute pointers, so it is read from a
    // native block whose base address is known, and every pointer is bounds-checked before it is followed.
    const tokenSecurityAttribute = (handle: bigint, expected: string): true => {
      const length = 65536, needed = Buffer.alloc(4);
      const base = native(Buffer.alloc(length));
      if (!query(handle, 39, base, length, needed) || needed.readUInt32LE() > length) failed('子令牌核验 39');
      const data = Buffer.alloc(length);
      copy(data, base, length);
      const offset = (pointer: bigint, size: number): number => {
        const at = pointer - base;
        if (at < 0n || at + BigInt(size) > BigInt(length)) failed('安全属性越界', -2);
        return Number(at);
      };
      const count = data.readUInt32LE(4);
      if (data.readUInt16LE(0) !== 1 || count > 1024) failed('安全属性数量', -2);
      const entries = count === 0 ? 0 : offset(data.readBigUInt64LE(8), count * 40);
      for (let index = 0; index < count; index++) {
        const entry = entries + index * 40;
        const size = data.readUInt16LE(entry);
        if (size % 2 !== 0) failed('安全属性名称', -2);
        const name = size === 0 ? 0 : offset(data.readBigUInt64LE(entry + 8), size);
        if (data.subarray(name, name + size).toString('utf16le') === expected) return true;
      }
      // Only the attribute count is reported; names and values stay out of the diagnostic.
      return failed('LPAC 属性核验', count);
    };
    // TokenIsAppContainer, TokenCapabilities (none) and TokenAppContainerSid.
    if (tokenInfo(childToken, 29).readUInt32LE() !== 1) failed('AppContainer 核验', -2);
    // TOKEN_GROUPS: exactly the registryRead capability, nothing else.
    const capabilityGroups = tokenInfo(childToken, 30);
    if (capabilityGroups.readUInt32LE() !== 1 || !equal(capabilityGroups.readBigUInt64LE(8), registryRead)) failed('能力列表核验', -2);
    if (!equal(tokenInfo(childToken, 31).readBigUInt64LE(), sid)) failed('包 SID 核验', -2);
    // Querying TokenIsLessPrivilegedAppContainer (46) and TokenChildProcessFlags (45) together with the classes
    // above failed with ERROR_INVALID_PARAMETER (87) on both Windows runners. Read both policies where the
    // kernel records them instead:
    // TOKEN_ACCESS_INFORMATION.Flags carries TOKEN_LOWBOX (0x4000) and TOKEN_NO_CHILD_PROCESS (0x80000),
    // and an LPAC token carries the WIN://NOALLAPPPKG security attribute.
    const access = tokenInfo(childToken, 22).readUInt32LE(44);
    if ((access & 0x84000) !== 0x84000) failed('子进程限制核验', access);
    tokenSecurityAttribute(childToken, 'WIN://NOALLAPPPKG');
    const before = tokenInfo(restricted.handle, 11), after = tokenInfo(childToken, 11);
    if (before.readUInt32LE() !== 1 || after.readUInt32LE() !== 1 ||
        !equal(before.readBigUInt64LE(8), after.readBigUInt64LE(8))) failed('写限制 SID 核验');
    const api = createWindowsJobApi(koffi);
    job = attachWindowsJob(api, info.readUInt32LE(16), { userCpuSeconds: 5, committedBytes: 512 * 1024 * 1024 });
    if (resume(thread) !== 1) failed('恢复');
    const deadline = Date.now() + 10_000;
    for (;;) {
      const state = wait(processHandle, 0);
      if (state === 0) break;
      if (state !== 0x102) failed('退出观察');
      if (Date.now() >= deadline) throw new Error('Windows LPAC 探针超时');
      await delay(10);
    }
    const code = Buffer.alloc(4);
    if (!exitCode(processHandle, code)) failed('退出码');
    return code.readUInt32LE();
  } catch (error) {
    launchFailure = error;
    throw error;
  } finally {
    // A rejected setup can only leave a suspended process; never resume to clean it up.
    let cleanupFailure: Error | undefined;
    if (processHandle !== undefined && valid(processHandle)) {
      if (wait(processHandle, 0) !== 0) {
        if (!terminate(processHandle, 1) && wait(processHandle, 0) !== 0) cleanupFailure = new Error('Windows LPAC 终止失败');
        const deadline = Date.now() + 10_000;
        while (wait(processHandle, 0) === 0x102 && Date.now() < deadline) await delay(10);
        if (wait(processHandle, 0) !== 0) cleanupFailure = new Error('Windows LPAC 退出未确认');
      }
    }
    const cleanupFailures: Error[] = cleanupFailure ? [cleanupFailure] : [];
    const cleanup = (stage: string, operation: () => boolean): void => {
      try { if (!operation()) cleanupFailures.push(windowsProbeFailure(stage, Number(lastError()), diagnostics)); }
      catch { cleanupFailures.push(windowsProbeFailure(stage, -1, diagnostics)); }
    };
    try { if (job) await job.stop(); }
    catch { cleanupFailures.push(windowsProbeFailure('Job 清理', -1, diagnostics)); }
    if (childToken !== undefined && valid(childToken)) cleanup('子令牌关闭', () => Boolean(close(childToken)));
    if (thread !== undefined && valid(thread)) cleanup('线程关闭', () => Boolean(close(thread)));
    if (nul !== undefined && valid(nul)) cleanup('NUL 关闭', () => Boolean(close(nul)));
    if (processHandle !== undefined && valid(processHandle)) cleanup('进程关闭', () => Boolean(close(processHandle)));
    if (attributesInitialized) cleanup('属性删除', () => { deleteAttributes(attributes!); return true; });
    for (const pointer of allocations.reverse()) cleanup('内存释放', () => Boolean(release(heap, 0, pointer)));
    if (capabilityArrays !== undefined) {
      // DeriveCapabilitySidsFromName returns LocalAlloc'd SIDs and arrays.
      const { groups, groupCount, sids, count } = capabilityArrays;
      for (const [array, length] of [[groups, groupCount], [sids, count]] as const) {
        if (!valid(array)) continue;
        for (let index = 0; index < length && index < 64; index++) {
          const entry = Buffer.alloc(8);
          copy(entry, array + BigInt(index * 8), 8);
          const pointer = entry.readBigUInt64LE();
          if (valid(pointer)) cleanup('能力 SID 释放', () => { const result = localFree(pointer); return result === null || result === 0n; });
        }
        cleanup('能力数组释放', () => { const result = localFree(array); return result === null || result === 0n; });
      }
    }
    if (sid !== undefined && valid(sid)) cleanup('SID 释放', () => { const result = freeSid(sid); return result === null || result === 0n; });
    cleanup('受限令牌关闭', () => { restricted.close(); return true; });
    if (profileCreated) {
      try {
        const profileResult = Number(deleteProfile(w(profileName)));
        if (profileResult !== 0) cleanupFailures.push(windowsProbeFailure('临时 profile 删除', profileResult, diagnostics));
      } catch { cleanupFailures.push(windowsProbeFailure('临时 profile 删除', -1, diagnostics)); }
    }
    if (cleanupFailures.length) throw new AggregateError(launchFailure instanceof Error ? [launchFailure, ...cleanupFailures] : cleanupFailures, 'Windows LPAC 清理未确认，结果未知');
  }
}
