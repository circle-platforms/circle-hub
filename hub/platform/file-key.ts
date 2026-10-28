// Linux deployment key store. Only the service account may read keys; no key is backed up with config or the vault.
import { constants } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { PlatformError } from './errors.ts';
import { KEY_BYTES, type KeychainStore, type KeyProvider, type KeychainItem } from './keychain.ts';
import { KeychainName, OPERATOR_TOKEN_ACCOUNT } from './settings.ts';
import { VAULT_KEY_ITEM, UNNAMED_ITEM, OPERATOR_TOKEN_ITEM } from './keychain-items.ts';

export interface FileKeyOptions { root: string; service: string; account: string; item?: KeychainItem }
/** Removing an already removed key is idempotent; other filesystem failures remain visible. */
export async function removeKeyFile(path: string, remove: typeof unlink = unlink): Promise<boolean> {
  try { await remove(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
/** Store file is keyed by names, not secret data. The directory and files are checked on every access. */
export function fileKeyStore(options: FileKeyOptions): KeychainStore {
  const {root, service, account} = options;
  if (!isAbsolute(root)) throw new PlatformError('密钥文件的数据根必须是绝对路径');
  if (!KeychainName.safeParse(service).success || !KeychainName.safeParse(account).success) throw new PlatformError('密钥服务名或账户名格式不对');
  const item = options.item ?? (account === OPERATOR_TOKEN_ACCOUNT ? OPERATOR_TOKEN_ITEM : UNNAMED_ITEM);
  if (item === VAULT_KEY_ITEM && account === OPERATOR_TOKEN_ACCOUNT) throw new PlatformError('操作令牌账户不能作为密钥库主密钥');
  const directory = join(root, 'keys');
  const path = join(directory, createHash('sha256').update(JSON.stringify([service, account])).digest('hex') + '.key');
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
  return {service,account,status,read,write,async init(){const bytes=randomBytes(KEY_BYTES);try{await write(bytes);}finally{bytes.fill(0);}},async delete(){if(!(await status()).present)return false;return removeKeyFile(path);}};
}
export function fileKeyProvider(options: FileKeyOptions): Required<KeyProvider> {
  const store = fileKeyStore({...options,item:VAULT_KEY_ITEM});
  let cached: Promise<Uint8Array> | undefined;
  return {getKey(){cached ??= store.read().catch(error=>{cached=undefined;throw error;});return cached.then(key=>Uint8Array.from(key));},initKey(){return store.init();}};
}
