// Scoped transport storage only: uploaded objects never become knowledge, memory or executable packs here.
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {PROTOCOL_CODES,type ProtocolCode} from '../../contracts/generated/protocol.ts';
import {SyncModeSchema,SyncStatusSchema,SyncObjectKindSchema,type SyncObjectKind} from '../../contracts/generated/vocabulary.ts';
import {PERSONAL_SYNC_LIMITS,PERSONAL_SYNC_HTTP_ROUTES,PersonalSyncClient,PersonalSyncSession,PersonalSyncUpload,PersonalSyncMissing,PersonalSyncAbort,PersonalSyncReceipt,PersonalSyncState,PersonalSyncDescriptor,PersonalSyncItem,type PersonalSyncObject} from '../../contracts/src/sync.ts';
import {decodePersonalSyncObject,encodePersonalSyncObject,normalizePersonalSyncText} from '../../contracts/src/sync-canonical.ts';
import {SpaceQuotaBody} from '../../contracts/src/spaces.ts';
import type {Limits} from '../config/index.ts';
import type {Principal,Transaction,RecordStore} from './api.ts';
import type {Database,Row} from './db.ts';
import {iso} from './db.ts';
import {canonicalize} from './canonical.ts';
import {sha256Hex} from './digest.ts';
import {RecordsError,IntegrityError} from './errors.ts';
import {scanForCredentials} from './scan.ts';
import {INITIAL_PERSONAL_EPOCH,type PersonalScope,type PgPersonalPayloads} from './personal-payloads.ts';

type State=z.infer<typeof PersonalSyncState>;
type Receipt=z.infer<typeof PersonalSyncReceipt>;
type Descriptor=z.infer<typeof PersonalSyncDescriptor>;
interface Scope extends PersonalScope {mode:z.infer<typeof SyncModeSchema>}
interface SessionRow extends Row {id:string;snapshot:string;state_version:string;expires_at:Date;aborted:boolean}
const fail=(code:ProtocolCode):never=>{throw new RecordsError(PROTOCOL_CODES[code].when,{code});};
const hash=(value:unknown)=>sha256Hex(canonicalize(value));
const uuid=z.uuid();
const operationId=PersonalSyncAbort.shape.operation_id;
const objectKinds=SyncObjectKindSchema.enum;
const emptySnapshot=encodePersonalSyncObject({schema:'personal-sync-object@1',kind:objectKinds.snapshot,body:{parents:[],pages:[]}});
const emptySnapshotId=sha256Hex(emptySnapshot);

