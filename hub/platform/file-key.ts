// The deployment's key store on every platform (decision 137 of 2026-11-03: the macOS keychain is no longer used). The
// vault master key and the operator token are each a 32-byte file under <data root>/keys, which only the service account
// may read: the directory is 0700, each file 0600 with one link, and both are checked on every access. A key is written
// with O_EXCL, never over an existing file, and read back to check; it is never printed or logged, and no key is backed up
// with the configuration or the vault. A file is named by a digest of the deployment settings' key names, never by data.
import { constants } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { PlatformError } from './errors.ts';
import type { PlatformSettings } from './settings.ts';

export const KEY_BYTES = 32;
/** A key service or account name: it is hashed into the file name, never used as a path itself. */
export const KeyName = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
/** The key names a deployment's settings get by default (keychain_service and keychain_account, their persisted names). */
export const DEFAULT_KEY_SERVICE = 'circle-hub';
export const DEFAULT_KEY_ACCOUNT = 'vault-master-key';
/**
 * Account of the operator token, beside the vault master key under the deployment's key service. Reserved: the vault
 * master key may not use it, or the two would be one key file.
 */
export const OPERATOR_TOKEN_ACCOUNT = 'operator-token';

/** What a key file holds, as its messages name it, and the next steps that belong to it. */
export interface KeyItem {
  /** Chinese name of what the file holds. */
  readonly label: string;
  /** The next step when the key is missing; none when the caller decides. */
  readonly missingHint?: string;
  /** Why an existing key is never replaced; none when the caller decides. */
  readonly keepHint?: string;
}

/** The vault master key. 密钥库 is the design standard's term for the vault (docs/design/object-standard.md). */
export const VAULT_KEY_ITEM: KeyItem = Object.freeze({
  label: '密钥库主密钥',
  missingHint: '先运行 circle-hub key init',
  keepHint: '换主密钥会让已加密的密钥库条目无法解开',
});

/** The admin token the server's state-changing commands act with; the server decides what to advise about it. */
export const OPERATOR_TOKEN_ITEM: KeyItem = Object.freeze({ label: '操作令牌' });

/** A key the caller did not name: it may be neither of the two, so it gets a neutral name and no advice. */
export const UNNAMED_ITEM: KeyItem = Object.freeze({ label: '密钥' });

/** Same structural interface as the records package's vault key source (hub/records/api.ts KeyProvider). */
export interface KeyProvider {
  /** Throws when no key exists; never creates one. */
  getKey(): Promise<Uint8Array>;
  /** Creates a key when none exists; refuses to replace an existing one. */
  initKey?(): Promise<void>;
}

export interface KeyStore {
  readonly service: string;
  readonly account: string;
  /** Creates a new random value of KEY_BYTES; refuses when the key exists. */
  init(): Promise<void>;
  /**
   * Stores `value` (exactly KEY_BYTES bytes); refuses when the key exists, then reads it back and compares. `value` itself
   * is left as it is; the store's own copies are zeroed.
   */
  write(value: Uint8Array): Promise<void>;
  status(): Promise<{ present: boolean }>;
  read(): Promise<Uint8Array>;
  /** True when a key was deleted. */
  delete(): Promise<boolean>;
}

/** One key of a deployment: what fileKeyStore needs to reach it and to name it. */
export interface KeyItemName {
  service: string;
  account: string;
  item: KeyItem;
}

/** The keys of one deployment, under its one key service. */
export interface DeploymentKeyNames {
  vaultKey: KeyItemName;
  /** Beside the vault master key: the same service, account OPERATOR_TOKEN_ACCOUNT. */
  operatorToken: KeyItemName;
}

/** The key directory of a data root. */
export function keyDirectory(root: string): string {
  return join(root, 'keys');
}

/** The file of one key: a digest of its names, so the name says nothing about the deployment. */
export function keyFilePath(root: string, service: string, account: string): string {
  return join(keyDirectory(root), createHash('sha256').update(JSON.stringify([service, account])).digest('hex') + '.key');
}

