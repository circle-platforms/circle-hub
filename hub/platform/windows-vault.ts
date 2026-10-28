// Windows supplies only the OS file boundary; records retains the AES-GCM, AAD and key-check implementation.
import { FileVault, type FileVaultStorage, type KeyProvider } from '../records/api.ts';
import { PlatformError } from './errors.ts';
import { windowsPrivateFiles } from './windows-files.ts';

export interface WindowsVaultOptions {
  /** Persisted service identity, obtained by the installer from a native token; never an environment username. */
  expectedSid: string;
  onNativeStep?: (step: string) => void;
}

export function windowsFileVaultStorage(directory: string, options: WindowsVaultOptions): FileVaultStorage {
  if (typeof options.expectedSid !== 'string' || options.expectedSid.length === 0) throw new PlatformError('Windows 密钥库缺少服务的固定身份，不猜当前用户');
  const files = windowsPrivateFiles(directory, options.onNativeStep, options.expectedSid);
  return {
    async read(file) { const value = files.read(file); return value === undefined ? null : new TextDecoder('utf-8', { fatal: true }).decode(value); },
    async writeAtomic(file, text) { files.replace(file, Buffer.from(text, 'utf8')); },
    async create(file, text) { return files.createIfMissing(file, Buffer.from(text, 'utf8')); },
    async stat(file) { return files.stat(file); },
    async list() { return files.list(); },
    async remove(file) { return files.remove(file); },
  };
}

/** Not wired to the production factory until service identity and native vault runner evidence is accepted. */
export function windowsFileVault(directory: string, provider: KeyProvider, options: WindowsVaultOptions): FileVault {
  return new FileVault(directory, provider, windowsFileVaultStorage(directory, options));
}