/** No model-facing routes: each method receives an already authenticated account and rechecks its current status. */
export class PgPersonalSync {
 readonly #db:Database;readonly #store:RecordStore;readonly #payloads:PgPersonalPayloads;
 readonly #now:()=>Date;readonly #limits:Limits;
 readonly limits:State['limits'];
 constructor(db:Database,store:RecordStore,payloads:PgPersonalPayloads,limits:Limits,now:()=>Date){
  this.#db=db;this.#store=store;this.#payloads=payloads;this.#limits=limits;this.#now=now;
  let batchObjects:number=PERSONAL_SYNC_LIMITS.batchObjects;
  while(batchObjects>1&&limits.maxRequestBytes-512-batchObjects*128<1024)batchObjects=Math.floor(batchObjects/2);
  const batchBytes=Math.min(limits.maxSyncBatchBytes,Math.floor((limits.maxRequestBytes-512-batchObjects*128)*3/4));
  if(batchBytes<1)throw new TypeError('sync request budget');
  this.limits=Object.freeze({object_bytes:Math.min(PERSONAL_SYNC_LIMITS.objectBytes,batchBytes),batch_bytes:batchBytes,batch_objects:batchObjects,page_items:Math.min(PERSONAL_SYNC_LIMITS.pageItems,Math.max(1,Math.floor((limits.maxRequestBytes-512)/200))),session_seconds:PERSONAL_SYNC_LIMITS.sessionSeconds});
 }
 async #scope<T>(by:Principal,epoch:string|undefined,work:(scope:Scope,tx:Transaction)=>Promise<T>,outer?:Transaction,allowLocal=false):Promise<T>{
  return this.#db.transaction(async tx=>{
   await this.#store.lock('knowledge-space:'+by.id,tx);
   const user=(await this.#db.query('SELECT disabled FROM users WHERE id=$1 FOR SHARE',[by.id],tx)).rows[0];
   if(!user||user.disabled)return fail('SOURCE_UNAVAILABLE');
   await this.#db.query('INSERT INTO personal_spaces(owner,epoch) VALUES($1,$2) ON CONFLICT DO NOTHING',[by.id,INITIAL_PERSONAL_EPOCH],tx);
   const row=(await this.#db.query('SELECT epoch,mode FROM personal_spaces WHERE owner=$1',[by.id],tx)).rows[0];
   const scope={owner:by.id,epoch:String(row.epoch),mode:SyncModeSchema.parse(row.mode)};
   if(epoch!==undefined&&epoch!==scope.epoch)return fail('SYNC_EPOCH_CHANGED');
   if(scope.mode!==SyncModeSchema.enum.hub&&!allowLocal)return fail('SYNC_MODE_LOCAL');
   await this.#db.query('INSERT INTO personal_sync_heads(owner,epoch) VALUES($1,$2) ON CONFLICT DO NOTHING',[by.id,scope.epoch],tx);
   return work(scope,tx);
  },outer);
 }
 async #usage(scope:Scope,tx:Transaction){
  const native=(await this.#db.query("SELECT r.digest,r.body FROM hub_read_records() r JOIN personal_record_bindings b ON b.record=r.digest WHERE b.owner=$1 AND b.epoch=$2 AND r.kind='knowledge_space_version' ORDER BY r.seq DESC LIMIT 1",[scope.owner,scope.epoch],tx)).rows[0];
  const knowledge=native?JSON.parse(String(native.body)).used_bytes??0:0;
  const memory=(await this.#db.query('SELECT history_bytes FROM memory_space_usage WHERE space=$1',[scope.owner],tx)).rows[0];
  const extra=(await this.#db.query(`SELECT COALESCE(sum(charge),0)::text AS bytes,bool_or(charge IS NULL) AS missing FROM (
    SELECT id,charge_bytes AS charge FROM personal_sync_objects WHERE owner=$1 AND epoch=$2 UNION
    SELECT c.name_payload,octet_length(p.data) FROM personal_sync_clients c LEFT JOIN personal_payloads p
    ON (p.owner,p.epoch,p.sha256)=(c.owner,c.epoch,c.name_payload) WHERE c.owner=$1 AND c.epoch=$2
   ) x`,[scope.owner,scope.epoch],tx)).rows[0];
  if(extra.missing&&scope.mode===SyncModeSchema.enum.hub)throw new IntegrityError('同步元数据载荷不完整');
  const quota=(await this.#store.find({key:'knowledge.space.quota',value:scope.owner,kind:'knowledge_space_quota',newestFirst:true,limit:1},tx)).items[0];
  const capacity=quota?SpaceQuotaBody.parse(quota.body).bytes:1024**3;
  const used=scope.mode===SyncModeSchema.enum.local?0:Number(knowledge)+Number(memory?.history_bytes??0)+Number(extra.bytes);
  if(!Number.isSafeInteger(used)||used<0)throw new IntegrityError('个人容量计量不完整');
  return {used,capacity,knowledge:native?.digest??null};
 }
 async #capacity(scope:Scope,tx:Transaction){const usage=await this.#usage(scope,tx);if(usage.used>usage.capacity)fail('SPACE_CAPACITY_EXCEEDED');}
 async #state(scope:Scope,tx:Transaction):Promise<State>{
  const head=(await this.#db.query('SELECT snapshot,last_synced_at FROM personal_sync_heads WHERE owner=$1 AND epoch=$2',[scope.owner,scope.epoch],tx)).rows[0];
  const usage=await this.#usage(scope,tx);
  const memory=(await this.#db.query('SELECT document,version FROM memory_heads WHERE space=$1 ORDER BY document',[scope.owner],tx)).rows;
  const active=(await this.#db.query('SELECT 1 FROM personal_sync_sessions s WHERE owner=$1 AND epoch=$2 AND expires_at>$3 AND NOT EXISTS(SELECT 1 FROM personal_sync_aborts a WHERE a.session_id=s.id) LIMIT 1',[scope.owner,scope.epoch,this.#now().toISOString()],tx)).rowCount;
  const local=scope.mode===SyncModeSchema.enum.local,snapshot=local?null:head.snapshot===null?null:String(head.snapshot);
  return PersonalSyncState.parse({epoch:scope.epoch,mode:scope.mode,status:active&&!local?SyncStatusSchema.enum.syncing:head.last_synced_at&&!local?SyncStatusSchema.enum.complete:SyncStatusSchema.enum.idle,
   state_version:hash({epoch:scope.epoch,mode:scope.mode,snapshot,knowledge:usage.knowledge,memory}),snapshot,last_synced_at:local||!head.last_synced_at?null:iso(head.last_synced_at),used_bytes:usage.used,capacity_bytes:usage.capacity,limits:this.limits});
 }
 state(by:Principal,outer?:Transaction):Promise<State>{return this.#scope(by,undefined,async(scope,tx)=>{if(scope.mode===SyncModeSchema.enum.hub)await this.#collect(scope,tx);return this.#state(scope,tx);},outer,true);}
 async stableItem(by:Principal,kind:z.infer<typeof PersonalSyncItem>['kind'],identity:string,outer?:Transaction):Promise<string>{
  PersonalSyncItem.shape.kind.parse(kind);if(!identity||Buffer.byteLength(identity)>4000)return fail('SYNC_OBJECT_INVALID');
  return this.#scope(by,undefined,async(scope,tx)=>{
   const key=hash(identity);await this.#db.query('INSERT INTO personal_sync_identities(owner,epoch,kind,identity,item_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[scope.owner,scope.epoch,kind,key,randomUUID()],tx);
   return String((await this.#db.query('SELECT item_id FROM personal_sync_identities WHERE owner=$1 AND epoch=$2 AND kind=$3 AND identity=$4',[scope.owner,scope.epoch,kind,key],tx)).rows[0].item_id);
  },outer);
 }
 async registerClient(by:Principal,input:unknown):Promise<z.infer<typeof PersonalSyncClient>>{
  return this.#scope(by,undefined,async(scope,tx)=>{
   await this.#collect(scope,tx);
   const parsed=PersonalSyncClient.safeParse(input);if(!parsed.success)return fail('SYNC_OBJECT_INVALID');
   const normalized=PersonalSyncClient.safeParse({...parsed.data,name:normalizePersonalSyncText(parsed.data.name)});if(!normalized.success)return fail('SYNC_OBJECT_INVALID');const client=normalized.data;
   this.#scan(Buffer.from(client.name),'SPACE_CREDENTIALS_DETECTED',true);
   const bytes=Buffer.from(canonicalize(client)),id=sha256Hex(bytes);
   const old=(await this.#db.query('SELECT name_payload FROM personal_sync_clients WHERE owner=$1 AND epoch=$2 AND client_id=$3',[scope.owner,scope.epoch,client.client_id],tx)).rows[0];
   if(old&&old.name_payload!==id)return fail('IDEMPOTENCY_MISMATCH');
   await this.#payloads.put(scope,bytes,tx);
   await this.#db.query('INSERT INTO personal_sync_clients VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[scope.owner,scope.epoch,client.client_id,id],tx);
   await this.#capacity(scope,tx);return client;
  });
 }
 async #collect(scope:Scope,tx:Transaction){await this.#db.query('SELECT hub_collect_personal_sync($1,$2,$3)',[scope.owner,scope.epoch,this.#now().toISOString()],tx);}
 async collect(by:Principal,epoch:string):Promise<void>{await this.#scope(by,epoch,(scope,tx)=>this.#collect(scope,tx));}
 async openSession(by:Principal,input:unknown){
  return this.#scope(by,undefined,async(scope,tx)=>{
   const parsed=PersonalSyncSession.safeParse(input);if(!parsed.success)return fail('SYNC_OBJECT_INVALID');const request=parsed.data;
   if(request.epoch!==scope.epoch)return fail('SYNC_EPOCH_CHANGED');
   const client=await this.#db.query('SELECT 1 FROM personal_sync_clients WHERE owner=$1 AND epoch=$2 AND client_id=$3',[scope.owner,scope.epoch,request.client_id],tx);if(!client.rowCount)return fail('SOURCE_UNAVAILABLE');
   await this.#collect(scope,tx);
   const state=await this.#state(scope,tx);
   if(request.base_snapshot!==null){const base=await this.#db.query('SELECT 1 FROM personal_sync_retained r JOIN personal_sync_objects x ON (x.owner,x.epoch,x.id)=(r.owner,r.epoch,r.object_id) WHERE r.owner=$1 AND r.epoch=$2 AND r.object_id=$3 AND x.kind=$4',[scope.owner,scope.epoch,request.base_snapshot,objectKinds.snapshot],tx);if(!base.rowCount)return fail('SOURCE_UNAVAILABLE');}
   const id=randomUUID(),expires=new Date(this.#now().getTime()+this.limits.session_seconds*1000).toISOString(),snapshot=state.snapshot??emptySnapshotId;
   if(state.snapshot===null)await this.#saveObject(scope,emptySnapshotId,emptySnapshot,objectKinds.snapshot,tx);
   await this.#db.query('INSERT INTO personal_sync_sessions VALUES($1,$2,$3,$4,$5,$6,$7)',[id,scope.owner,scope.epoch,request.client_id,snapshot,state.state_version,expires],tx);
   await this.#db.query(`WITH RECURSIVE reachable(id) AS (SELECT $4::text UNION SELECT e.child FROM personal_sync_edges e JOIN reachable r ON e.parent=r.id WHERE e.owner=$2 AND e.epoch=$3)
    INSERT INTO personal_sync_session_objects(session_id,object_id,frozen) SELECT $1,x.id,true FROM reachable r JOIN personal_sync_objects x ON x.id=r.id AND x.owner=$2 AND x.epoch=$3`,[id,scope.owner,scope.epoch,snapshot],tx);
   await this.#capacity(scope,tx);
   return {session_id:id,expires_at:expires,state:await this.#state(scope,tx),inventory_cursor:this.#cursor(scope,id,snapshot,null)};
  });
 }
 async #session(scope:Scope,id:string,tx:Transaction,allowAborted=false):Promise<SessionRow>{
  if(!uuid.safeParse(id).success)return fail('SOURCE_UNAVAILABLE');
  const row=(await this.#db.query<SessionRow>('SELECT s.*,EXISTS(SELECT 1 FROM personal_sync_aborts a WHERE a.session_id=s.id) AS aborted FROM personal_sync_sessions s WHERE s.id=$1 AND s.owner=$2 AND s.epoch=$3',[id,scope.owner,scope.epoch],tx)).rows[0];
  if(!row)return fail('SOURCE_UNAVAILABLE');if(new Date(row.expires_at).getTime()<=this.#now().getTime())return fail('SYNC_SESSION_EXPIRED');if(row.aborted&&!allowAborted)return fail('SOURCE_UNAVAILABLE');return row;
 }
 #cursor(scope:Scope,session:string,snapshot:string,after:string|null){return Buffer.from(canonicalize({owner:scope.owner,epoch:scope.epoch,session,snapshot,after})).toString('base64url');}
 async inventory(by:Principal,session:string,epoch:string,cursor?:string|null){
  return this.#scope(by,epoch,async(scope,tx)=>{
   const row=await this.#session(scope,session,tx);let after:string|null=null;
   if(cursor){try{if(cursor.length>4000)throw new Error();const value=JSON.parse(Buffer.from(cursor,'base64url').toString());if(cursor!==this.#cursor(scope,session,row.snapshot,value.after)||value.after!==null&&!/^[0-9a-f]{64}$/.test(value.after))throw new Error();after=value.after;}catch{return fail('SOURCE_UNAVAILABLE');}}
   const rows=(await this.#db.query('SELECT x.id,x.kind,x.bytes FROM personal_sync_session_objects r JOIN personal_sync_objects x ON x.id=r.object_id AND x.owner=$2 AND x.epoch=$3 WHERE r.session_id=$1 AND r.frozen AND ($4::text IS NULL OR x.id>$4) ORDER BY x.id LIMIT $5',[session,scope.owner,scope.epoch,after,this.limits.page_items+1],tx)).rows;
   const objects=rows.slice(0,this.limits.page_items).map(r=>PersonalSyncDescriptor.parse(r));
   return {snapshot:row.snapshot,objects,next:rows.length>objects.length?this.#cursor(scope,session,row.snapshot,objects.at(-1)!.id):null};
  });
 }
 async missing(by:Principal,session:string,input:unknown){
  return this.#scope(by,undefined,async(scope,tx)=>{
   const request=PersonalSyncMissing.safeParse(input);if(!request.success)return fail('SYNC_OBJECT_INVALID');if(request.data.epoch!==scope.epoch)return fail('SYNC_EPOCH_CHANGED');await this.#session(scope,session,tx);
   const rows=await this.#db.query('SELECT id FROM personal_sync_objects WHERE owner=$1 AND epoch=$2 AND id=ANY($3::text[])',[scope.owner,scope.epoch,request.data.objects],tx),owned=new Set(rows.rows.map(r=>r.id));
   for(const id of owned)await this.#db.query('INSERT INTO personal_sync_session_objects(session_id,object_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[session,id],tx);
   return {missing:request.data.objects.filter(id=>!owned.has(id))};
  });
 }
 #scan(bytes:Uint8Array,code:ProtocolCode,requireText=false){const scan=scanForCredentials(bytes);if(scan.findings.length||scan.truncated)fail(code);if(requireText&&!scan.inspected)fail('SPACE_CONTENT_UNINSPECTABLE');}
 #scanText(value:unknown,code:ProtocolCode):void{
  if(typeof value==='string'){this.#scan(Buffer.from(value),code,true);return;}
  if(Array.isArray(value)){for(const item of value)this.#scanText(item,code);return;}
  if(value&&typeof value==='object')for(const [key,item]of Object.entries(value)){this.#scanText(key,code);this.#scanText(item,code);}
 }
 #decode(id:string,bytes:Uint8Array):PersonalSyncObject{
  if(sha256Hex(bytes)!==id)return fail('SYNC_OBJECT_HASH_MISMATCH');
  try{return decodePersonalSyncObject(bytes,id);}catch{return fail('SYNC_OBJECT_INVALID');}
 }
 #edges(object:PersonalSyncObject):string[]{
  const body=object.body;const edges:string[]='parents'in body?[...body.parents]:[];
  if(object.kind===objectKinds.source_revision)edges.push(...object.body.chunks);
  if(object.kind===objectKinds.entry_revision)for(const g of object.body.grounds)edges.push(g.source,g.quotation);
  if(object.kind===objectKinds.inventory_page)for(const item of object.body.items)edges.push(...item.heads);
  if(object.kind===objectKinds.snapshot)edges.push(...object.body.pages);
  return [...new Set(edges)];
 }
 async #saveObject(scope:Scope,id:string,bytes:Uint8Array,kind:SyncObjectKind,tx:Transaction){
  const object=this.#decode(id,bytes);
  const charge=object.kind===objectKinds.bytes?bytes.byteLength-object.body.bytes_base64.length+Buffer.from(object.body.bytes_base64,'base64').length:bytes.byteLength;
  await this.#payloads.put(scope,bytes,tx);
  const result=await this.#db.query('INSERT INTO personal_sync_objects VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[scope.owner,scope.epoch,id,kind,bytes.byteLength,charge],tx);
  const row=(await this.#db.query('SELECT kind,bytes,charge_bytes FROM personal_sync_objects WHERE owner=$1 AND epoch=$2 AND id=$3',[scope.owner,scope.epoch,id],tx)).rows[0];
  if(row.kind!==kind||row.bytes!==bytes.byteLength||row.charge_bytes!==charge)throw new IntegrityError('同步对象登记不完整');
  for(const child of this.#edges(object))await this.#db.query('INSERT INTO personal_sync_edges VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[scope.owner,scope.epoch,id,child],tx);
  return result.rowCount===1;
 }
 async #replay(scope:Scope,id:string,request:string,tx:Transaction):Promise<Receipt|null>{
  const row=(await this.#db.query('SELECT request,receipt FROM personal_sync_operations WHERE owner=$1 AND epoch=$2 AND operation_id=$3',[scope.owner,scope.epoch,id],tx)).rows[0];if(!row)return null;
  if(row.request!==request)return fail('IDEMPOTENCY_MISMATCH');return PersonalSyncReceipt.parse(JSON.parse(String(row.receipt)));
 }
 async #receipt(scope:Scope,operation:string,request:string,counts:Receipt['counts'],previous:string,tx:Transaction):Promise<Receipt>{
  const receipt=PersonalSyncReceipt.parse({operation_id:operation,epoch:scope.epoch,request,previous_state:previous,state_version:(await this.#state(scope,tx)).state_version,counts,at:this.#now().toISOString()});
  await this.#db.query('INSERT INTO personal_sync_operations VALUES($1,$2,$3,$4,$5)',[scope.owner,scope.epoch,operation,request,canonicalize(receipt)],tx);return receipt;
 }
 async upload(by:Principal,session:string,input:unknown):Promise<Receipt>{
  return this.#scope(by,undefined,async(scope,tx)=>{
   // Admission precedes decoding and hashing. HTTP also enforces its own wire budget before calling this port.
   let wire:string;try{wire=JSON.stringify(input);}catch{return fail('SYNC_OBJECT_INVALID');}
   if(!wire||Buffer.byteLength(wire)>this.#limits.maxRequestBytes)return fail('SYNC_BATCH_LIMIT');
   const parsed=PersonalSyncUpload.safeParse(input);if(!parsed.success)return fail('SYNC_OBJECT_INVALID');const batch=parsed.data;
   if(batch.epoch!==scope.epoch)return fail('SYNC_EPOCH_CHANGED');await this.#session(scope,session,tx);
   if(batch.objects.length>this.limits.batch_objects)return fail('SYNC_BATCH_LIMIT');
   const request=hash({path:PERSONAL_SYNC_HTTP_ROUTES.upload.path,session,batch}),replay=await this.#replay(scope,batch.operation_id,request,tx);if(replay)return replay;
   let total=0;const admitted:Array<{id:string;bytes:Uint8Array;object:PersonalSyncObject}>=[];
   for(const input of batch.objects){const size=input.bytes_base64.length/4*3-(input.bytes_base64.endsWith('==')?2:input.bytes_base64.endsWith('=')?1:0);total+=size;if(size>this.limits.object_bytes||total>this.limits.batch_bytes)return fail('SYNC_BATCH_LIMIT');
    const bytes=Buffer.from(input.bytes_base64,'base64'),object=this.#decode(input.id,bytes);
    const memory=object.kind===objectKinds.memory_revision;
    if(object.kind!==objectKinds.bytes)this.#scanText(object,memory?'MEMORY_CREDENTIALS_DETECTED':'SPACE_CREDENTIALS_DETECTED');
    if(object.kind===objectKinds.bytes)this.#scan(Buffer.from(object.body.bytes_base64,'base64'),'SPACE_CREDENTIALS_DETECTED');
    if(memory&&Buffer.byteLength(object.body.markdown)>this.#limits.maxMemoryDocumentBytes)return fail('MEMORY_DOCUMENT_LIMIT');
    if(object.kind===objectKinds.source_revision&&object.body.size>this.#limits.maxUploadBytes)return fail('SYNC_OBJECT_INVALID');
    admitted.push({id:input.id,bytes,object});
   }
   await this.#collect(scope,tx);const before=(await this.#state(scope,tx)).state_version;let accepted=0;
   for(const object of admitted){if(await this.#saveObject(scope,object.id,object.bytes,object.object.kind,tx))accepted++;
    await this.#db.query('INSERT INTO personal_sync_session_objects(session_id,object_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[session,object.id],tx);
   }
   await this.#capacity(scope,tx);
   return this.#receipt(scope,batch.operation_id,request,{accepted,existing:admitted.length-accepted,downloaded:0,bytes:total},before,tx);
  });
 }
 async download(by:Principal,session:string,input:unknown){
  return this.#scope(by,undefined,async(scope,tx)=>{
   const parsed=PersonalSyncMissing.safeParse(input);if(!parsed.success)return fail('SYNC_OBJECT_INVALID');const request=parsed.data;
   if(request.epoch!==scope.epoch)return fail('SYNC_EPOCH_CHANGED');await this.#session(scope,session,tx);if(request.objects.length>this.limits.batch_objects)return fail('SYNC_BATCH_LIMIT');
   const objects:Array<{id:string;bytes_base64:string}>=[],missing:string[]=[];let total=0;
   for(const id of request.objects){const row=(await this.#db.query('SELECT x.id FROM personal_sync_objects x JOIN personal_sync_session_objects r ON r.object_id=x.id AND r.session_id=$4 WHERE x.owner=$1 AND x.epoch=$2 AND x.id=$3',[scope.owner,scope.epoch,id,session],tx)).rows[0];
    if(!row){missing.push(id);continue;}const bytes=await this.#payloads.get(scope,id,tx);if(!bytes)throw new IntegrityError('同步对象载荷不完整');this.#decode(id,bytes);
    total+=bytes.byteLength;if(total>this.limits.batch_bytes)return fail('SYNC_BATCH_LIMIT');objects.push({id,bytes_base64:Buffer.from(bytes).toString('base64')});
   }
   return {objects,missing};
  });
 }
 async operation(by:Principal,epoch:string,id:string):Promise<Receipt|null>{
  if(!operationId.safeParse(id).success)return fail('SOURCE_UNAVAILABLE');return this.#scope(by,epoch,async(scope,tx)=>{
   const row=(await this.#db.query('SELECT receipt FROM personal_sync_operations WHERE owner=$1 AND epoch=$2 AND operation_id=$3',[scope.owner,scope.epoch,id],tx)).rows[0];return row?PersonalSyncReceipt.parse(JSON.parse(String(row.receipt))):null;
  });
 }
 async abort(by:Principal,session:string,input:unknown):Promise<Receipt>{
  return this.#scope(by,undefined,async(scope,tx)=>{
   const parsed=PersonalSyncAbort.safeParse(input);if(!parsed.success)return fail('SYNC_OBJECT_INVALID');const request=parsed.data;if(request.epoch!==scope.epoch)return fail('SYNC_EPOCH_CHANGED');const row=await this.#session(scope,session,tx,true);
   const identity=hash({path:PERSONAL_SYNC_HTTP_ROUTES.abort.path,session,request}),replay=await this.#replay(scope,request.operation_id,identity,tx);if(replay)return replay;if(row.aborted)return fail('SOURCE_UNAVAILABLE');
   const before=(await this.#state(scope,tx)).state_version;
   await this.#db.query('INSERT INTO personal_sync_aborts VALUES($1,$2)',[session,this.#now().toISOString()],tx);await this.#collect(scope,tx);
   return this.#receipt(scope,request.operation_id,identity,{accepted:0,existing:0,downloaded:0,bytes:0},before,tx);
  });
 }
 async object(by:Principal,epoch:string,id:string,outer?:Transaction):Promise<PersonalSyncObject|null>{
  return this.#scope(by,epoch,async(scope,tx)=>{
   const row=await this.#db.query('SELECT 1 FROM personal_sync_objects WHERE owner=$1 AND epoch=$2 AND id=$3',[scope.owner,scope.epoch,id],tx);if(!row.rowCount)return null;
   const bytes=await this.#payloads.get(scope,id,tx);if(!bytes)throw new IntegrityError('同步对象载荷不完整');return this.#decode(id,bytes);
  },outer);
 }
}