export interface FileKeyOptions { root: string; service: string; account: string; item?: KeyItem }
/** Removing an already removed key is idempotent; other filesystem failures remain visible. */
export async function removeKeyFile(path: string, remove: typeof unlink = unlink): Promise<boolean> {
  try { await remove(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
/** The store of one key file. The directory and the file are checked on every access. */
export function fileKeyStore(options: FileKeyOptions): KeyStore {
  const {root, service, account} = options;
  if (!isAbsolute(root)) throw new PlatformError('密钥文件的数据根必须是绝对路径');
  if (!KeyName.safeParse(service).success || !KeyName.safeParse(account).success) throw new PlatformError('密钥服务名或账户名只能含字母、数字、点、下划线和连字符，最长 64 个字符');
  const item = options.item ?? (account === OPERATOR_TOKEN_ACCOUNT ? OPERATOR_TOKEN_ITEM : UNNAMED_ITEM);
  if (item === VAULT_KEY_ITEM && account === OPERATOR_TOKEN_ACCOUNT) throw reservedForVaultKey(service);
  const directory = keyDirectory(root);
  const path = keyFilePath(root, service, account);
  const owner = process.getuid?.();
  const damaged = () => new PlatformError(`${item.label}文件长度不对，可能是写入时中断`, `在私有目录中保留并移走损坏文件 ${path}，确认来源后重新导入；密钥库非空时不要运行 key init`);
  const verifyDirectory = async (create: boolean): Promise<boolean> => {
    const base = await lstat(root).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT' && !create) return undefined; throw error; });
    if (!base) return false;
    if (!base.isDirectory() || base.isSymbolicLink() || (owner !== undefined && base.uid !== owner) || (base.mode & 0o077) !== 0) throw new PlatformError('数据根必须是当前服务账户拥有的私有目录');
    if (create) await mkdir(directory, {mode: 0o700}).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    const dir = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!dir) return false;
    if (!dir.isDirectory() || dir.isSymbolicLink() || (owner !== undefined && dir.uid !== owner) || (dir.mode & 0o777) !== 0o700) throw new PlatformError('密钥目录必须由当前服务账户拥有且权限为 0700');
    return true;
  };
  const read = async (): Promise<Uint8Array> => {
    if (!(await verifyDirectory(false))) throw new PlatformError(`没有${item.label}`, item.missingHint);
    // A substituted FIFO without a writer must never block open before fstat can reject the non-regular file.
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') throw new PlatformError(`没有${item.label}`, item.missingHint); throw new PlatformError(`无法安全读取${item.label}`); });
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || (owner !== undefined && stat.uid !== owner) || (stat.mode & 0o777) !== 0o600) throw new PlatformError(`${item.label}文件的属主或权限不对`);
      if (stat.size !== KEY_BYTES) throw damaged();
      const key = await file.readFile();
      if (key.length !== KEY_BYTES) { key.fill(0); throw damaged(); }
      const out = Uint8Array.from(key); key.fill(0); return out;
    } finally { await file.close(); }
  };
  const status = async (): Promise<{present: boolean}> => {
    if (!(await verifyDirectory(false))) return {present:false};
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!stat) return {present:false};
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (owner !== undefined && stat.uid !== owner) || (stat.mode & 0o777) !== 0o600) throw new PlatformError(`${item.label}文件的属主或权限不对`);
    if (stat.size !== KEY_BYTES) throw damaged();
    return {present:true};
  };
  const write = async (input: Uint8Array): Promise<void> => {
    if (!(input instanceof Uint8Array)) throw new PlatformError(`${item.label}必须是 32 字节`);
    const bytes = Buffer.from(new Uint8Array(input));
    try {
      if (bytes.length !== KEY_BYTES) throw new PlatformError(`${item.label}必须是 32 字节`);
      await verifyDirectory(true);
      const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600).catch((error: NodeJS.ErrnoException) => { if (error.code === 'EEXIST') throw new PlatformError(`已有${item.label}，不覆盖`, item.keepHint); throw new PlatformError(`无法安全写入${item.label}`); });
      let done = false;
      try { await file.writeFile(bytes); await file.sync(); done = true; } finally { await file.close(); if (!done) await unlink(path).catch(() => {}); }
      const actual = await read();
      try { if (!timingSafeEqual(bytes, actual)) throw new PlatformError(`读回的${item.label}不一致`); } finally { actual.fill(0); }
    } finally { bytes.fill(0); }
  };
  return {service,account,status,read,write,async init(){const bytes=randomBytes(KEY_BYTES);try{await write(bytes);}finally{bytes.fill(0);}},async delete(){
    // A concurrent delete can unlink the file while status() is looking at it (seen as a stat of an inode already being
    // removed); when the check fails and the path is gone by the time we look again, the file was removed, not unsafe.
    let present: boolean;
    try { present = (await status()).present; }
    catch (error) { if (await lstat(path).then(() => false, (e: NodeJS.ErrnoException) => e.code === 'ENOENT')) return false; throw error; }
    if (!present) return false;
    return removeKeyFile(path);
  }};
}
/**
 * KeyProvider over the vault master key's file; the key is read once per process and kept in memory. Whatever `item`
 * calls it, the provider reads the vault master key, so the operator token's account is refused before any call.
 */
export function fileKeyProvider(options: FileKeyOptions): Required<KeyProvider> {
  const store = fileKeyStore({...options,item:VAULT_KEY_ITEM});
  let cached: Promise<Uint8Array> | undefined;
  return {getKey(){cached ??= store.read().catch(error=>{cached=undefined;throw error;});return cached.then(key=>Uint8Array.from(key));},initKey(){return store.init();}};
}

/** The vault master key on the operator token's account: the two would be one key file. */
function reservedForVaultKey(service: string): PlatformError {
  return new PlatformError(
    `密钥账户 ${OPERATOR_TOKEN_ACCOUNT} 留给${OPERATOR_TOKEN_ITEM.label}，${VAULT_KEY_ITEM.label}不能用它（服务 ${service}）：两者会成为同一个密钥文件，不执行`,
    `给${VAULT_KEY_ITEM.label}另选一个账户（默认 ${DEFAULT_KEY_ACCOUNT}）`,
  );
}

/** The two keys under `service`, the vault master key's on `account`; `reserved` explains a refused account. */
export function keyNamesOf(service: string, account: string, reserved: () => PlatformError = () => reservedForVaultKey(service)): DeploymentKeyNames {
  if (account === OPERATOR_TOKEN_ACCOUNT) throw reserved();
  return {
    vaultKey: { service, account, item: VAULT_KEY_ITEM },
    operatorToken: { service, account: OPERATOR_TOKEN_ACCOUNT, item: OPERATOR_TOKEN_ITEM },
  };
}

/** The keys named by resolved deployment settings (their file is `path`); a vault key account that is reserved is refused. */
export function settingsKeyNames(settings: Pick<PlatformSettings, 'keyService' | 'keyAccount'>, path: string): DeploymentKeyNames {
  return keyNamesOf(
    settings.keyService,
    settings.keyAccount,
    () =>
      new PlatformError(
        `部署设置（${path}）里${VAULT_KEY_ITEM.label}的密钥账户是 ${OPERATOR_TOKEN_ACCOUNT}：这个账户留给${OPERATOR_TOKEN_ITEM.label}，两者会成为同一个密钥文件，不执行`,
        `把部署设置里的 keychain_account 改回 circle-hub init 写下的名字（默认 ${DEFAULT_KEY_ACCOUNT}）`,
      ),
  );
}
