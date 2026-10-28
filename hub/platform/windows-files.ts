// Windows-only OS boundary. All paths are local drive paths; every ancestor is pinned without write/delete sharing.
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { win32 } from 'node:path';
import { PlatformError } from './errors.ts';

export interface WindowsPrivateFiles {
  readonly sid: string;
  read(name: string): Uint8Array | undefined;
  create(name: string, value: Uint8Array): void;
  remove(name: string): boolean;
}
const require = createRequire(import.meta.url);
const READ_CONTROL = 0x20000;
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const DELETE = 0x10000;
const FILE_ALL_ACCESS = 0x1f01ff;
const OPEN_EXISTING = 3;
const CREATE_NEW = 1;
const OPEN_REPARSE_POINT = 0x200000;
const BACKUP_SEMANTICS = 0x2000000;
const MAX_FILE = 128 * 1024;
export interface WindowsVaultFiles extends WindowsPrivateFiles {
  createIfMissing(name: string, value: Uint8Array): boolean;
  replace(name: string, value: Uint8Array): void;
  stat(name: string): { written_at: string } | null;
  list(): string[];
}
type Pointer = bigint | null;

/** Runs only after CREATE_NEW succeeded. Rollback acts on that same exclusive handle, never a pathname. */
export function finishWindowsPrivateCreate(size: number, operations: {
  write(): number;
  flush(): boolean;
  discard(): boolean;
}): void {
  try {
    if (operations.write() !== size || !operations.flush()) throw new Error('incomplete write');
  } catch {
    let discarded = false;
    try { discarded = operations.discard(); } catch { /* Preserve the original failure without native exception text. */ }
    if (!discarded) {
      throw new PlatformError('Windows 密钥条目写入未完成，原生删除也未确认；已停止，不覆盖或重新生成密钥', '保持服务停止，由操作者检查并处理这次新建的损坏条目后重试');
    }
    throw new PlatformError('Windows 密钥条目写入未完成；已在原创建句柄上标记删除，没有覆盖已有密钥');
  }
}

/** The verified target stays untouched when rename is rejected; discard can only act on the new temporary handle. */
export function commitWindowsPrivateReplace(operations: { rename(): boolean; discard(): boolean }): void {
  let committed = false;
  try { committed = operations.rename(); } catch { /* Report the state without native exception text. */ }
  if (committed) return;
  let discarded = false;
  try { discarded = operations.discard(); } catch { /* Cleanup remains explicitly unconfirmed. */ }
  if (!discarded) throw new PlatformError('Windows 密钥库原子替换失败，临时密文删除未确认；停止并由操作者检查');
  throw new PlatformError('Windows 密钥库原子替换失败；临时密文已标记删除，没有覆盖已有条目');
}

