// Headless, current-user DPAPI. This is not Electron's safeStorage format or a persistent key store.
import { createRequire } from 'node:module';
import { PlatformError } from './errors.ts';

/** No filesystem or profile setup is performed by this primitive. */
export interface WindowsDataProtection {
  protect(value: Uint8Array): Uint8Array;
  unprotect(value: Uint8Array): Uint8Array;
}

const MAX_BYTES = 1024 * 1024;
const CRYPTPROTECT_UI_FORBIDDEN = 1;
const require = createRequire(import.meta.url);

/** Loads native code only on Windows, and refuses any dependency version other than the reviewed pin. */
export function windowsDataProtection(): WindowsDataProtection {
  if (process.platform !== 'win32') throw new PlatformError('Windows 用户范围数据保护只可在 Windows 上使用');
  let koffi: typeof import('koffi');
  try {
    koffi = require('koffi') as typeof import('koffi');
    if (koffi.version !== '3.3.3') throw new Error('version');
  } catch {
    throw new PlatformError('Windows 数据保护适配不可用：需要 koffi 3.3.3，不使用替代密钥来源');
  }
  try {
    // Absolute KnownDLL paths avoid the application directory DLL search path. No environment path is consulted.
    const kernel = koffi.load('kernel32.dll');
    const systemDirectory = kernel.func('uint32_t __stdcall GetSystemDirectoryW(_Out_ char16_t *buffer, uint32_t size)');
    const directoryBuffer = Buffer.alloc(65536);
    const directoryLength = systemDirectory(directoryBuffer, directoryBuffer.length / 2) as number;
    if (directoryLength === 0 || directoryLength >= directoryBuffer.length / 2) throw new Error('system directory');
    const directory = directoryBuffer.toString('utf16le', 0, directoryLength * 2);
    const crypt = koffi.load(`${directory}\\crypt32.dll`);
    // Anonymous structs avoid process-global Koffi type-name collisions on repeated construction.
    const blob = koffi.struct({ cbData: 'uint32_t', pbData: 'void *' });
    const input = koffi.pointer(blob);
    const output = koffi.out(koffi.pointer(blob));
    const protect = crypt.func('__stdcall', 'CryptProtectData', 'int32_t', [input, 'str16', input, 'void *', 'void *', 'uint32_t', output]);
    const unprotect = crypt.func('__stdcall', 'CryptUnprotectData', 'int32_t', [input, 'void *', input, 'void *', 'void *', 'uint32_t', output]);
    const localFree = kernel.func('void * __stdcall LocalFree(void *memory)');

    const transform = (value: Uint8Array, decrypt: boolean): Uint8Array => {
      if (!(value instanceof Uint8Array)) throw new PlatformError('Windows 数据保护输入必须是字节');
      const bytes = Buffer.from(new Uint8Array(value).buffer);
      if (bytes.length === 0 || bytes.length > MAX_BYTES) {
        bytes.fill(0);
        throw new PlatformError('Windows 数据保护输入长度必须在 1 到 1048576 字节之间');
      }
      const result: { cbData: number; pbData: bigint | null } = { cbData: 0, pbData: null };
      try {
        const operation = decrypt ? unprotect : protect;
        // LOCAL_MACHINE is deliberately absent. A missing service profile cannot fall back to machine scope or UI.
        const ok = operation({ cbData: bytes.length, pbData: bytes }, null, null, null, null, CRYPTPROTECT_UI_FORBIDDEN, result);
        if (!ok) throw new PlatformError('Windows 用户范围数据保护失败；未使用交互、机器范围或明文回退');
        if (!result.pbData || !Number.isSafeInteger(result.cbData) || result.cbData < 1 || result.cbData > MAX_BYTES) {
          throw new PlatformError('Windows 数据保护返回无效数据');
        }
        // Copy before freeing Windows-owned storage; no string representation of a secret is created.
        return Uint8Array.from(new Uint8Array(koffi.view(result.pbData, result.cbData)));
      } finally {
        bytes.fill(0);
        if (result.pbData) {
          try {
            // The OS allocation is cleared in place before LocalFree, including a decrypted master key.
            if (Number.isSafeInteger(result.cbData) && result.cbData > 0 && result.cbData <= MAX_BYTES) {
              new Uint8Array(koffi.view(result.pbData, result.cbData)).fill(0);
            }
          } finally {
            localFree(result.pbData);
          }
        }
      }
    };
    return { protect: (value) => transform(value, false), unprotect: (value) => transform(value, true) };
  } catch {
    throw new PlatformError('Windows 原生数据保护加载失败；密钥来源不可用');
  }
}
