import {verifiedRecord} from './store.ts';
import type {PgPersonalPayloads} from './personal-payloads.ts';
// Content-addressed bytes under <root>/ab/<sha256> (adapted from the earlier knowledge object store): atomic write through a
// hard link, read-only files and verification on read. Personal bytes use removable scoped PostgreSQL payloads;
// only their one-time legacy global files are retired after independent copies have been protected.
import { createHash, randomBytes } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ObjectInfo, ObjectStore, Transaction } from './api.ts';
import { iso } from './db.ts';
import type { Database } from './db.ts';
import { isSha256, sha256Hex } from './digest.ts';
import { IntegrityError, LimitError } from './errors.ts';

const MEDIA_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}(\s*;\s*[A-Za-z0-9!#$&^_.+-]+=("[^"\\\r\n]*"|[A-Za-z0-9!#$&^_.+-]+))*$/;

export function isMediaType(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 200 && MEDIA_TYPE.test(value);
}

export interface ObjectStoreOptions {
  personalPayloads?:PgPersonalPayloads;
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

  async put(bytes: Uint8Array, mediaType: string,tx?:Transaction,personalOwner?:string): Promise<ObjectInfo & { created: boolean }> {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('object bytes must be a Uint8Array');
    if (!isMediaType(mediaType)) throw new TypeError(`invalid media type ${JSON.stringify(mediaType)}`);
    if (bytes.byteLength > this.#options.maxBytes) {
      throw new LimitError(`文件 ${bytes.byteLength} 字节，超过上限 ${this.#options.maxBytes} 字节；不会截断保存`, {
        detail: { size: bytes.byteLength, limit: this.#options.maxBytes },
      });
    }
    const sha256 = sha256Hex(bytes);
    const created=personalOwner&&this.#options.personalPayloads?await this.#db.transaction(async t=>{
      const scope=await this.#options.personalPayloads!.scope(personalOwner,t);
      const exists=await this.#db.query('SELECT 1 FROM personal_objects WHERE owner=$1 AND epoch=$2 AND sha256=$3',[scope.owner,scope.epoch,sha256],t);
      await this.#options.personalPayloads!.object(personalOwner,bytes,t);return !exists.rows.length;
    },tx):await this.#write(sha256,bytes);
    const result = await this.#db.query(
      `INSERT INTO objects (sha256, size, media_type, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (sha256) DO NOTHING`,
      [sha256, bytes.byteLength, mediaType, this.#options.now().toISOString()],tx,
    );
    const info = await this.stat(sha256,tx);
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
      const privateBytes=await this.#options.personalPayloads?.anyObject(sha256);if(privateBytes)return privateBytes;
      const privateRows=await this.#db.query('SELECT EXISTS(SELECT 1 FROM personal_purges x WHERE x.owner=o.owner AND x.epoch=o.epoch) AS cleared FROM personal_objects o WHERE sha256=$1',[sha256]);if(privateRows.rows.length&&privateRows.rows.every(r=>r.cleared))return null;
      // Registered but gone is data loss (objects are never deleted), not absence.
      if ((await this.stat(sha256)) !== null) throw new IntegrityError('有对象登记，但原件字节丢失；请从备份恢复', { detail: { sha256 } });
      return null;
    }
    if (sha256Hex(bytes) !== sha256) {
      throw new IntegrityError('保存的原件字节与它的 SHA-256 不符（文件被改动或损坏）', { detail: { sha256 } });
    }
    return bytes;
  }

  /** One-time materialization of legacy personal trees/originals before serving requests. */
  async materializePersonalObjects():Promise<void>{
    const personal=this.#options.personalPayloads;if(!personal)return;

    const copy=async(owner:string,hash:string,tree:boolean,depth=0):Promise<void>=>{
      if(depth>64||!isSha256(hash))throw new IntegrityError('个人目录原件结构不完整');
      const bytes=await this.get(hash);if(!bytes)throw new IntegrityError('缺少待迁移的个人原件');
      await this.#db.transaction(tx=>personal.object(owner,bytes,tx));
      if(tree){const value=JSON.parse(Buffer.from(bytes).toString());for(const child of value.children??[])await copy(owner,child.digest,true,depth+1);}
    };
    for(;;){
      const rows=await this.#db.query('SELECT r.digest,r.kind,b.owner FROM records r JOIN personal_record_bindings b ON b.record=r.digest WHERE NOT EXISTS(SELECT 1 FROM personal_legacy_ready d WHERE d.record=r.digest) AND NOT EXISTS(SELECT 1 FROM personal_purges x WHERE x.owner=b.owner AND x.epoch=b.epoch) ORDER BY r.seq LIMIT 100');
      if(!rows.rows.length)break;
      for(const row of rows.rows){
        const record=(await this.#db.query('SELECT * FROM hub_read_records() WHERE digest=$1',[row.digest])).rows[0];
        if(!record)continue;const body=verifiedRecord<Record<string,unknown>>(record).body;
        if(row.kind==='knowledge_space_version'&&body.tree)await copy(String(row.owner),String(body.tree),true);
        if(row.kind==='source_artifact')await copy(String(row.owner),String(body.sha256),false);
        await this.#db.query('SELECT hub_finish_personal_record($1)',[row.digest]);
      }
    }
    const retired=await this.#db.query('SELECT sha256 FROM personal_legacy_retire q WHERE NOT EXISTS(SELECT 1 FROM personal_legacy_retired d WHERE d.sha256=q.sha256)');
    if(!retired.rows.length)return;
    const protectedNodes=new Set<string>();
    const protect=async(hash:string,mounts:ReadonlySet<string>,depth=0):Promise<void>=>{
      if(mounts.has(hash)||protectedNodes.has(hash))return;
      if(depth>64||!isSha256(hash))throw new IntegrityError('团队目录原件结构不完整');
      const bytes=await this.get(hash);if(!bytes)throw new IntegrityError('团队目录原件缺失');
      protectedNodes.add(hash);for(const child of JSON.parse(Buffer.from(bytes).toString()).children??[])await protect(child.digest,mounts,depth+1);
    };
    if(retired.rows.length){
      const roots=await this.#db.query("SELECT r.body FROM records r WHERE kind='knowledge_space_version' AND NOT EXISTS(SELECT 1 FROM personal_record_bindings b WHERE b.record=r.digest)");
      for(const row of roots.rows){const version=JSON.parse(String(row.body));
        // Product roots address tree_node records, not directory object files.
        const mounts=new Set<string>((version.products??[]).map((p:{root:string})=>p.root));
        if(version.tree)await protect(version.tree,mounts);
      }
    }
    const memberHolds=await this.#db.query('SELECT DISTINCT h.sha256 FROM object_holds h WHERE h.members');
    for(const held of memberHolds.rows){const bytes=await this.get(String(held.sha256));if(!bytes)throw new IntegrityError('执行器快照原件缺失');
      for(const hash of Object.values(JSON.parse(Buffer.from(bytes).toString())))if(typeof hash==='string'&&isSha256(hash))protectedNodes.add(hash);
    }
    for(const row of retired.rows){const hash=String(row.sha256);
      // Keep separately held team/product/run originals; audit mentions alone do not own content.
      const independent=await this.#db.query("SELECT 1 FROM object_holds h WHERE h.sha256=$1 AND NOT h.artifact AND NOT EXISTS(SELECT 1 FROM personal_record_bindings b WHERE b.record=h.record) LIMIT 1",[hash]);
      if(!protectedNodes.has(hash)&&!independent.rows.length)await unlink(this.path(hash)).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='ENOENT')throw error;});
      await this.#db.query('SELECT hub_finish_personal_retirement($1)',[hash]);
    }
  }

  async stat(sha256: string,tx?:Transaction): Promise<ObjectInfo | null> {
    if (!isSha256(sha256)) return null;
    const row = (await this.#db.query('SELECT sha256, size, media_type, created_at FROM objects WHERE sha256 = $1', [sha256],tx)).rows[0];
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
