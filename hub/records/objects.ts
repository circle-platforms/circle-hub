import {PersonalPackVersionBody} from '../../contracts/src/sharing.ts';
import {canonicalize} from './canonical.ts';
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
  #pending=new Map<string,Array<{resolve:(bytes:Uint8Array|null)=>void;reject:(error:unknown)=>void}>>();
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

  async put(bytes: Uint8Array, mediaType: string,tx?:Transaction,personalOwner?:string,accountOwned=false): Promise<ObjectInfo & { created: boolean }> {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('object bytes must be a Uint8Array');
    if (!isMediaType(mediaType)) throw new TypeError(`invalid media type ${JSON.stringify(mediaType)}`);
    if (bytes.byteLength > this.#options.maxBytes) {
      throw new LimitError(`文件 ${bytes.byteLength} 字节，超过上限 ${this.#options.maxBytes} 字节；不会截断保存`, {
        detail: { size: bytes.byteLength, limit: this.#options.maxBytes },
      });
    }
    const sha256 = sha256Hex(bytes);
    const created=personalOwner&&this.#options.personalPayloads?await this.#db.transaction(async t=>{
      const scope=await (accountOwned?this.#options.personalPayloads!.account(personalOwner,t):this.#options.personalPayloads!.scope(personalOwner,t));
      const exists=await this.#db.query('SELECT 1 FROM personal_objects WHERE owner=$1 AND epoch=$2 AND sha256=$3',[scope.owner,scope.epoch,sha256],t);
      await this.#options.personalPayloads!.object(personalOwner,bytes,t,accountOwned);return !exists.rows.length;
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

  async get(sha256: string,tx?:Transaction): Promise<Uint8Array | null> {
    if (!isSha256(sha256)) return null;
    if(tx)return (await this.#readBytes([sha256],tx)).get(sha256)??null;
    return new Promise((resolve,reject)=>{
      const waiting=this.#pending.get(sha256);if(waiting){waiting.push({resolve,reject});return;}
      this.#pending.set(sha256,[{resolve,reject}]);
      if(this.#pending.size===1)queueMicrotask(()=>{void this.#flushGets();});
    });
  }

  async #readBytes(hashes:readonly string[],tx?:Transaction):Promise<Map<string,Uint8Array>>{
    const values=new Map<string,Uint8Array>(),missing:string[]=[];
    await Promise.all(hashes.map(async hash=>{
      let bytes:Buffer;try{bytes=await readFile(this.path(hash));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;missing.push(hash);return;}
      if(sha256Hex(bytes)!==hash)throw new IntegrityError('保存的原件字节与它的 SHA-256 不符（文件被改动或损坏）',{detail:{sha256:hash}});
      values.set(hash,bytes);
    }));
    if(missing.length)for(const [hash,bytes]of await this.#databaseBytes(missing,tx))values.set(hash,bytes);
    return values;
  }

  // Same-tick I/O coalescing only: detach before awaiting and retain no completed value or authorization proof.
  async #flushGets():Promise<void>{
    const batch=this.#pending;this.#pending=new Map();
    try{const values=await this.#readBytes([...batch.keys()]);for(const [hash,waiting]of batch)for(const call of waiting)call.resolve(values.has(hash)?Buffer.isBuffer(values.get(hash))?Buffer.from(values.get(hash)!):Uint8Array.from(values.get(hash)!):null);}
    catch{await Promise.all([...batch].map(async([hash,waiting])=>{try{const values=await this.#readBytes([hash]);for(const call of waiting)call.resolve(values.has(hash)?Buffer.isBuffer(values.get(hash))?Buffer.from(values.get(hash)!):Uint8Array.from(values.get(hash)!):null);}catch(error){for(const call of waiting)call.reject(error);}}));}
  }
  async #databaseBytes(hashes:readonly string[],tx?:Transaction):Promise<Map<string,Uint8Array>>{
    // Keep get()'s precedence: independent run/retained holders, then the first active account/epoch payload.
    const rows=await this.#db.query<{sha256:string;data:Buffer|null;independent:boolean;cleared:boolean;registered:boolean}>(`SELECT wanted.sha256,coalesce(h.data,p.data) AS data,h.data IS NOT NULL AS independent,
      EXISTS(SELECT 1 FROM personal_objects o WHERE o.sha256=wanted.sha256)
       AND NOT EXISTS(SELECT 1 FROM personal_objects o WHERE o.sha256=wanted.sha256 AND NOT EXISTS(SELECT 1 FROM personal_purges x WHERE (x.owner,x.epoch)=(o.owner,o.epoch))) AS cleared,
      EXISTS(SELECT 1 FROM objects o WHERE o.sha256=wanted.sha256) AS registered
      FROM unnest($1::text[]) AS wanted(sha256)
      LEFT JOIN LATERAL ((SELECT r.data FROM run_originals r WHERE r.sha256=wanted.sha256 ORDER BY r.artifact LIMIT 1) UNION ALL (SELECT h.data FROM held_objects h WHERE h.sha256=wanted.sha256) LIMIT 1) h ON true
      LEFT JOIN LATERAL (SELECT p.data FROM personal_objects o JOIN personal_payloads p ON (p.owner,p.epoch,p.sha256)=(o.owner,o.epoch,o.sha256)
       WHERE $2::bool AND o.sha256=wanted.sha256 AND NOT EXISTS(SELECT 1 FROM personal_purges x WHERE (x.owner,x.epoch)=(o.owner,o.epoch)) ORDER BY o.owner,o.epoch LIMIT 1) p ON h.data IS NULL`,[hashes,!!this.#options.personalPayloads],tx);
    const values=new Map<string,Uint8Array>();
    for(const row of rows.rows){
      if(row.data!==null){if(sha256Hex(row.data)!==row.sha256)throw new IntegrityError('保存的原件字节与它的 SHA-256 不符（文件被改动或损坏）',{detail:{sha256:row.sha256}});values.set(row.sha256,row.independent?Buffer.from(row.data):Uint8Array.from(row.data));}
      else if(!row.cleared&&row.registered)throw new IntegrityError('有对象登记，但原件字节丢失；请从备份恢复',{detail:{sha256:row.sha256}});
    }
    return values;
  }

  /** One-time materialization of legacy personal trees/originals before serving requests. */
  async materializePersonalObjects():Promise<void>{
    const personal=this.#options.personalPayloads;if(!personal)return;

    // Bound traversal metadata; no source bytes are retained in the cache.
    const copied=new Set<string>(),walked=new Set<string>(),cacheLimit=50_000;
    const remember=(cache:Set<string>,key:string)=>{if(cache.size>=cacheLimit)cache.delete(cache.values().next().value!);cache.add(key);};
    const copy=async(owner:string,epoch:string,hash:string,tree:boolean,depth=0,record?:string):Promise<void>=>{
      if(depth>64||!isSha256(hash))throw new IntegrityError('个人目录原件结构不完整');
      const key=owner+'\0'+epoch+'\0'+hash;
      if(walked.has(key)||copied.has(key)&&!tree)return;
      const bytes=await this.get(hash);if(!bytes)throw new IntegrityError('缺少待迁移的个人原件');
      if(!copied.has(key)){
        const scope=(await this.#db.query('SELECT account_epoch FROM personal_spaces WHERE owner=$1',[owner])).rows[0];
        if(scope?.account_epoch===epoch){if(!record)throw new IntegrityError('私人载荷缺少转移记录');await this.#db.query('SELECT hub_restore_legacy_object($1,$2,$3)',[record,hash,Buffer.from(bytes)]);}
        else await this.#db.transaction(async tx=>{const scope=await personal.scope(owner,tx);if(scope.epoch!==epoch)throw new IntegrityError('个人内容转移的代次已变化');await personal.object(owner,bytes,tx);});
        remember(copied,key);
      }
      if(tree){const value=JSON.parse(Buffer.from(bytes).toString());for(const child of value.children??[])await copy(owner,epoch,child.digest,true,depth+1,record);remember(walked,key);}
    };
    for(;;){
      const rows=await this.#db.query('SELECT r.digest,r.kind,b.owner,b.epoch FROM records r JOIN personal_record_bindings b ON b.record=r.digest WHERE NOT EXISTS(SELECT 1 FROM personal_legacy_ready d WHERE d.record=r.digest) AND NOT EXISTS(SELECT 1 FROM personal_purges x WHERE x.owner=b.owner AND x.epoch=b.epoch) ORDER BY r.seq LIMIT 100');
      if(!rows.rows.length)break;
      for(const row of rows.rows){
        const record=(await this.#db.query('SELECT * FROM hub_read_records() WHERE digest=$1',[row.digest])).rows[0];
        if(!record)continue;const body=verifiedRecord<Record<string,unknown>>(record).body;
        if(row.kind==='knowledge_space_version'&&body.tree)await copy(String(row.owner),String(row.epoch),String(body.tree),true,0,String(row.digest));
        if(row.kind==='source_artifact')await copy(String(row.owner),String(row.epoch),String(body.sha256),false,0,String(row.digest));
        if(row.kind==='personal_pack_version'){
          const pack=PersonalPackVersionBody.parse(body),manifest=Buffer.from(canonicalize(pack.manifest));if(sha256Hex(manifest)!==pack.digest)throw new IntegrityError('私人包清单与冻结摘要不符');
          await copy(String(row.owner),String(row.epoch),pack.digest,false,0,String(row.digest));
          for(const file of pack.manifest.files)await copy(String(row.owner),String(row.epoch),file.sha256,false,0,String(row.digest));
        }
        await this.#db.query('SELECT hub_finish_personal_record($1)',[row.digest]);
      }
    }
    await this.#db.query('SELECT hub_finish_independent_objects()');
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
      if(!protectedNodes.has(hash)&&!independent.rows.length){
        await unlink(this.path(hash)).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='ENOENT')throw error;});
        await this.syncRetirementDirectory(join(this.root,hash.slice(0,2)));
      }
      await this.#db.query('SELECT hub_finish_personal_retirement($1)',[hash]);
    }
  }

  /** Retirement completion must not outrun durable directory removal; failures keep the journal resumable. */
  protected async syncRetirementDirectory(directory:string):Promise<void>{
    const handle=await open(directory,'r');try{await handle.sync();}finally{await handle.close();}
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