/** Never uses chmod, environment identity, PowerShell or an inherited DACL as a Windows security boundary. */
export function windowsPrivateFiles(directory: string, onStep?: (step: string) => void, expectedSid?: string): WindowsVaultFiles {
  // Diagnostics receive literal operation names only, never native arguments or results.
  const native = <T>(step: string, operation: () => T): T => {
    onStep?.(`${step}:begin`);
    const result = operation();
    // Sync diagnostic output can call Win32 APIs. Preserve the operation's error before emitting its completion.
    const error = lastError();
    onStep?.(`${step}:end`);
    setLastError(error);
    return result;
  };
  if (process.platform !== 'win32') throw new PlatformError('Windows 私有存储只可在 Windows 上使用');
  const koffi = require('koffi') as typeof import('koffi');
  if (koffi.version !== '3.3.3') throw new PlatformError('Windows 私有存储需要 koffi 3.3.3');
  if (!/^[A-Za-z]:\\/.test(directory) || directory.includes('/') || directory.length > 240) throw new PlatformError('Windows 私有存储必须使用本地盘的完整路径');
  const parsed = win32.parse(directory);
  const components = directory.slice(parsed.root.length).split('\\');
  if (components.length === 0 || components.some((part) => !part || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || part === '.' || part === '..')) {
    throw new PlatformError('Windows 私有存储路径含不支持的路径分量');
  }
  const kernel = koffi.load('kernel32.dll');
  const fn = (definition: string) => kernel.func(definition);
  const close = fn('int32_t __stdcall CloseHandle(void *handle)');
  const lastError = fn('uint32_t __stdcall GetLastError()');
  const setLastError = fn('void __stdcall SetLastError(uint32_t code)');
  const currentProcess = fn('void * __stdcall GetCurrentProcess()');
  const currentThread = fn('void * __stdcall GetCurrentThread()');
  const getSystemDirectory = fn('uint32_t __stdcall GetSystemDirectoryW(_Out_ char16_t *buffer, uint32_t size)');
  const systemBuffer = Buffer.alloc(65536);
  const systemLength = native('system-directory', () => getSystemDirectory(systemBuffer, 32768)) as number;
  if (!systemLength || systemLength >= 32768) throw new PlatformError('无法确定 Windows 系统目录');
  const systemDirectory = systemBuffer.toString('utf16le', 0, systemLength * 2);
  const advapi = koffi.load(`${systemDirectory}\\advapi32.dll`);
  const userenv = koffi.load(`${systemDirectory}\\userenv.dll`);
  const openProcessToken = advapi.func('int32_t __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)');
  const openThreadToken = advapi.func('int32_t __stdcall OpenThreadToken(void *thread, uint32_t access, int32_t openAsSelf, _Out_ void **token)');
  const getTokenInformation = advapi.func('int32_t __stdcall GetTokenInformation(void *token, uint32_t informationClass, _Out_ void *information, uint32_t size, _Out_ uint32_t *returned)');
  const sidToString = advapi.func('int32_t __stdcall ConvertSidToStringSidW(void *sid, _Out_ void **text)');
  const localFree = fn('void * __stdcall LocalFree(void *memory)');
  const regOpen = advapi.func('int32_t __stdcall RegOpenKeyExW(void *key, str16 name, uint32_t options, uint32_t access, _Out_ void **result)');
  const regClose = advapi.func('int32_t __stdcall RegCloseKey(void *key)');
  const getProfile = userenv.func('int32_t __stdcall GetUserProfileDirectoryW(void *token, _Out_ char16_t *path, _Inout_ uint32_t *size)');
  const reject = (): never => { throw new PlatformError('Windows 私有存储的身份、用户配置或访问控制未通过原生检查'); };
  const noImpersonation = () => {
    const thread: Pointer[] = [null];
    if (native('thread-token', () => openThreadToken(currentThread(), 8, 1, thread))) { if (thread[0]) close(thread[0]); reject(); }
    if (lastError() !== 1008) reject(); // ERROR_NO_TOKEN is the only accepted result.
  };
  noImpersonation();
  const token: Pointer[] = [null];
  if (!native('process-token', () => openProcessToken(currentProcess(), 8, token)) || !token[0]) reject();
  let sid: string;
  let tokenInfo: Buffer;
  let userSid: Pointer;
  let profile: string;
  try {
    const needed = [0];
    native('token-user-size', () => getTokenInformation(token[0], 1, null, 0, needed)); // TokenUser
    if (needed[0]! < 8 || needed[0]! > 65536) reject();
    tokenInfo = Buffer.alloc(needed[0]!);
    if (!native('token-user', () => getTokenInformation(token[0], 1, tokenInfo, tokenInfo.length, needed))) reject();
    userSid = native('decode-token-user-pointer', () => koffi.decode(tokenInfo, 'void *')) as Pointer;
    const text: Pointer[] = [null];
    if (!userSid || !native('sid-to-string', () => sidToString(userSid, text)) || !text[0]) reject();
    // text[0] already is LPWSTR. Generic decode(..., 'str16') would read a second pointer from the UTF-16 bytes.
    try { sid = native('decode-sid-string', () => koffi.decode.string16(text[0])); } finally { localFree(text[0]); }
    if (expectedSid !== undefined && expectedSid !== sid) throw new PlatformError('Windows 服务配置的身份与当前原生进程身份不一致，拒绝访问密钥库');
    const profileBuffer = Buffer.alloc(65536);
    const size = [32768];
    if (!native('profile-directory', () => getProfile(token[0], profileBuffer, size)) || size[0]! < 2 || size[0]! > 32768) reject();
    profile = profileBuffer.toString('utf16le', 0, (size[0]! - 1) * 2);
    if (!/^[A-Za-z]:\\/.test(profile)) reject();
  } finally { close(token[0]); }
  // HKEY_USERS is sign extended on 64-bit Windows. An existing profile path alone does not establish a loaded hive.
  const loadedProfile = () => {
    noImpersonation();
    const hive: Pointer[] = [null];
    if (native('profile-hive-open', () => regOpen(0xffffffff80000003n, sid, 0, 0x20019, hive)) !== 0 || !hive[0]) reject();
    native('profile-hive-close', () => regClose(hive[0]));
  };
  loadedProfile();
  const rootPrefix = `${profile.toLowerCase()}\\`;
  if (!directory.toLowerCase().startsWith(rootPrefix)) throw new PlatformError('Windows 私有存储必须位于当前服务用户的配置目录下');
  const sddlToDescriptor = advapi.func('int32_t __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16 text, uint32_t revision, _Out_ void **descriptor, void *size)');
  const getSecurityInfo = advapi.func('uint32_t __stdcall GetSecurityInfo(void *handle, uint32_t type, uint32_t information, _Out_ void **owner, void *group, _Out_ void **dacl, void *sacl, _Out_ void **descriptor)');
  const getControl = advapi.func('int32_t __stdcall GetSecurityDescriptorControl(void *descriptor, _Out_ uint16_t *control, _Out_ uint32_t *revision)');
  const equalSid = advapi.func('int32_t __stdcall EqualSid(void *left, void *right)');
  const aclInfoType = koffi.struct({ AceCount: 'uint32_t', AclBytesInUse: 'uint32_t', AclBytesFree: 'uint32_t' });
  const getAclInfo = advapi.func('__stdcall', 'GetAclInformation', 'int32_t', ['void *', koffi.out(koffi.pointer(aclInfoType)), 'uint32_t', 'uint32_t']);
  const getAce = advapi.func('int32_t __stdcall GetAce(void *acl, uint32_t index, _Out_ void **ace)');
  const attributesType = koffi.struct({ nLength: 'uint32_t', lpSecurityDescriptor: 'void *', bInheritHandle: 'int32_t' });
  const createFile = kernel.func('__stdcall', 'CreateFileW', 'void *', ['str16', 'uint32_t', 'uint32_t', koffi.pointer(attributesType), 'uint32_t', 'uint32_t', 'void *']);
  const createDirectory = kernel.func('__stdcall', 'CreateDirectoryW', 'int32_t', ['str16', koffi.pointer(attributesType)]);
  const getFileInformation = fn('int32_t __stdcall GetFileInformationByHandle(void *handle, _Out_ void *information)');
  const fileSize = fn('int32_t __stdcall GetFileSizeEx(void *handle, _Out_ int64_t *size)');
  const readFile = fn('int32_t __stdcall ReadFile(void *handle, _Out_ void *buffer, uint32_t size, _Out_ uint32_t *read, void *overlapped)');
  const writeFile = fn('int32_t __stdcall WriteFile(void *handle, const void *buffer, uint32_t size, _Out_ uint32_t *written, void *overlapped)');
  const flush = fn('int32_t __stdcall FlushFileBuffers(void *handle)');
  const findFirst = fn('void * __stdcall FindFirstFileW(str16 pattern, _Out_ void *data)');
  const findNext = fn('int32_t __stdcall FindNextFileW(void *handle, _Out_ void *data)');
  const findClose = fn('int32_t __stdcall FindClose(void *handle)');
  const disposition = fn('int32_t __stdcall SetFileInformationByHandle(void *handle, uint32_t informationClass, const void *information, uint32_t size)');
  const valid = (handle: Pointer) => handle !== null && handle !== -1n && handle !== 0xffffffffffffffffn;
  const assertObject = (handle: Pointer, isDirectory: boolean, privateAcl: boolean) => {
    const information = Buffer.alloc(52); // BY_HANDLE_FILE_INFORMATION: 13 DWORDs on both supported ABIs.
    if (!native('file-information', () => getFileInformation(handle, information))) reject();
    const attrs = information.readUInt32LE(0);
    if ((attrs & 0x400) !== 0 || Boolean(attrs & 0x10) !== isDirectory) reject();
    if (!isDirectory && information.readUInt32LE(40) !== 1) reject(); // No hardlinked credentials.
    if (!privateAcl) return;
    // Keep the token's SID backing buffer alive for every native SID comparison.
    userSid = native('decode-token-user-pointer', () => koffi.decode(tokenInfo, 'void *')) as Pointer;
    const owner: Pointer[] = [null], dacl: Pointer[] = [null], descriptor: Pointer[] = [null];
    if (native('security-information', () => getSecurityInfo(handle, 1, 5, owner, null, dacl, null, descriptor)) !== 0 || !descriptor[0]) reject();
    try {
      const control = [0], revision = [0];
      if (!owner[0] || !native('compare-owner-sid', () => equalSid(owner[0], userSid)) || !dacl[0] || !native('security-descriptor-control', () => getControl(descriptor[0], control, revision)) || !(control[0]! & 0x1000)) reject();
      const info = { AceCount: 0, AclBytesInUse: 0, AclBytesFree: 0 };
      if (!native('acl-information', () => getAclInfo(dacl[0], info, koffi.sizeof(aclInfoType), 2)) || info.AceCount !== 1) reject();
      const ace: Pointer[] = [null];
      if (!native('acl-entry', () => getAce(dacl[0], 0, ace)) || !ace[0]) reject();
      // ACCESS_ALLOWED_ACE: header type/flags, mask, then SID. Accept only this user with explicit full control.
      if (koffi.decode(ace[0], 'uint8_t') !== 0 || koffi.decode(ace[0], 1, 'uint8_t') !== 0 || koffi.decode(ace[0], 4, 'uint32_t') !== FILE_ALL_ACCESS || !native('compare-entry-sid', () => equalSid(ace[0]! + 8n, userSid))) reject();
    } finally { localFree(descriptor[0]); }
  };
  const withDirectory = <T>(create: boolean, absent: T, operation: () => T): T => {
    loadedProfile();
    const handles: Pointer[] = [];
    const security: Pointer[] = [null];
    try {
      if (!native('create-security-descriptor', () => sddlToDescriptor(`O:${sid}D:P(A;;FA;;;${sid})`, 1, security, null)) || !security[0]) reject();
      const attributes = { nLength: koffi.sizeof(attributesType), lpSecurityDescriptor: security[0], bInheritHandle: 0 };
      let path = parsed.root;
      const all = [parsed.root, ...components.map((part) => { path = win32.join(path, part); return path; })];
      for (let index = 0; index < all.length; index++) {
        const root = index === all.length - 1;
        let handle = native('open-directory', () => createFile(all[index], READ_CONTROL | 0x80, 1, null, OPEN_EXISTING, OPEN_REPARSE_POINT | BACKUP_SEMANTICS, null)) as Pointer;
        if (!valid(handle) && root && lastError() === 2) {
          if (!create) return absent;
          if (!native('create-directory', () => createDirectory(all[index], attributes)) && lastError() !== 183) reject();
          handle = native('open-directory', () => createFile(all[index], READ_CONTROL | 0x80, 1, null, OPEN_EXISTING, OPEN_REPARSE_POINT | BACKUP_SEMANTICS, null)) as Pointer;
        }
        if (!valid(handle)) reject();
        handles.push(handle);
        assertObject(handle, true, root);
      }
      return operation();
    } finally {
      for (const handle of handles.reverse()) close(handle);
      if (security[0]) localFree(security[0]);
    }
  };
  const filePath = (name: string) => {
    if (!/^(?:key-check|[a-z0-9][a-z0-9._-]{0,99}\.sealed|[a-f0-9]{64}\.bin|[a-f0-9]{32}\.tmp)$/.test(name)) throw new PlatformError('Windows 私有存储条目名无效');
    return win32.join(directory, name);
  };
  const openExisting = (name: string, access: number, sharing = 0): Pointer | undefined => {
    const handle = native('open-existing-key-file', () => createFile(filePath(name), access | READ_CONTROL, sharing, null, OPEN_EXISTING, OPEN_REPARSE_POINT, null)) as Pointer;
    if (!valid(handle)) { if (lastError() === 2) return undefined; reject(); }
    try { assertObject(handle, false, true); } catch (error) { close(handle); throw error; }
    return handle;
  };
  const createEntry = (name: string, value: Uint8Array): boolean => {
    if (value.length < 1 || value.length > MAX_FILE) throw new PlatformError('Windows 私有存储条目长度无效');
    return withDirectory(true, false, () => {
      const security: Pointer[] = [null];
      if (!native('create-security-descriptor', () => sddlToDescriptor(`O:${sid}D:P(A;;FA;;;${sid})`, 1, security, null)) || !security[0]) reject();
      let handle: Pointer = null;
      try {
        const attributes = { nLength: koffi.sizeof(attributesType), lpSecurityDescriptor: security[0], bInheritHandle: 0 };
        handle = native('create-new-key-file', () => createFile(filePath(name), GENERIC_WRITE | READ_CONTROL | DELETE, 0, attributes, CREATE_NEW, OPEN_REPARSE_POINT, null)) as Pointer;
        if (!valid(handle)) {
          const error = lastError();
          if (error === 80 || error === 183) {
            const existing = openExisting(name, 0x80);
            if (existing === undefined) reject();
            close(existing);
            return false;
          }
          throw new PlatformError('Windows 密钥条目创建失败；已有条目不会覆盖');
        }
        finishWindowsPrivateCreate(value.length, {
          write() {
            assertObject(handle, false, true);
            const count = [0];
            if (!native('write-key-file', () => writeFile(handle, value, value.length, count, null))) reject();
            return count[0]!;
          },
          flush() { return Boolean(native('flush-key-file', () => flush(handle))); },
          discard() { return Boolean(native('discard-incomplete-key-file', () => disposition(handle, 4, Buffer.from([1]), 1))); },
        });
        return true;
      } finally { if (valid(handle)) close(handle); localFree(security[0]); }
    });
  };
  return {
    sid,
    read(name) {
      return withDirectory(false, undefined, () => {
        const handle = openExisting(name, GENERIC_READ);
        if (handle === undefined) return undefined;
        try {
          const size: (bigint | number)[] = [0n];
          if (!native('key-file-size', () => fileSize(handle, size)) || BigInt(size[0]!) < 1n || BigInt(size[0]!) > BigInt(MAX_FILE)) reject();
          const bytes = Buffer.alloc(Number(size[0]));
          const count = [0];
          if (!native('read-key-file', () => readFile(handle, bytes, bytes.length, count, null)) || count[0] !== bytes.length) reject();
          return bytes;
        } finally { close(handle); }
      });
    },
    create(name, value) {
      if (!createEntry(name, value)) throw new PlatformError('Windows 密钥条目已经存在，不覆盖');
    },
    createIfMissing: createEntry,
    replace(name, value) {
      if (value.length < 1 || value.length > MAX_FILE) throw new PlatformError('Windows 私有存储条目长度无效');
      withDirectory(true, undefined, () => {
        // An existing target is verified and retained with DELETE sharing only during the atomic rename.
        const target = openExisting(name, DELETE, 4);
        const temporary = `${randomBytes(16).toString('hex')}.tmp`;
        const security: Pointer[] = [null];
        let handle: Pointer = null;
        try {
          if (!native('create-security-descriptor', () => sddlToDescriptor(`O:${sid}D:P(A;;FA;;;${sid})`, 1, security, null)) || !security[0]) reject();
          const attributes = { nLength: koffi.sizeof(attributesType), lpSecurityDescriptor: security[0], bInheritHandle: 0 };
          handle = native('create-vault-temporary', () => createFile(filePath(temporary), GENERIC_WRITE | READ_CONTROL | DELETE, 0, attributes, CREATE_NEW, OPEN_REPARSE_POINT, null)) as Pointer;
          if (!valid(handle)) reject();
          finishWindowsPrivateCreate(value.length, {
            write() {
              assertObject(handle, false, true);
              const count = [0];
              if (!native('write-vault-temporary', () => writeFile(handle, value, value.length, count, null))) reject();
              return count[0]!;
            },
            flush() { return Boolean(native('flush-vault-temporary', () => flush(handle))); },
            discard() { return Boolean(native('discard-vault-temporary', () => disposition(handle, 4, Buffer.from([1]), 1))); },
          });
          // Both supported ABIs use 8-byte HANDLEs: Flags at 0, RootDirectory at 8, length at 16, UTF-16 name at 20.
          const destination = Buffer.from(filePath(name), 'utf16le');
          const rename = Buffer.alloc(20 + destination.length);
          rename.writeUInt32LE(3, 0); // FILE_RENAME_FLAG_REPLACE_IF_EXISTS | FILE_RENAME_FLAG_POSIX_SEMANTICS
          rename.writeUInt32LE(destination.length, 16);
          destination.copy(rename, 20);
          commitWindowsPrivateReplace({
            rename() { return Boolean(native('rename-vault-temporary', () => disposition(handle, 22, rename, rename.length))); },
            discard() { return Boolean(native('discard-vault-temporary', () => disposition(handle, 4, Buffer.from([1]), 1))); },
          });
          try { assertObject(handle, false, true); } catch {
            throw new PlatformError('Windows 密钥库替换已提交，但随后原生访问检查失败；停止并由操作者检查，不自动回滚或重试');
          }
        } finally {
          if (valid(handle)) close(handle);
          if (security[0]) localFree(security[0]);
          if (target !== undefined) close(target);
        }
      });
    },
    stat(name) {
      return withDirectory<{ written_at: string } | null>(false, null, () => {
        const handle = openExisting(name, 0x80);
        if (handle === undefined) return null;
        try {
          const information = Buffer.alloc(52);
          if (!native('vault-file-time', () => getFileInformation(handle, information))) reject();
          const milliseconds = information.readBigUInt64LE(20) / 10000n - 11644473600000n;
          const date = new Date(Number(milliseconds));
          if (!Number.isSafeInteger(Number(milliseconds)) || !Number.isFinite(date.getTime())) reject();
          return { written_at: date.toISOString() };
        } finally { close(handle); }
      });
    },
    list() {
      return withDirectory<string[]>(false, [], () => {
        const data = Buffer.alloc(592); // WIN32_FIND_DATAW contains fixed-width DWORDs and WCHAR arrays on both ABIs.
        const search = native('vault-list-first', () => findFirst(win32.join(directory, '*'), data)) as Pointer;
        if (!valid(search)) { if (lastError() === 2) return []; reject(); }
        const names: string[] = [];
        try {
          for (;;) {
            const name = data.toString('utf16le', 44, 564).split('\0')[0]!;
            if (name !== '.' && name !== '..') {
              const handle = openExisting(name, 0x80);
              if (handle === undefined) reject();
              close(handle);
              names.push(name);
            }
            if (!native('vault-list-next', () => findNext(search, data))) { if (lastError() !== 18) reject(); break; }
          }
          return names.sort();
        } finally { native('vault-list-close', () => findClose(search)); }
      });
    },
    remove(name) {
      return withDirectory(false, false, () => {
        const handle = openExisting(name, DELETE);
        if (handle === undefined) return false;
        try { if (!native('delete-key-file', () => disposition(handle, 4, Buffer.from([1]), 1))) reject(); return true; }
        finally { close(handle); }
      });
    },
  };
}
