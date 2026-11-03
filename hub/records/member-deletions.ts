import {retirePersonalCaches} from './personal-caches.ts';
import {isAbsolute} from 'node:path';
// Administrator coordination shares the native payload purger; progress contains digests and counts only.
import {MemberDeletionBody,MemberDeletionCounts,type MemberDeletionBody as Receipt} from '../../contracts/src/spaces.ts';
import {PermissionRoleSchema} from '../../contracts/generated/vocabulary.ts';
import {canonicalize} from './canonical.ts';
import {parseStrictJson} from './strict-json.ts';
import {RecordKindSchema} from '../../contracts/src/records.ts';
import {sha256Hex} from './digest.ts';
import {iso} from './db.ts';
import type {Database} from './db.ts';
import type {Principal,RecordStore,Transaction} from './api.ts';
import {AccessError,ConflictError,RecordsError} from './errors.ts';
import {lockAdministratorSet} from './principals.ts';
import {INITIAL_PERSONAL_EPOCH} from './personal-payloads.ts';
import type {PgPersonalPayloads} from './personal-payloads.ts';
export interface MemberDeletionScopeCounts {knowledge:number;memory:number;originals:number;attributions:number;archived_originals:number;private_versions:number}
export interface MemberDeletionPreview {member:string;epoch:string;state:string;purge_manifest:string;counts:Receipt['counts'];scope_counts:MemberDeletionScopeCounts}
export class PgMemberDeletions {
 readonly cacheRoots=new Set<string>();
 registerCacheRoot(root:string){if(!isAbsolute(root))throw new TypeError('private cache root');this.cacheRoots.add(root);}
 readonly db:Database;readonly store:RecordStore;readonly payloads:Pick<PgPersonalPayloads,'purge'|'scope'|'inspect'|'beforePurge'>;readonly retire:()=>Promise<void>;readonly now:()=>Date;
 constructor(db:Database,store:RecordStore,payloads:Pick<PgPersonalPayloads,'purge'|'scope'|'inspect'|'beforePurge'>,retire:()=>Promise<void>,now:()=>Date){this.db=db;this.store=store;this.payloads=payloads;this.retire=retire;this.now=now;}
 async #admin(by:Principal,tx?:Transaction){const user=(await this.db.query('SELECT * FROM users WHERE id=$1'+(tx?' FOR SHARE':''),[by.id],tx)).rows[0];if(!user||user.disabled||user.role!==PermissionRoleSchema.enum.admin)throw new AccessError('对象不存在或无权读取');}
 async #preview(member:string,tx?:Transaction):Promise<MemberDeletionPreview>{
  const user=(await this.db.query('SELECT * FROM users WHERE id=$1',[member],tx)).rows[0];if(!user||user.deleted_at)throw new AccessError('对象不存在或无权读取');
  if(user.role===PermissionRoleSchema.enum.admin&&!user.disabled&&!(await this.db.query('SELECT 1 FROM users WHERE role=$1 AND NOT disabled AND id<>$2',[PermissionRoleSchema.enum.admin,member],tx)).rowCount)throw new ConflictError('至少须保留一名启用的管理员');
  if((await this.db.query("SELECT 1 FROM records r JOIN record_index i ON i.digest=r.digest AND i.key='personal.pack.owner' WHERE r.kind='personal_pack_version' AND i.value=$1 AND NOT EXISTS(SELECT 1 FROM personal_record_bindings b WHERE b.record=r.digest) LIMIT 1",[member],tx)).rowCount)throw new ConflictError('私人包清除准备尚未完成，不能删除成员');
  const unscoped=await this.db.query(`SELECT 1 FROM records r JOIN record_index i ON i.digest=r.digest AND i.key IN ('artifact.author','artifact.reader') AND i.value=$1
   CROSS JOIN LATERAL (SELECT pg_catalog.replace(r.body,pg_catalog.chr(92)||'u0000',pg_catalog.chr(92)||'u0001')::pg_catalog.jsonb AS b) x
   WHERE r.kind='source_artifact' AND NOT EXISTS(SELECT 1 FROM personal_record_bindings q WHERE q.record=r.digest)
   AND public.hub_capture_owner(x.b)=$1 LIMIT 1`,[member],tx);
  if(unscoped.rowCount)throw new ConflictError('私人原文清除准备尚未完成，不能删除成员');
  try{await this.db.query('SELECT hub_check_member_holders($1)',[member],tx);}catch(cause){throw new ConflictError('已有任务的冻结副本无法核对，不能删除成员',{cause});}
  const scope=(await this.db.query('SELECT epoch FROM personal_spaces WHERE owner=$1',[member],tx)).rows[0];
  const records=(await this.db.query(`SELECT b.record,r.kind,CASE WHEN r.kind='personal_pack_version' THEN pg_catalog.convert_from(v.data,'UTF8') END AS pack_body
   FROM personal_record_bindings b JOIN records r ON r.digest=b.record
   LEFT JOIN personal_payloads v ON r.kind='personal_pack_version' AND (v.owner,v.epoch,v.sha256)=(b.owner,b.epoch,b.sha256)
   WHERE b.owner=$1 AND NOT EXISTS(SELECT 1 FROM personal_purges p WHERE (p.owner,p.epoch)=(b.owner,b.epoch)) ORDER BY b.record`,[member],tx)).rows;
  const payloads=(await this.db.query('SELECT epoch,sha256 FROM personal_payloads WHERE owner=$1 ORDER BY epoch,sha256',[member],tx)).rows;
  const objects=(await this.db.query('SELECT o.epoch,o.sha256 FROM personal_objects o WHERE owner=$1 AND NOT EXISTS(SELECT 1 FROM personal_purges p WHERE (p.owner,p.epoch)=(o.owner,o.epoch)) ORDER BY epoch,sha256',[member],tx)).rows;
  const caches=(await this.db.query('SELECT digest FROM personal_cache_installs WHERE owner=$1 ORDER BY digest',[member],tx)).rows.map(row=>String(row.digest));
  const holders=(await this.db.query(`SELECT 'original' AS category,h.record AS holder,h.sha256 AS node FROM object_holds h JOIN personal_record_bindings b ON b.record=h.sha256 WHERE h.artifact AND b.owner=$1 AND NOT EXISTS(SELECT 1 FROM personal_record_bindings p WHERE p.record=h.record)
   UNION ALL SELECT 'pack',held_by,sha256 FROM held_object_targets WHERE owner=$1
   UNION ALL SELECT 'sharing',digest,digest FROM record_index WHERE key IN ('knowledge.share.by','memory.share.by') AND value=$1 ORDER BY category,holder,node`,[member],tx)).rows;
  const counts=MemberDeletionCounts.parse({records:records.length,payloads:payloads.length,objects:objects.length,attributions:records.filter(r=>r.kind==='knowledge_source_attribution').length,archives:records.filter(r=>r.kind==='knowledge_space_source').length,private_versions:records.filter(r=>r.kind==='personal_pack_version').length});
  // Display categories count scoped content versions/captures, never payload blobs or shared hashes.
  // Only an exact file-capture relation excludes a pack file from the original-document category.
  const packFiles=new Set<string>();for(const record of records)if(record.kind===RecordKindSchema.enum.personal_pack_version&&typeof record.pack_body==='string'){
   const body=parseStrictJson(record.pack_body) as {files?:Record<string,unknown>};for(const capture of Object.values(body.files??{}))if(typeof capture==='string')packFiles.add(capture);
  }
  const scope_counts:MemberDeletionScopeCounts={knowledge:records.filter(r=>r.kind===RecordKindSchema.enum.knowledge_space_entry).length,memory:records.filter(r=>r.kind===RecordKindSchema.enum.memory_version).length,originals:records.filter(r=>r.kind===RecordKindSchema.enum.source_artifact&&!packFiles.has(r.record as string)).length,attributions:counts.attributions,archived_originals:counts.archives,private_versions:counts.private_versions};
  const purge_manifest=sha256Hex(canonicalize({records:records.map(r=>r.record),payloads,objects,caches})),epoch=scope?String(scope.epoch):INITIAL_PERSONAL_EPOCH;
  return {member,epoch,purge_manifest,counts,scope_counts,state:sha256Hex(canonicalize({member,epoch,purge_manifest,counts,holders,role:user.role,disabled:user.disabled,updated_at:iso(user.updated_at)}))};
 }
 async preview(by:Principal,member:string){await this.#admin(by);return this.store.withTransaction(async tx=>{await this.store.lock('knowledge-space:'+member,tx);await this.#admin(by,tx);return this.#preview(member,tx);});}
 async status(by:Principal,member:string){return this.store.withTransaction(async tx=>{
  await this.#admin(by,tx);const intent=await this.intent(member,tx);if(!intent)return null;
  const row=await this.store.getByKey<Receipt>('member_deletion',intent.operation_id,tx);
  return {intent,result:row?{record:row.digest,...MemberDeletionBody.parse(row.body)}:null};
 });}
 async prepare(by:Principal,input:Omit<MemberDeletionPreview,'scope_counts'>&{operation_id:string}):Promise<Receipt>{
  // Parse the operation and immutable manifest before touching an identity.
  MemberDeletionBody.parse({operation_id:input.operation_id,member:input.member,epoch:input.epoch,purge_manifest:input.purge_manifest,counts:input.counts,by:by.id,at:this.now().toISOString()});
  return this.store.withTransaction(async tx=>{
   await this.store.lock('knowledge-space:'+input.member,tx);
   await lockAdministratorSet(this.db,tx);
   const intent=await this.intent(input.member,tx);
   if(intent){await this.#admin(by,tx);if(intent.operation_id!==input.operation_id||intent.epoch!==input.epoch||intent.purge_manifest!==input.purge_manifest||canonicalize(intent.counts)!==canonicalize(input.counts))throw new ConflictError('删除操作与已记录的操作不符');return intent;}
   await this.#admin(by,tx);
   const user=(await this.db.query('SELECT updated_at FROM users WHERE id=$1 FOR UPDATE',[input.member],tx)).rows[0];
   const current=await this.#preview(input.member,tx);if(current.state!==input.state||current.epoch!==input.epoch||current.purge_manifest!==input.purge_manifest||canonicalize(current.counts)!==canonicalize(input.counts))throw new ConflictError('成员或清除范围已变化，请重新检查');
   const receipt=MemberDeletionBody.parse({operation_id:input.operation_id,member:input.member,epoch:input.epoch,purge_manifest:input.purge_manifest,counts:input.counts,by:by.id,at:this.now().toISOString()});
   try{await this.db.query('SELECT hub_begin_member_deletion($1,$2,$3,$4,$5,$6,$7,$8)',[by.id,input.member,input.epoch,input.operation_id,input.purge_manifest,JSON.stringify(input.counts),receipt.at,user.updated_at],tx);}catch(cause){throw new ConflictError('删除检查未通过；成员、清除范围或存储准备已变化',{cause});}
   return receipt;
  });
 }
 async intent(member:string,tx?:Transaction):Promise<Receipt|null>{
  const r=(await this.db.query('SELECT * FROM member_deletion_intents WHERE member=$1',[member],tx)).rows[0];return r?MemberDeletionBody.parse({operation_id:r.operation_id,member:r.member,by:r.by_user,epoch:r.epoch,at:iso(r.at),purge_manifest:r.purge_manifest,counts:r.counts}):null;
 }
 async finish(by:Principal,member:string,operation_id:string){
  const intent=await this.intent(member);if(!intent||intent.operation_id!==operation_id)throw new ConflictError('没有对应的删除操作');
  // Self-deletion may finish only its already authorized operation; no new operation is admitted by a tombstone.
  if(by.id!==member||intent.by!==by.id)await this.#admin(by);
  try{await this.retire();await retirePersonalCaches(this.db,member,this.cacheRoots);}catch(cause){throw new RecordsError('私人内容的存储清理未完成，请修复存储后重试同一删除操作',{cause});}
  return this.store.withTransaction(async tx=>{
   await this.store.lock('knowledge-space:'+member,tx);
   if(by.id!==member||intent.by!==by.id)await this.#admin(by,tx);
   const existing=await this.store.getByKey<Receipt>('member_deletion',operation_id,tx);if(existing)return {record:existing.digest,...MemberDeletionBody.parse(existing.body)};
   await this.payloads.beforePurge?.(member,by,tx);
   try{await this.db.query('SELECT hub_finish_member_deletion($1,$2)',[member,operation_id],tx);}catch(cause){throw new ConflictError('私人内容尚未完成清除，请修复存储后重试同一删除操作',{cause});}
   const record=await this.store.put({kind:'member_deletion',schema:'member-deletion@1',provenance:'observed',body:{...intent,by:by.id,at:this.now().toISOString()},unique_key:operation_id,index:[{key:'member.deletion.member',value:member}]},tx);
   return {record:record.digest,...MemberDeletionBody.parse(record.body)};
  });
 }
}
