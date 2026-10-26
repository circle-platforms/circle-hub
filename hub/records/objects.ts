// Content-addressed bytes under <root>/ab/<sha256> (adapted from the earlier knowledge object store): atomic write through a
// hard link, read-only files, verified on every read, never overwritten and never deleted.
import { createHash, randomBytes } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ObjectInfo, ObjectStore } from './api.ts';
import { iso } from './db.ts';
import type { Database } from './db.ts';
import { isSha256, sha256Hex } from './digest.ts';
import { IntegrityError, LimitError } from './errors.ts';

const MEDIA_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}(\s*;\s*[A-Za-z0-9!#$&^_.+-]+=("[^"\\\r\n]*"|[A-Za-z0-9!#$&^_.+-]+))*$/;

export function isMediaType(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 200 && MEDIA_TYPE.test(value);
}

export interface ObjectStoreOptions {
  maxBytes: number;
  now: () => Date;
}

export class FileObjectStore implements ObjectStore {
  readonly root: string;
  readonly #db: Database;
  readonly #options: ObjectStoreOptions;

  constructor(root: string, db: Database, options: ObjectStoreOptions) {
    this.root = root;
    this.#db = db;
    this.#options = options;
  }

  path(sha256: string): string {
    if (!isSha256(sha256)) throw new TypeError('object name must be a lowercase hex SHA-256');
    return join(this.root, sha256.slice(0, 2), sha256);
  }

  async put(bytes: Uint8Array, mediaType: string): Promise<ObjectInfo & { created: boolean }> {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('object bytes must be a Uint8Array');
    if (!isMediaType(mediaType)) throw new TypeError(`invalid media type ${JSON.stringify(mediaType)}`);
    if (bytes.byteLength > this.#options.maxBytes) {
      throw new LimitError(`文件 ${bytes.byteLength} 字节，超过上限 ${this.#options.maxBytes} 字节；不会截断保存`, {
        detail: { size: bytes.byteLength, limit: this.#options.maxBytes },
      });
    }
    const sha256 = sha256Hex(bytes);
    const created = await this.#write(sha256, bytes);
    const result = await this.#db.query(
      `INSERT INTO objects (sha256, size, media_type, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (sha256) DO NOTHING`,
      [sha256, bytes.byteLength, mediaType, this.#options.now().toISOString()],
    );
    const info = await this.stat(sha256);
    if (info === null) throw new IntegrityError('对象登记丢失', { detail: { sha256 } });
    if (info.size !== bytes.byteLength) throw new IntegrityError('对象登记的大小与字节不符', { detail: { sha256 } });
    return { ...info, created: created || result.rowCount === 1 };
  }

  async get(sha256: string): Promise<Uint8Array | null> {
    if (!isSha256(sha256)) return null;
    let bytes: Buffer;
    try {
      bytes = await readFile(this.path(sha256));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Registered but gone is data loss (objects are never deleted), not absence.
      if ((await this.stat(sha256)) !== null) throw new IntegrityError('有对象登记，但原件字节丢失；请从备份恢复', { detail: { sha256 } });
      return null;
    }
    if (sha256Hex(bytes) !== sha256) {
      throw new IntegrityError('保存的原件字节与它的 SHA-256 不符（文件被改动或损坏）', { detail: { sha256 } });
    }
    return bytes;
  }

  async stat(sha256: string): Promise<ObjectInfo | null> {
    if (!isSha256(sha256)) return null;
    const row = (await this.#db.query('SELECT sha256, size, media_type, created_at FROM objects WHERE sha256 = $1', [sha256])).rows[0];
    if (row === undefined) return null;
    return { sha256: String(row.sha256), size: Number(row.size), media_type: String(row.media_type), created_at: iso(row.created_at) };
  }

  async has(sha256: string): Promise<boolean> {
    return (await this.stat(sha256)) !== null;
  }

  /** Writes the bytes once. An existing file is verified and kept: a corrupt original is reported, never replaced. */
  async #write(sha256: string, bytes: Uint8Array): Promise<boolean> {
    const directory = join(this.root, sha256.slice(0, 2));
    const target = this.path(sha256);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${sha256}.${randomBytes(8).toString('hex')}.tmp`);
    const handle = await open(temporary, 'wx', 0o400);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, target);
      await syncDirectory(directory);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await open(target, 'r');
      const hash = createHash('sha256'), scratch = Buffer.allocUnsafe(64 * 1024);
      try { for (; ;) { const { bytesRead } = await existing.read(scratch, 0, scratch.length, null); if (bytesRead === 0) break; hash.update(scratch.subarray(0, bytesRead)); } } finally { await existing.close(); }
      if (hash.digest('hex') !== sha256) {
        throw new IntegrityError('已保存的原件与它的 SHA-256 不符；原件从不覆盖，请从备份恢复', { detail: { sha256 } });
      }
      return false;
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
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
    // Directory fsync is best effort; not every platform allows it.
  }
}
