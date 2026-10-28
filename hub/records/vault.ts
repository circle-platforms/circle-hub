// Vault (adapted from the earlier private vault): AES-256-GCM sealed entries under <data>/vault. The entry name is bound as
// associated data, so a renamed or copied entry does not open; replaces are atomic; the key comes only from a KeyProvider and
// is never created implicitly. A key-check file tells a wrong key apart from an altered entry.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { KeyProvider, Vault, VaultVerification } from './api.ts';
import { VaultError } from './errors.ts';

const NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const SUFFIX = '.sealed';
const KEY_CHECK = 'key-check';
const FORMAT = 1;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_SEALED_BYTES = 128 * 1024;
/** AES-256-GCM with a 96-bit IV and the full 128-bit tag; anything shorter is refused, never accepted as a weaker tag. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Shows that a secret is set and how long it is, never any of its characters. */
export function maskedForDisplay(value: string | Uint8Array | null | undefined): string {
  if (value === null || value === undefined) return '未设置';
  const length = typeof value === 'string' ? [...value].length : value.byteLength;
  return length === 0 ? '已设置（空值）' : `已设置（长度 ${length}）`;
}

/** Key in a 0600 file. For tests and development; the deployed Hub uses the platform's Keychain provider. */
export class FileKeyProvider implements KeyProvider {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async getKey(): Promise<Uint8Array> {
    let key: Buffer;
    try {
      key = await readFile(this.path);
    } catch (error) {
      if (errno(error) === 'ENOENT') throw new VaultError('密钥库主密钥不存在；密钥只在显式初始化时创建');
      throw error;
    }
    if (key.byteLength !== 32) throw new VaultError('密钥库主密钥长度不对（应为 32 字节）');
    return new Uint8Array(key);
  }

