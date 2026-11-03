import {randomUUID} from 'node:crypto';
import {PROTOCOL_CODES} from '../../contracts/generated/protocol.ts';
import {SyncModeSchema,type SyncMode} from '../../contracts/generated/vocabulary.ts';
import {RecordKindSchema} from '../../contracts/src/records.ts';
// Account/epoch-scoped, physically removable payloads. Audit capsules contain no plaintext.
import type {Database} from './db.ts';
import {iso} from './db.ts';
import type {Transaction,Principal,RecordKind} from './api.ts';
import {canonicalize} from './canonical.ts';
import {sha256Hex,envelopeDigest} from './digest.ts';
import {IntegrityError,RecordsError} from './errors.ts';
export const INITIAL_PERSONAL_EPOCH='00000000-0000-4000-8000-000000000001';
export interface PersonalScope {owner:string;epoch:string}
export const isPersonalPackRecord=(kind:RecordKind)=>RecordKindSchema.extract(['personal_pack_version','personal_pack_grant','personal_pack_retirement','personal_pack_transfer']).safeParse(kind).success;
export function personalRecordOwner(kind:RecordKind,body:unknown):string|null{
 if(!RecordKindSchema.extract(['knowledge_space_entry','knowledge_space_version','knowledge_space_source','knowledge_space_grant','memory_document','memory_version','memory_grant','knowledge_source_attribution','personal_pack_version','personal_pack_grant','personal_pack_retirement','personal_pack_transfer']).safeParse(kind).success)return null;
 const space=(body as {space?:unknown})?.space;
 return typeof space==='string'&&/^usr_[0-9a-z]{26}$/.test(space)?space:null;
}
export function captureRecordOwner(body:unknown):string|null{
 const b=body as {origin?:{upload?:unknown;read?:unknown};author?:{user?:unknown};visibility?:{admins?:unknown;readers?:unknown[]}}|null;
 const owner=b?.origin?.upload!=null&&b.visibility?.admins===false?b.author?.user:b?.origin?.read!=null&&b.visibility?.admins===false&&Array.isArray(b.visibility.readers)&&b.visibility.readers.length===1?b.visibility.readers[0]:null;
 return typeof owner==='string'&&/^usr_[0-9a-z]{26}$/.test(owner)?owner:null;
}
export class PgPersonalPayloads {
 beforePurge?:(owner:string,by:Principal,tx:Transaction)=>Promise<void>;
 readonly db:Database;
 readonly lock:(key:string,tx:Transaction)=>Promise<void>;
 constructor(db:Database,lock:(key:string,tx:Transaction)=>Promise<void>){this.db=db;this.lock=lock;}
 /** A missing row is the historical Hub default; reading mode does not create personal content. */
 async mode(owner:string,tx?:Transaction):Promise<SyncMode>{
  const row=(await this.db.query('SELECT mode FROM personal_spaces WHERE owner=$1',[owner],tx)).rows[0];
  return row?SyncModeSchema.parse(row.mode):SyncModeSchema.enum.hub;
 }
 async scope(owner:string,tx?:Transaction):Promise<PersonalScope>{
  if(!tx)return this.db.transaction(t=>this.scope(owner,t));
  await this.lock('knowledge-space:'+owner,tx);
  if(!/^usr_[0-9a-z]{26}$/.test(owner))throw new TypeError('personal owner');
  await this.db.query('INSERT INTO personal_spaces(owner,epoch) VALUES($1,$2) ON CONFLICT DO NOTHING',[owner,INITIAL_PERSONAL_EPOCH],tx);
  const row=(await this.db.query('SELECT epoch,mode FROM personal_spaces WHERE owner=$1',[owner],tx)).rows[0];
  if(row?.mode!==SyncModeSchema.enum.hub)throw new RecordsError(PROTOCOL_CODES.SYNC_MODE_LOCAL.when,{code:'SYNC_MODE_LOCAL'});
  return {owner,epoch:String(row.epoch)};
 }
 /** Non-sync private ownership uses the account row boundary, never a reverse space lock. */
 async account(owner:string,tx?:Transaction):Promise<PersonalScope>{
  if(!tx)return this.db.transaction(t=>this.account(owner,t));
  try{const row=(await this.db.query('SELECT hub_account_scope($1,$2) AS epoch',[owner,randomUUID()],tx)).rows[0];return {owner,epoch:String(row.epoch)};}catch(cause){if(['P0001','P0002','42501'].includes(String((cause as {code?:unknown}).code)))throw new RecordsError(PROTOCOL_CODES.SOURCE_UNAVAILABLE.when,{code:'SOURCE_UNAVAILABLE',cause});throw cause;}
 }
 /** Journal ownership before any pre-publication cache can appear, even if the process later crashes. */
 async stage<T>(owner:string,digest:string,work:()=>Promise<T>):Promise<T>{
  const active=async(tx:Transaction)=>{const row=(await this.db.query('SELECT disabled,deleted_at FROM users WHERE id=$1 FOR SHARE',[owner],tx)).rows[0];if(!row||row.disabled||row.deleted_at)throw new RecordsError(PROTOCOL_CODES.SOURCE_UNAVAILABLE.when,{code:'SOURCE_UNAVAILABLE'});};
  await this.db.transaction(async tx=>{await active(tx);await this.db.query('INSERT INTO personal_cache_installs(owner,digest) VALUES($1,$2) ON CONFLICT DO NOTHING',[owner,digest],tx);});
  return this.db.transaction(async tx=>{await active(tx);return work();});
 }
 /** Internal frozen readers hold the account row until extraction finishes; this grants no reader ACL. */
 async holdPack(owner:string,digest:string,tx:Transaction):Promise<boolean>{
  const user=(await this.db.query('SELECT deleted_at FROM users WHERE id=$1 FOR SHARE',[owner],tx)).rows[0];
  return !!user&&(!user.deleted_at||!!(await this.db.query('SELECT 1 FROM run_pack_records WHERE owner=$1 AND digest=$2',[owner,digest],tx)).rowCount);
 }
 async put(scope:PersonalScope,bytes:Uint8Array,tx?:Transaction):Promise<string>{
  if(!tx)return this.db.transaction(t=>this.put(scope,bytes,t));
  const state=(await this.db.query("SELECT pg_catalog.to_jsonb(s)->>'account_epoch' AS account_epoch FROM personal_spaces s WHERE owner=$1",[scope.owner],tx)).rows[0];
  const account=state?.account_epoch===scope.epoch;
  if(account){const user=(await this.db.query('SELECT disabled,deleted_at FROM users WHERE id=$1 FOR SHARE',[scope.owner],tx)).rows[0];if(!user||user.disabled||user.deleted_at)throw new RecordsError(PROTOCOL_CODES.SOURCE_UNAVAILABLE.when,{code:'SOURCE_UNAVAILABLE'});}
  else await this.lock('knowledge-space:'+scope.owner,tx);
  bytes=Uint8Array.from(bytes);
  const hash=sha256Hex(bytes);
  const row=await this.db.query("SELECT epoch,mode,pg_catalog.to_jsonb(s)->>'account_epoch' AS account_epoch FROM personal_spaces s WHERE owner=$1",[scope.owner],tx);
  if(account?row.rows[0]?.account_epoch!==scope.epoch:row.rows[0]?.epoch!==scope.epoch||row.rows[0]?.mode!==SyncModeSchema.enum.hub)throw new RecordsError(PROTOCOL_CODES.SYNC_EPOCH_CHANGED.when,{code:'SYNC_EPOCH_CHANGED'});
  await this.db.query('INSERT INTO personal_payloads(owner,epoch,sha256,data) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[scope.owner,scope.epoch,hash,Buffer.from(bytes)],tx);
  const found=await this.get(scope,hash,tx);if(!found||!Buffer.from(found).equals(Buffer.from(bytes)))throw new IntegrityError('个人载荷不符合摘要');
  return hash;
 }
 async get(scope:PersonalScope,hash:string,tx?:Transaction):Promise<Uint8Array|null>{
  const rows=await this.db.query('SELECT p.data FROM personal_payloads p WHERE p.owner=$1 AND p.epoch=$2 AND p.sha256=$3 AND NOT EXISTS(SELECT 1 FROM personal_purges x WHERE x.owner=p.owner AND x.epoch=p.epoch)',[scope.owner,scope.epoch,hash],tx);
  if(!rows.rows.length)return null;const bytes=rows.rows[0].data as Buffer;
  if(sha256Hex(bytes)!==hash)throw new IntegrityError('个人载荷不符合摘要');return bytes;
 }
 async bind(scope:PersonalScope,digest:string,meta:{created_at:string;kind:string;provenance:string;schema:string},body:string,tx:Transaction):Promise<string>{
  const hash=await this.put(scope,Buffer.from(body),tx),size=Buffer.byteLength(body);
  const proof=sha256Hex([digest,hash,scope.owner,scope.epoch,size,meta.created_at,meta.kind,meta.provenance,meta.schema].join(':'));
  const marker=canonicalize({personal_payload:hash,owner:scope.owner,epoch:scope.epoch,record:digest,proof});
  await this.db.query('INSERT INTO personal_record_bindings(record,owner,epoch,sha256,bytes,marker,proof) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',[digest,scope.owner,scope.epoch,hash,size,marker,proof],tx);
  const binding=(await this.db.query('SELECT marker,owner,epoch FROM personal_record_bindings WHERE record=$1',[digest],tx)).rows[0];
  if(binding.owner!==scope.owner||binding.epoch!==scope.epoch)throw new RecordsError(PROTOCOL_CODES.SYNC_EPOCH_CHANGED.when,{code:'SYNC_EPOCH_CHANGED'});
  return String(binding.marker);
 }
 async object(owner:string,bytes:Uint8Array,tx:Transaction,accountOwned=false):Promise<string>{
  const scope=await (accountOwned?this.account(owner,tx):this.scope(owner,tx)),hash=await this.put(scope,bytes,tx);
  await this.db.query('INSERT INTO personal_objects(owner,epoch,sha256) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[owner,scope.epoch,hash],tx);return hash;
 }
 async anyObject(hash:string,tx?:Transaction):Promise<Uint8Array|null>{
  const rows=await this.db.query('SELECT o.owner,o.epoch FROM personal_objects o WHERE sha256=$1 AND NOT EXISTS(SELECT 1 FROM personal_purges x WHERE x.owner=o.owner AND x.epoch=o.epoch) ORDER BY owner,epoch',[hash],tx);
  for(const row of rows.rows){const bytes=await this.get({owner:String(row.owner),epoch:String(row.epoch)},hash,tx);if(bytes)return bytes;}return null;
 }
 /** Metadata-only, monotonic flag for authorized views; no personal plaintext is loaded. */
 async cleared(digest:string,tx?:Transaction):Promise<boolean>{
  return (await this.db.query('SELECT 1 FROM personal_record_bindings b JOIN personal_purges p ON (p.owner,p.epoch)=(b.owner,b.epoch) WHERE b.record=$1',[digest],tx)).rowCount===1;
 }
 async inspect(digest:string,tx?:Transaction){
  const row=(await this.db.query('SELECT r.*,b.owner,b.epoch,b.sha256,b.bytes,b.marker,b.proof,EXISTS(SELECT 1 FROM personal_purges x WHERE x.owner=b.owner AND x.epoch=b.epoch) AS cleared FROM records r JOIN personal_record_bindings b ON b.record=r.digest WHERE r.digest=$1',[digest],tx)).rows[0];
  if(!row)return null;
  const meta={created_at:iso(row.created_at),kind:String(row.kind),provenance:String(row.provenance),schema:String(row.schema)};
  const proof=sha256Hex([digest,row.sha256,row.owner,row.epoch,row.bytes,meta.created_at,meta.kind,meta.provenance,meta.schema].join(':'));
  if(row.body!==row.marker||proof!==row.proof)throw new IntegrityError('个人记录摘要链不符');
  if(!row.cleared){const bytes=await this.get({owner:String(row.owner),epoch:String(row.epoch)},String(row.sha256),tx);if(!bytes||bytes.length!==Number(row.bytes)||envelopeDigest(meta,Buffer.from(bytes).toString())!==digest)throw new IntegrityError('个人记录载荷不完整');}
  return {digest,owner:String(row.owner),epoch:String(row.epoch),sha256:String(row.sha256),cleared:row.cleared===true};
 }
 async purge(by:Principal,epoch:string,outer?:Transaction):Promise<void>{
  await this.db.transaction(async tx=>{
   const user=(await this.db.query('SELECT disabled FROM users WHERE id=$1',[by.id],tx)).rows[0];
   if(!user||user.disabled)throw new RecordsError(PROTOCOL_CODES.SOURCE_UNAVAILABLE.when,{code:'SOURCE_UNAVAILABLE'});
   // Same namespace and lock order as knowledge and memory writes.
   await this.lock('knowledge-space:'+by.id,tx);
   await this.beforePurge?.(by.id,by,tx);
   await this.db.query('SELECT hub_purge_personal($1,$2)',[by.id,epoch],tx);
  },outer);
 }
}
