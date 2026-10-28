// Headless current-user encrypted files, following Circle's OS-cipher/file separation; never Electron-safeStorage bytes.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { PlatformError } from './errors.ts';
import { KEY_BYTES, type KeychainStore } from './keychain.ts';
import { OPERATOR_TOKEN_ITEM, UNNAMED_ITEM, VAULT_KEY_ITEM, type KeychainItem } from './keychain-items.ts';
import { DEFAULT_KEYCHAIN_ACCOUNT, DEFAULT_KEYCHAIN_SERVICE, KeychainName, OPERATOR_TOKEN_ACCOUNT } from './settings.ts';
import { windowsDataProtection, type WindowsDataProtection } from './windows-dpapi.ts';
import { windowsPrivateFiles, type WindowsPrivateFiles } from './windows-files.ts';

export interface WindowsKeychainOptions {
  directory: string;
  service?: string;
  account?: string;
  item?: KeychainItem;
}

/** Kept independent of the production factory until native Windows runner checks have passed. */
export function windowsKeychainStore(options: WindowsKeychainOptions, onNativeStep?: (step: string) => void): KeychainStore {
  return windowsKeychainStoreWithBoundary(options, windowsPrivateFiles(options.directory, onNativeStep), windowsDataProtection());
}

/** Dependency-injected boundary for synthetic tests; production entry always constructs the native implementations. */
export function windowsKeychainStoreWithBoundary(options: WindowsKeychainOptions, files: WindowsPrivateFiles, cipher: WindowsDataProtection): KeychainStore {
  const service = options.service ?? DEFAULT_KEYCHAIN_SERVICE;
  const account = options.account ?? DEFAULT_KEYCHAIN_ACCOUNT;
  if (!KeychainName.safeParse(service).success || !KeychainName.safeParse(account).success) throw new PlatformError('Windows 密钥条目的服务名或账户名无效');
  const item = options.item ?? (account === OPERATOR_TOKEN_ACCOUNT ? OPERATOR_TOKEN_ITEM : UNNAMED_ITEM);
  if (item === VAULT_KEY_ITEM && account === OPERATOR_TOKEN_ACCOUNT) throw new PlatformError('密钥库主密钥不能使用操作令牌的账户');
  const binding = createHash('sha256').update(JSON.stringify(['circle-hub windows key v1', files.sid, service, account])).digest();
  const name = `${createHash('sha256').update(JSON.stringify([service, account])).digest('hex')}.bin`;
  const invalid = (): never => { throw new PlatformError('Windows 密钥条目格式、身份或绑定不符；没有采用回退密钥'); };
  const read = async (): Promise<Uint8Array> => {
    const file = files.read(name);
    if (file === undefined) throw new PlatformError(`Windows 私有存储里没有${item.label}`, item.missingHint);
    let plain: Uint8Array | undefined;
    try {
      const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file)) as Record<string, unknown>;
      if (envelope.v !== 1 || envelope.sid !== files.sid || envelope.service !== service || envelope.account !== account || typeof envelope.data !== 'string') invalid();
      const encoded = Buffer.from(envelope.data as string, 'base64');
      if (encoded.length === 0 || encoded.toString('base64') !== envelope.data) invalid();
      plain = cipher.unprotect(encoded);
      if (plain.length !== binding.length + KEY_BYTES || !timingSafeEqual(plain.subarray(0, binding.length), binding)) invalid();
      return Uint8Array.from(plain.subarray(binding.length));
    } catch {
      return invalid();
    } finally { plain?.fill(0); }
  };
  const write = async (value: Uint8Array): Promise<void> => {
    if (!(value instanceof Uint8Array)) throw new PlatformError('Windows 密钥条目必须是 32 字节');
    const key = Buffer.from(new Uint8Array(value).buffer);
    let plain: Buffer | undefined;
    try {
      if (key.length !== KEY_BYTES) throw new PlatformError('Windows 密钥条目必须是 32 字节');
      // The probe catches unavailable DPAPI before persistent create; native CREATE_NEW still decides the no-overwrite race.
      plain = Buffer.concat([binding, key]);
      const encrypted = cipher.protect(plain);
      const probe = cipher.unprotect(encrypted);
      try { if (probe.length !== plain.length || !timingSafeEqual(probe, plain)) invalid(); } finally { probe.fill(0); }
      const envelope = Buffer.from(JSON.stringify({ v: 1, sid: files.sid, service, account, data: Buffer.from(encrypted).toString('base64') }));
      files.create(name, envelope);
      const stored = await read();
      try { if (!timingSafeEqual(stored, key)) invalid(); } finally { stored.fill(0); }
    } finally { plain?.fill(0); key.fill(0); }
  };
  return {
    service, account, read, write,
    async status() {
      if (files.read(name) === undefined) return { present: false };
      const key = await read();
      key.fill(0);
      return { present: true };
    },
    async init() { const key = randomBytes(KEY_BYTES); try { await write(key); } finally { key.fill(0); } },
    async delete() { return files.remove(name); },
  };
}

export function windowsKeychainKeyProvider(options: WindowsKeychainOptions): import('./keychain.ts').KeyProvider {
  if (options.account === OPERATOR_TOKEN_ACCOUNT) throw new PlatformError('密钥库主密钥不能使用操作令牌的账户');
  const store = windowsKeychainStore({ ...options, item: options.item ?? VAULT_KEY_ITEM });
  let cached: Promise<Uint8Array> | undefined;
  return {
    getKey() {
      cached ??= store.read().catch((error: unknown) => { cached = undefined; throw error; });
      return cached.then((key) => Uint8Array.from(key));
    },
    initKey() { return store.init(); },
  };
}