  async initKey(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = await open(this.path, 'wx', 0o600);
    } catch (error) {
      if (errno(error) === 'EEXIST') throw new VaultError('密钥库主密钥已经存在，不会替换');
      throw error;
    }
    try {
      await handle.writeFile(randomBytes(32));
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

interface Sealed {
  v: number;
  iv: string;
  tag: string;
  data: string;
}

export class FileVault implements Vault {
  readonly directory: string;
  readonly #provider: KeyProvider | undefined;

  constructor(directory: string, provider?: KeyProvider) {
    this.directory = directory;
    this.#provider = provider;
  }

  async initKey(): Promise<void> {
    if (this.#provider?.initKey === undefined) throw new VaultError('当前的密钥来源不支持初始化密钥');
    await this.#provider.initKey();
  }

  async put(name: string, value: string | Uint8Array): Promise<void> {
    const target = this.#path(name);
    const plain = toBytes(value);
    const key = await this.#key();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(associatedData(name));
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    const sealed: Sealed = { v: FORMAT, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(sealed));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch(() => {});
    }
    await syncDirectory(this.directory);
  }

  async get(name: string): Promise<Uint8Array | null> {
    const target = this.#path(name);
    const key = await this.#key();
    let text: string;
    try {
      text = await readFile(target, 'utf8');
    } catch (error) {
      if (errno(error) === 'ENOENT') return null;
      throw error;
    }
    return openSealed(name, text, key);
  }

  async getText(name: string): Promise<string | null> {
    const bytes = await this.get(name);
    return bytes === null ? null : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  async has(name: string): Promise<boolean> {
    try {
      return (await stat(this.#path(name))).isFile();
    } catch (error) {
      if (errno(error) === 'ENOENT') return false;
      throw error;
    }
  }

  async stat(name: string): Promise<{ written_at: string } | null> {
    try { const info = await stat(this.#path(name)); return info.isFile() ? { written_at: info.mtime.toISOString() } : null; }
    catch (error) { if (errno(error) === 'ENOENT') return null; throw error; }
  }

  async list(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (errno(error) === 'ENOENT') return [];
      throw error;
    }
    return names
      .filter((file) => file.endsWith(SUFFIX))
      .map((file) => file.slice(0, -SUFFIX.length))
      .filter((name) => NAME.test(name))
      .sort();
  }

  /**
   * Authenticate every entry without writing key-check or revealing names or values. Writers must be stopped while this
   * runs: metadata checks detect changes during the scan, but cannot freeze an unrelated process after the last check.
   */
  async verify(): Promise<VaultVerification> {
    const result: VaultVerification = { checked: 0, failed: 0, unknown: false };
    let key: Buffer | undefined;
    try {
      let before;
      try { before = await lstat(this.directory, { bigint: true }); }
      catch (error) {
        if (errno(error) === 'ENOENT') return { ...result, unknown: true };
        throw error;
      }
      if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('invalid directory');
      const files = (await readdir(this.directory)).sort();
      const names = files.filter(file => file.endsWith(SUFFIX) && NAME.test(file.slice(0, -SUFFIX.length)));
      result.failed += files.length - names.length - (files.includes(KEY_CHECK) ? 1 : 0);
      if (this.#provider === undefined) return { ...result, unknown: true };
      try { key = Buffer.from(await this.#provider.getKey()); }
      catch { return { ...result, unknown: true }; }
      if (key.byteLength !== 32) return { ...result, unknown: true };

      const observed = new Map<string, Awaited<ReturnType<typeof fingerprint>>>();
      if (files.includes(KEY_CHECK)) {
        try {
          const entry = await readVerifiedFile(join(this.directory, KEY_CHECK), 1024);
          observed.set(KEY_CHECK, entry.fingerprint);
          const expected = createHmac('sha256', key).update('circle-hub vault key check v1').digest('hex');
          if (entry.bytes.toString('utf8').trim() !== expected) result.failed++;
        } catch { result.failed++; }
      }
      for (const file of names) {
        try {
          const entry = await readVerifiedFile(join(this.directory, file), MAX_SEALED_BYTES);
          observed.set(file, entry.fingerprint);
          const plain = openSealed(file.slice(0, -SUFFIX.length), entry.bytes.toString('utf8'), key);
          plain.fill(0);
          result.checked++;
        } catch { result.failed++; }
      }
      const after = await lstat(this.directory, { bigint: true });
      if (!sameFingerprint(before, after) || JSON.stringify((await readdir(this.directory)).sort()) !== JSON.stringify(files)) result.failed++;
      for (const [file, identity] of observed) {
        try { if (!sameFingerprint(identity, await fingerprint(join(this.directory, file)))) result.failed++; }
        catch { result.failed++; }
      }
      result.unknown = result.checked === 0 && result.failed === 0;
      return result;
    } catch {
      // Filesystem errors can contain a path or an entry name: never return the original error.
      return { ...result, failed: result.failed + 1, unknown: true };
    } finally {
      key?.fill(0);
    }
  }

  async remove(name: string): Promise<boolean> {
    try {
      await unlink(this.#path(name));
    } catch (error) {
      if (errno(error) === 'ENOENT') return false;
      throw error;
    }
    await syncDirectory(this.directory);
    return true;
  }

  #path(name: string): string {
    if (typeof name !== 'string' || !NAME.test(name)) throw new TypeError('vault entry names are lowercase letters, digits, dot, underscore and dash');
    return join(this.directory, `${name}${SUFFIX}`);
  }

  async #key(): Promise<Buffer> {
    if (this.#provider === undefined) throw new VaultError('没有配置密钥来源，密钥库不可用');
    const key = Buffer.from(await this.#provider.getKey());
    if (key.byteLength !== 32) throw new VaultError('密钥库主密钥长度不对（应为 32 字节）');
    await this.#checkKey(key);
    return key;
  }

  /** Compares an HMAC of a fixed text under the key with the one recorded when the vault was first used. */
  async #checkKey(key: Buffer): Promise<void> {
    const expected = createHmac('sha256', key).update('circle-hub vault key check v1').digest('hex');
    const path = join(this.directory, KEY_CHECK);
    let stored: string | null = null;
    try {
      stored = (await readFile(path, 'utf8')).trim();
    } catch (error) {
      if (errno(error) !== 'ENOENT') throw error;
    }
    if (stored === null) {
      // Entries but no check file (restored without it): the key must open an existing entry before the check is written,
      // or a second key would silently seal new entries next to the old ones.
      const names = await this.list();
      if (names.length > 0 && !(await this.#opensAnEntry(names, key))) {
        throw new VaultError('密钥与密钥库不符：现有条目没有一条能用这把主密钥解开');
      }
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      try {
        const handle = await open(path, 'wx', 0o600);
        try {
          await handle.writeFile(`${expected}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }
        return;
      } catch (error) {
        if (errno(error) !== 'EEXIST') throw error;
        stored = (await readFile(path, 'utf8')).trim();
      }
    }
    if (stored !== expected) throw new VaultError('密钥与密钥库不符：密钥库是用另一把主密钥封存的');
  }

  /** True when the key opens at least one entry (GCM authentication: a wrong key never opens one). */
  async #opensAnEntry(names: readonly string[], key: Buffer): Promise<boolean> {
    for (const name of names) {
      try {
        openSealed(name, await readFile(this.#path(name), 'utf8'), key);
        return true;
      } catch {
        // An altered entry or another key; try the next one.
      }
    }
    return false;
  }
}

async function fingerprint(path: string) { return lstat(path, { bigint: true }); }

function sameFingerprint(a: Awaited<ReturnType<typeof fingerprint>>, b: Awaited<ReturnType<typeof fingerprint>>): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

async function readVerifiedFile(path: string, limit: number): Promise<{ bytes: Buffer; fingerprint: Awaited<ReturnType<typeof fingerprint>> }> {
  // Nonblocking prevents an unexpected FIFO from hanging before fstat can refuse it.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(limit)) throw new Error('invalid file');
    // Bound the read itself as well as the initial size check: another writer can grow a file after fstat.
    const buffer = Buffer.allocUnsafe(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await handle.read(buffer, offset, buffer.length - offset, null);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset > limit) throw new Error('oversized file');
    const bytes = buffer.subarray(0, offset);
    const after = await handle.stat({ bigint: true });
    const named = await fingerprint(path);
    if (!sameFingerprint(before, after) || !sameFingerprint(before, named)) throw new Error('changed file');
    return { bytes, fingerprint: named };
  } finally { await handle.close(); }
}

/** Opens one sealed entry; refuses a wrong format, an IV that is not 12 bytes and a tag that is not 16 bytes. */
function openSealed(name: string, text: string, key: Buffer): Uint8Array {
  let sealed: Sealed;
  try {
    sealed = JSON.parse(text) as Sealed;
  } catch {
    throw new VaultError(`密钥库条目 ${name} 已损坏`);
  }
  if (sealed?.v !== FORMAT || typeof sealed.iv !== 'string' || typeof sealed.tag !== 'string' || typeof sealed.data !== 'string') {
    throw new VaultError(`密钥库条目 ${name} 的格式不对`);
  }
  const iv = Buffer.from(sealed.iv, 'base64');
  const tag = Buffer.from(sealed.tag, 'base64');
  if (iv.byteLength !== IV_BYTES || tag.byteLength !== TAG_BYTES) throw new VaultError(`密钥库条目 ${name} 的格式不对：初始向量或认证标签长度不对`);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(associatedData(name));
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]));
  } catch {
    throw new VaultError(`密钥库条目 ${name} 无法解开：内容被改动过，或文件名与封存时不同`);
  }
}

function associatedData(name: string): Buffer {
  return Buffer.from(`circle-hub vault v1\0${name}`, 'utf8');
}

function toBytes(value: string | Uint8Array): Buffer {
  let bytes: Buffer;
  if (typeof value === 'string') {
    if (!value.isWellFormed()) throw new TypeError('vault values must be well-formed text');
    bytes = Buffer.from(value, 'utf8');
  } else if (value instanceof Uint8Array) {
    bytes = Buffer.from(value);
  } else {
    throw new TypeError('vault values are text or bytes');
  }
  if (bytes.byteLength > MAX_VALUE_BYTES) throw new TypeError(`vault values are at most ${MAX_VALUE_BYTES} bytes`);
  return bytes;
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is best effort.
  }
}
