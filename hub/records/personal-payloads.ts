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
export function personalRecordOwner(kind:RecordKind,body:unknown):string|null{
 if(!RecordKindSchema.extract(['knowledge_space_entry','knowledge_space_version','knowledge_space_source','knowledge_space_grant','memory_document','memory_version','memory_grant']).safeParse(kind).success)return null;
 const space=(body as {space?:unknown})?.space;
 return typeof space==='string'&&/^usr_[0-9a-z]{26}$/.test(space)?space:null;
}
export class PgPersonalPayloads {
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
 async put(scope:PersonalScope,bytes:Uint8Array,tx?:Transaction):Promise<string>{
  if(!tx)return this.db.transaction(t=>this.put(scope,bytes,t));
  await this.lock('knowledge-space:'+scope.owner,tx);
  bytes=Uint8Array.from(bytes);
  const hash=sha256Hex(bytes);
  const row=await this.db.query('SELECT epoch,mode FROM personal_spaces WHERE owner=$1',[scope.owner],tx);
  if(row.rows[0]?.epoch!==scope.epoch||row.rows[0]?.mode!==SyncModeSchema.enum.hub)throw new RecordsError(PROTOCOL_CODES.SYNC_EPOCH_CHANGED.when,{code:'SYNC_EPOCH_CHANGED'});
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
 async object(owner:string,bytes:Uint8Array,tx:Transaction):Promise<string>{
  const scope=await this.scope(owner,tx),hash=await this.put(scope,bytes,tx);
  await this.db.query('INSERT INTO personal_objects(owner,epoch,sha256) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[owner,scope.epoch,hash],tx);return hash;
 }
 async anyObject(hash:string):Promise<Uint8Array|null>{
  const rows=await this.db.query('SELECT o.owner,o.epoch FROM personal_objects o WHERE sha256=$1 AND NOT EXISTS(SELECT 1 FROM personal_purges x WHERE x.owner=o.owner AND x.epoch=o.epoch) ORDER BY owner,epoch',[hash]);
  for(const row of rows.rows){const bytes=await this.get({owner:String(row.owner),epoch:String(row.epoch)},hash);if(bytes)return bytes;}return null;
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
   await this.db.query('SELECT hub_purge_personal($1,$2)',[by.id,epoch],tx);
  },outer);
 }
}
