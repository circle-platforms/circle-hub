import {retireReadScope} from './read-scope.ts';
import {historyUsage} from './personal-capacity.ts';
// Scoped transport storage only: uploaded objects never become knowledge, memory or executable packs here.
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {PROTOCOL_CODES,type ProtocolCode} from '../../contracts/generated/protocol.ts';
import {PermissionRoleSchema,KnowledgeGrantActionSchema,KnowledgeShareStatusSchema,ActionKindSchema,SyncModeSchema,SyncStatusSchema,SyncObjectKindSchema,type SyncObjectKind} from '../../contracts/generated/vocabulary.ts';
import {PERSONAL_SYNC_LIMITS,PERSONAL_SYNC_HTTP_ROUTES,PersonalSyncModeCheck,PersonalSyncModeChange,PersonalSyncModeImpact,PersonalSyncModeResult,PersonalSyncCommit,PersonalSyncResult,PersonalSyncClient,PersonalSyncSession,PersonalSyncUpload,PersonalSyncMissing,PersonalSyncAbort,PersonalSyncReceipt,PersonalSyncState,PersonalSyncDescriptor,PersonalSyncItem,type PersonalSyncObject} from '../../contracts/src/sync.ts';
import {decodePersonalSyncObject,encodePersonalSyncObject,normalizePersonalSyncText} from '../../contracts/src/sync-canonical.ts';
import {MemoryGrantBody,MemoryShareBody} from '../../contracts/src/memory.ts';
import {KnowledgeShareBody} from '../../contracts/src/sharing.ts';
import {SpaceGrantBody,SpaceQuotaBody} from '../../contracts/src/spaces.ts';
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
export interface PersonalSyncBinding {kind:SyncObjectKind;item_id:string;object_id:string;native:string;locator:string}
export interface Scope extends PersonalScope {mode:z.infer<typeof SyncModeSchema>}
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
 readonly sourceBytes:number;
 readonly limits:State['limits'];
 constructor(db:Database,store:RecordStore,payloads:PgPersonalPayloads,limits:Limits,now:()=>Date){
  this.#db=db;this.#store=store;this.#payloads=payloads;this.#limits=limits;this.#now=now;this.sourceBytes=limits.maxUploadBytes;
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
   const row=(await this.#db.query('SELECT epoch,mode FROM hub_lock_personal_scope($1)',[by.id],tx)).rows[0];
   const scope={owner:by.id,epoch:String(row.epoch),mode:SyncModeSchema.parse(row.mode)};
   if(epoch!==undefined&&epoch!==scope.epoch)return fail('SYNC_EPOCH_CHANGED');
   if(scope.mode!==SyncModeSchema.enum.hub&&!allowLocal)return fail('SYNC_MODE_LOCAL');
   await this.#db.query('INSERT INTO personal_sync_heads(owner,epoch) VALUES($1,$2) ON CONFLICT DO NOTHING',[by.id,scope.epoch],tx);
   return work(scope,tx);
  },outer);
 }
 async #usage(scope:Scope,tx:Transaction){
  const native=(await this.#db.query("SELECT r.digest,r.body FROM hub_read_records() r JOIN personal_record_bindings b ON b.record=r.digest WHERE b.owner=$1 AND b.epoch=$2 AND r.kind='knowledge_space_version' ORDER BY r.seq DESC LIMIT 1",[scope.owner,scope.epoch],tx)).rows[0];
  const history=await historyUsage(this.#store,scope.owner,tx);
  const extra=(await this.#db.query(`SELECT COALESCE(sum(charge),0)::text AS bytes,bool_or(charge IS NULL) AS missing FROM (
    SELECT id,charge_bytes AS charge FROM personal_sync_objects WHERE owner=$1 AND epoch=$2 AND NOT EXISTS(SELECT 1 FROM personal_sync_exports e WHERE e.owner=$1 AND e.epoch=$2 AND e.object_id=id) UNION
    SELECT c.name_payload,octet_length(p.data) FROM personal_sync_clients c LEFT JOIN personal_payloads p
    ON (p.owner,p.epoch,p.sha256)=(c.owner,c.epoch,c.name_payload) WHERE c.owner=$1 AND c.epoch=$2
   UNION SELECT 'note:'||kind||':'||id,bytes FROM personal_sync_notes WHERE owner=$1 AND epoch=$2
   ) x`,[scope.owner,scope.epoch],tx)).rows[0];
  if(extra.missing&&scope.mode===SyncModeSchema.enum.hub)throw new IntegrityError('同步元数据载荷不完整');
  const ledger=(await this.#db.query('SELECT COALESCE((SELECT sum(bytes) FROM personal_sync_native_credits WHERE owner=$1 AND epoch=$2),0)::text AS credits,COALESCE((SELECT sum(x.charge_bytes) FROM personal_sync_exports e JOIN personal_sync_objects x ON (x.owner,x.epoch,x.id)=(e.owner,e.epoch,e.object_id) WHERE e.owner=$1 AND e.epoch=$2),0)::text AS exported',[scope.owner,scope.epoch],tx)).rows[0];
  const nativeBytes=history.used,baseline=scope.mode===SyncModeSchema.enum.local?0:nativeBytes-Number(ledger.credits);if(baseline<0)throw new IntegrityError('个人同步容量登记不完整');
  const quota=(await this.#store.find({key:'knowledge.space.quota',value:scope.owner,kind:'knowledge_space_quota',newestFirst:true,limit:1},tx)).items[0];
  const capacity=quota?SpaceQuotaBody.parse(quota.body).bytes:1024**3;
  const used=scope.mode===SyncModeSchema.enum.local?0:Math.max(baseline,Number(ledger.exported))+Number(extra.bytes);
  if(!Number.isSafeInteger(used)||used<0)throw new IntegrityError('个人容量计量不完整');
  return {native:nativeBytes,used,capacity,knowledge:native?.digest??null,knowledge_bytes:history.knowledge,memory_bytes:history.memory};
 }
 /** Internal aggregate-only port; knowledge callers enforce owner/administrator metadata visibility. */
 async usageForSpace(owner:string,tx?:Transaction):Promise<import('./personal-capacity.ts').CapacityUsage>{
  if(!tx)return this.#db.transaction(t=>this.usageForSpace(owner,t));
  await this.#store.lock('knowledge-space:'+owner,tx);
  const row=(await this.#db.query('SELECT epoch,mode FROM personal_spaces WHERE owner=$1',[owner],tx)).rows[0];
  const usage=await this.#usage({owner,epoch:row?String(row.epoch):INITIAL_PERSONAL_EPOCH,mode:row?SyncModeSchema.parse(row.mode):SyncModeSchema.enum.hub},tx);
  return {knowledge:usage.knowledge_bytes,memory:usage.memory_bytes,used:usage.used,limit:usage.capacity,remaining:Math.max(0,usage.capacity-usage.used),over:Math.max(0,usage.used-usage.capacity)};
 }
 async #capacity(scope:Scope,tx:Transaction){const usage=await this.#usage(scope,tx);if(usage.used>usage.capacity)fail('SPACE_CAPACITY_EXCEEDED');}
 async #state(scope:Scope,tx:Transaction):Promise<State>{
  const head=(await this.#db.query('SELECT snapshot,last_synced_at,conflicts FROM personal_sync_heads WHERE owner=$1 AND epoch=$2',[scope.owner,scope.epoch],tx)).rows[0];
  const usage=await this.#usage(scope,tx);
  const memory=(await this.#db.query('SELECT document,version FROM memory_heads WHERE space=$1 ORDER BY document',[scope.owner],tx)).rows;
  const active=(await this.#db.query('SELECT 1 FROM personal_sync_sessions s WHERE owner=$1 AND epoch=$2 AND expires_at>$3 AND NOT EXISTS(SELECT 1 FROM personal_sync_aborts a WHERE a.session_id=s.id) LIMIT 1',[scope.owner,scope.epoch,this.#now().toISOString()],tx)).rowCount;
  const local=scope.mode===SyncModeSchema.enum.local,snapshot=local?null:head.snapshot===null?null:String(head.snapshot);
  return PersonalSyncState.parse({epoch:scope.epoch,mode:scope.mode,status:Number(head.conflicts)>0&&!local?SyncStatusSchema.enum.conflicted:active&&!local?SyncStatusSchema.enum.syncing:head.last_synced_at&&!local?SyncStatusSchema.enum.complete:SyncStatusSchema.enum.idle,
   state_version:hash({epoch:scope.epoch,mode:scope.mode,snapshot,knowledge:usage.knowledge,memory,native:await this.fingerprint({id:scope.owner} as Principal,scope.epoch,tx)}),snapshot,last_synced_at:local||!head.last_synced_at?null:iso(head.last_synced_at),used_bytes:usage.used,capacity_bytes:usage.capacity,limits:this.limits});
 }
 state(by:Principal,outer?:Transaction):Promise<State>{return this.#scope(by,undefined,async(scope,tx)=>{if(scope.mode===SyncModeSchema.enum.hub)await this.#collect(scope,tx);return this.#state(scope,tx);},outer,true);}
 /** Console-only return from a completed purge; full bidirectional mode changes remain in step 5. */
 async resume(by:Principal,epoch:string,expectedState:string):Promise<State>{
  return this.#scope(by,epoch,async(scope,tx)=>{
   const previous=await this.#state(scope,tx);
   if(previous.state_version!==expectedState)return fail('SYNC_VERSION_CONFLICT');
   if(scope.mode!==SyncModeSchema.enum.local)return fail('SYNC_EPOCH_CHANGED');
   const next={...scope,epoch:randomUUID(),mode:SyncModeSchema.enum.hub};
   await this.#db.query('SELECT hub_resume_personal($1,$2,$3)',[by.id,scope.epoch,next.epoch],tx);
   await this.#db.query('INSERT INTO personal_sync_heads(owner,epoch) VALUES($1,$2)',[by.id,next.epoch],tx);
   await this.#store.put({kind:'action',schema:'personal-sync-mode@1',provenance:'observed',body:{kind:ActionKindSchema.enum.validate,by:by.id,at:this.#now().toISOString(),previous_mode:scope.mode,mode:next.mode,previous_epoch:scope.epoch,epoch:next.epoch},index:[{key:'personal.sync.mode.by',value:by.id}]},tx);
   return this.#state(next,tx);
  },undefined,true).finally(retireReadScope);
 }
 /** Only bounded synchronization metadata is exposed on a member detail page. */
 async memberMetadata(by:Principal,owner:string){
  const actor=(await this.#db.query('SELECT role,disabled FROM users WHERE id=$1',[by.id])).rows[0];
  if(!actor||actor.disabled||(owner!==by.id&&actor.role!==PermissionRoleSchema.enum.admin))return null;
  const row=(await this.#db.query('SELECT p.mode,h.last_synced_at FROM users u LEFT JOIN personal_spaces p ON p.owner=u.id LEFT JOIN personal_sync_heads h ON h.owner=p.owner AND h.epoch=p.epoch WHERE u.id=$1',[owner])).rows[0];
  return row?{mode:row.mode?SyncModeSchema.parse(row.mode):SyncModeSchema.enum.hub,last_synced_at:row.mode!==SyncModeSchema.enum.local&&row.last_synced_at?iso(row.last_synced_at):null}:null;
 }
 async sessionClient(by:Principal,session:string,epoch:string){return this.#scope(by,epoch,async(scope,tx)=>String((await this.#session(scope,session,tx,true)).client_id));}
 async #impact(scope:Scope,mode:z.infer<typeof SyncModeSchema>,tx:Transaction){
  const state=await this.#state(scope,tx),grants=new Map<string,{active:boolean;record:string}>(),shares=new Set<string>(),observations:string[]=[];
  for(const q of [{kind:'knowledge_space_grant',key:'knowledge.space.grant'},{kind:'memory_grant',key:'memory.grant.owner'}] as const){
   for(const record of await this.#store.findMany({kind:q.kind,key:q.key,values:[scope.owner]},tx)){const body=q.kind==='memory_grant'?MemoryGrantBody.parse(record.body):SpaceGrantBody.parse(record.body);if(body.space!==scope.owner)continue;grants.set(hash([q.kind,body.path,body.audience,body.member]),{active:body.action===KnowledgeGrantActionSchema.enum.grant,record:record.digest});}
  }
  for(const q of [{kind:'knowledge_share',key:'knowledge.share.by'},{kind:'memory_share',key:'memory.share.by'}] as const){
   for(const record of await this.#store.findMany({kind:q.kind,key:q.key,values:[scope.owner]},tx)){const body=q.kind==='memory_share'?MemoryShareBody.parse(record.body):KnowledgeShareBody.parse(record.body);observations.push(record.digest);if(body.status===KnowledgeShareStatusSchema.enum.merged){const ref='team_document'in body?body.team_document:body.reference;if(ref)shares.add(ref);}}
  }
  const ledger=(await this.#db.query('SELECT (SELECT count(*) FROM personal_sync_operations WHERE owner=$1 AND epoch=$2)::text AS operations,(SELECT count(*) FROM personal_sync_objects WHERE owner=$1 AND epoch=$2)::text AS objects,(SELECT count(*) FROM personal_sync_sessions WHERE owner=$1 AND epoch=$2)::text AS sessions',[scope.owner,scope.epoch],tx)).rows[0];
  const impact={expected_state:state.state_version,mode,personal_bytes:state.used_bytes,directory_grants:[...grants.values()].filter(g=>g.active).length,pending_shares:null,team_copies_preserved:shares.size};
  return PersonalSyncModeImpact.parse({...impact,check:hash({owner:scope.owner,epoch:scope.epoch,impact,ledger,grants:[...grants.values()].map(g=>g.record).sort(),shares:observations.sort()})});
 }
 modeCheck(by:Principal,input:unknown){const parsed=PersonalSyncModeCheck.safeParse(input);if(!parsed.success)return fail('SYNC_OBJECT_INVALID');return this.#scope(by,undefined,(scope,tx)=>this.#impact(scope,parsed.data.mode,tx),undefined,true);}
 modeOperation(by:Principal,epoch:string,id:string){if(!uuid.safeParse(epoch).success||!operationId.safeParse(id).success)return fail('SOURCE_UNAVAILABLE');return this.#scope(by,undefined,async(_scope,tx)=>{const row=(await this.#db.query('SELECT result FROM personal_sync_mode_operations WHERE owner=$1 AND epoch=$2 AND operation_id=$3',[by.id,epoch,id],tx)).rows[0];return row?PersonalSyncModeResult.parse(JSON.parse(String(row.result))):null;},undefined,true);}
 changeMode(by:Principal,input:unknown){
  const parsed=PersonalSyncModeChange.safeParse(input);if(!parsed.success)return fail('SYNC_OBJECT_INVALID');const request=parsed.data;
  return this.#scope(by,undefined,async(scope,tx)=>{
   const identity=hash({path:PERSONAL_SYNC_HTTP_ROUTES.mode.path,request}),cached=(await this.#db.query('SELECT request,result FROM personal_sync_mode_operations WHERE owner=$1 AND epoch=$2 AND operation_id=$3',[by.id,request.epoch,request.operation_id],tx)).rows[0];
   if(cached){if(cached.request!==identity)return fail('IDEMPOTENCY_MISMATCH');return PersonalSyncModeResult.parse(JSON.parse(String(cached.result)));}
   if(request.epoch!==scope.epoch)return fail('SYNC_EPOCH_CHANGED');const before=await this.#state(scope,tx);
   if(before.state_version!==request.expected_state)throw new RecordsError(PROTOCOL_CODES.SYNC_VERSION_CONFLICT.when,{code:'SYNC_VERSION_CONFLICT',detail:{state:before}});
   const impact=await this.#impact(scope,request.mode,tx);
   if(request.mode===SyncModeSchema.enum.local&&request.check!==impact.check)throw new RecordsError(PROTOCOL_CODES.SYNC_VERSION_CONFLICT.when,{code:'SYNC_VERSION_CONFLICT',detail:{state:before}});
   let after:State;
   if(request.mode===scope.mode)after=before;
   else if(request.mode===SyncModeSchema.enum.local){await this.#payloads.purge(by,scope.epoch,tx);after=await this.#state({...scope,mode:request.mode},tx);}
   else {const next={...scope,epoch:randomUUID(),mode:SyncModeSchema.enum.hub};await this.#db.query('SELECT hub_resume_personal($1,$2,$3)',[by.id,scope.epoch,next.epoch],tx);await this.#db.query('INSERT INTO personal_sync_heads(owner,epoch) VALUES($1,$2)',[by.id,next.epoch],tx);after=await this.#state(next,tx);}
   const result=PersonalSyncModeResult.parse({state:after,receipt:{operation_id:request.operation_id,epoch:request.epoch,request:identity,previous_state:before.state_version,state_version:after.state_version,counts:{accepted:0,existing:0,downloaded:0,bytes:0},at:this.#now().toISOString()}});
   await this.#db.query('INSERT INTO personal_sync_mode_operations VALUES($1,$2,$3,$4,$5)',[by.id,request.epoch,request.operation_id,identity,canonicalize(result)],tx);
   await this.#store.put({kind:'action',schema:'personal-sync-mode@1',provenance:'observed',body:{kind:ActionKindSchema.enum.validate,by:by.id,at:result.receipt.at,previous_mode:scope.mode,mode:request.mode,previous_epoch:scope.epoch,epoch:after.epoch,operation:hash(request.operation_id),previous_state:before.state_version,state:after.state_version,personal_bytes:impact.personal_bytes,directory_grants:impact.directory_grants,team_copies_preserved:impact.team_copies_preserved},index:[{key:'personal.sync.mode.by',value:by.id}]},tx);
   return result;
  },undefined,true).finally(retireReadScope);
 }
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
 async openSession(by:Principal,input:unknown,outer?:Transaction){
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
  },outer);
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
  if(object.kind===objectKinds.entry_revision)for(const g of object.body.grounds)edges.push(...('source'in g?[g.source]:'entry'in g?[g.entry]:[]),g.quotation);
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
 /** Internal transaction boundary used by the native adapter, never exposed as a model tool. */
 transact<T>(by:Principal,epoch:string|undefined,work:(scope:Scope,tx:Transaction)=>Promise<T>,outer?:Transaction):Promise<T>{return this.#scope(by,epoch,work,outer);}
 async fingerprint(by:Principal,epoch:string,tx:Transaction):Promise<string>{return this.#scope(by,epoch,async(scope,t)=>{
  const knowledge=(await this.#db.query("SELECT r.digest FROM hub_read_records() r JOIN personal_record_bindings b ON b.record=r.digest WHERE b.owner=$1 AND b.epoch=$2 AND r.kind='knowledge_space_version' ORDER BY r.seq DESC LIMIT 1",[scope.owner,scope.epoch],t)).rows[0]?.digest??null;
  const memory=(await this.#db.query('SELECT document,version FROM memory_heads WHERE space=$1 ORDER BY document',[by.id],t)).rows;
  const packs=(await this.#store.findMany({kind:'personal_pack_version',key:'personal.pack.owner',values:[by.id]},t)).map(r=>r.digest);
  const records=await this.#store.findMany<{pack:string;version:string}>({kind:'personal_pack_version',key:'personal.pack.owner',values:[by.id]},t);const retired=await this.#store.findMany({kind:'personal_pack_retirement',key:'personal.pack.retired',values:records.map(r=>by.id+'/'+r.body.pack+'@'+r.body.version)},t);return hash({knowledge,memory,packs,retired:retired.map(r=>r.digest)});
 },tx,true);}
 async head(by:Principal,epoch:string,tx:Transaction){return this.#scope(by,epoch,async(scope,t)=>(await this.#db.query('SELECT snapshot,native_state,memory_projection,conflicts FROM personal_sync_heads WHERE owner=$1 AND epoch=$2',[scope.owner,scope.epoch],t)).rows[0],tx);}
 async stage(by:Principal,epoch:string,objects:readonly PersonalSyncObject[],tx:Transaction,native=false){return this.#scope(by,epoch,async(scope,t)=>{
  const ids:string[]=[];for(const object of objects){const bytes=encodePersonalSyncObject(object),id=sha256Hex(bytes);if(bytes.length>this.limits.object_bytes)return fail('SYNC_BATCH_LIMIT');if(object.kind===objectKinds.bytes)this.#scan(Buffer.from(object.body.bytes_base64,'base64'),'SPACE_CREDENTIALS_DETECTED');else this.#scanText(object,object.kind===objectKinds.memory_revision?'MEMORY_CREDENTIALS_DETECTED':'SPACE_CREDENTIALS_DETECTED');await this.#saveObject(scope,id,bytes,object.kind,t);ids.push(id);
   if(native)await this.#db.query('INSERT INTO personal_sync_exports VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[by.id,epoch,id],t);
  }return ids;
 },tx);}
 async bindings(by:Principal,epoch:string,tx:Transaction,input?:PersonalSyncBinding){return this.#scope(by,epoch,async(scope,t)=>{
  if(input)await this.#db.query('INSERT INTO personal_sync_bindings VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',[by.id,epoch,input.kind,input.item_id,input.object_id,input.native,input.locator],t);
  return (await this.#db.query('SELECT kind,item_id::text,object_id,native,locator FROM personal_sync_bindings WHERE owner=$1 AND epoch=$2',[by.id,epoch],t)).rows as unknown as PersonalSyncBinding[];
 },tx);}
 async note(by:Principal,epoch:string,kind:string,id:string,tx:Transaction,value?:unknown):Promise<unknown|null>{return this.#scope(by,epoch,async(scope,t)=>{
  if(value!==undefined){const bytes=Buffer.from(canonicalize(value)),payload=await this.#payloads.put(scope,bytes,t);await this.#db.query('INSERT INTO personal_sync_notes(owner,epoch,kind,id,payload,bytes) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[by.id,epoch,kind,id,payload,bytes.length],t);}
  const row=(await this.#db.query('SELECT payload FROM personal_sync_notes WHERE owner=$1 AND epoch=$2 AND kind=$3 AND id=$4',[by.id,epoch,kind,id],t)).rows[0];
  if(!row)return null;const bytes=await this.#payloads.get(scope,String(row.payload),t);if(!bytes)throw new IntegrityError('同步核对载荷不完整');return JSON.parse(Buffer.from(bytes).toString());
 },tx);}
 async nativeBytes(by:Principal,epoch:string,tx:Transaction):Promise<number>{return this.#scope(by,epoch,async(scope,t)=>{const u=await this.#usage(scope,t);return u.native;},tx);}
 async credit(by:Principal,epoch:string,event:string,bytes:number,tx:Transaction){return this.#scope(by,epoch,async(scope,t)=>{await this.#db.query('INSERT INTO personal_sync_native_credits VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[by.id,epoch,event,bytes],t);},tx);}
 async reserve(by:Principal,epoch:string,bytes:number,documents:number,tx:Transaction){return this.#scope(by,epoch,async(scope,t)=>{await this.#db.query('INSERT INTO personal_sync_memory_reservations VALUES($1,$2,$3,$4) ON CONFLICT(owner,epoch) DO UPDATE SET bytes=$3,documents=$4',[by.id,epoch,bytes,documents],t);},tx);}
 async checkpoint(by:Principal,epoch:string,snapshot:string,conflicts:number,tx:Transaction){return this.#scope(by,epoch,async(scope,t)=>{
  const native=await this.fingerprint(by,epoch,t);
  const heads=(await this.#db.query('SELECT document,space,version,path,state,bytes::int,context_bytes::int AS "contextBytes" FROM memory_heads WHERE space=$1 ORDER BY document',[by.id],t)).rows;
  const seq=String((await this.#db.query('SELECT COALESCE(max(seq),0)::text AS seq FROM records',[],t)).rows[0].seq),reserved=(await this.#db.query('SELECT bytes::int,documents FROM personal_sync_memory_reservations WHERE owner=$1 AND epoch=$2',[by.id,epoch],t)).rows[0]??{bytes:0,documents:0};
  const projection={heads,seq,reserved},projectionId=hash(projection);await this.note(by,epoch,'memory-projection',projectionId,t,projection);
  await this.#db.query('UPDATE personal_sync_heads SET snapshot=$3,native_state=$4,conflicts=$5,memory_projection=$6 WHERE owner=$1 AND epoch=$2',[by.id,epoch,snapshot,native,conflicts,projectionId],t);
  await this.#db.query('INSERT INTO personal_sync_retained VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[by.id,epoch,snapshot],t);
  await this.#capacity(scope,t);
 },tx);}
 async memoryProjection(by:Principal,epoch:string,tx:Transaction){return this.#scope(by,epoch,async(scope,t)=>{
  const head=await this.head(by,epoch,t);if(!head.memory_projection)return null;
  const base=await this.note(by,epoch,'memory-projection',String(head.memory_projection),t) as {heads:import('./memory-index.ts').MemoryHead[];seq:string;reserved:{bytes:number;documents:number}}|null;
  if(!base)throw new IntegrityError('记忆同步投影记录不完整');
  const rows=(await this.#db.query("SELECT r.* FROM hub_read_records() r JOIN personal_record_bindings b ON b.record=r.digest WHERE b.owner=$1 AND b.epoch=$2 AND r.kind='memory_version' AND r.seq>$3::bigint ORDER BY r.seq",[by.id,epoch,base.seq],t)).rows;
  return {...base,versions:rows.map(row=>({digest:String(row.digest),body:JSON.parse(String(row.body))}))};
 },tx);}
 async retained(by:Principal,epoch:string,id:string,tx:Transaction){return this.#scope(by,epoch,async(scope,t)=>(await this.#db.query('SELECT 1 FROM personal_sync_retained WHERE owner=$1 AND epoch=$2 AND object_id=$3',[by.id,epoch,id],t)).rowCount===1,tx);}
 async assertCapacity(by:Principal,epoch:string,tx:Transaction){return this.#scope(by,epoch,(scope,t)=>this.#capacity(scope,t),tx);}
 async commit(by:Principal,session:string,input:unknown,apply:(scope:Scope,tx:Transaction)=>Promise<{verification:z.infer<typeof PersonalSyncResult>['verification'];conflicts:z.infer<typeof PersonalSyncResult>['conflicts'];projections?:z.infer<typeof PersonalSyncResult>['projections']}>,outer?:Transaction){
  return this.#scope(by,undefined,async(scope,tx)=>{
   const parsed=PersonalSyncCommit.safeParse(input);if(!parsed.success)return fail('SYNC_OBJECT_INVALID');const request=parsed.data;
   if(request.epoch!==scope.epoch)return fail('SYNC_EPOCH_CHANGED');await this.#session(scope,session,tx);
   const identity=hash({path:PERSONAL_SYNC_HTTP_ROUTES.commit.path,session,request}),replay=await this.#replay(scope,request.operation_id,identity,tx);
   if(replay){const stored=await this.note(by,scope.epoch,'commit-result',hash(request.operation_id),tx);if(!stored)throw new IntegrityError('同步提交回执不完整');return this.#resultPage(stored as z.infer<typeof PersonalSyncResult>,0,request.operation_id);}
   const before=await this.#state(scope,tx);
   if(before.state_version!==request.expected_state)throw new RecordsError(PROTOCOL_CODES.SYNC_VERSION_CONFLICT.when,{code:'SYNC_VERSION_CONFLICT',detail:{state:before}});
   if(request.base_snapshot!==null&&!await this.retained(by,scope.epoch,request.base_snapshot,tx))return fail('SOURCE_UNAVAILABLE');
   const result=await apply(scope,tx);
   if(!result.conflicts.length)await this.#db.query('UPDATE personal_sync_heads SET last_synced_at=$3 WHERE owner=$1 AND epoch=$2',[by.id,scope.epoch,this.#now().toISOString()],tx);
   const receipt=await this.#receipt(scope,request.operation_id,identity,{accepted:0,existing:0,downloaded:0,bytes:0},before.state_version,tx),state=await this.#state(scope,tx);
   const stored={state,receipt,...result,next:null},originalUsed=state.used_bytes;let size=0;
   for(let n=0;n<8;n++){stored.state.used_bytes=originalUsed+size;const next=Buffer.byteLength(canonicalize(stored));if(next===size)break;size=next;}
   await this.note(by,scope.epoch,'commit-result',hash(request.operation_id),tx,stored);await this.#capacity(scope,tx);
   await this.#store.put({kind:'action',schema:'personal-sync-commit@1',provenance:'observed',body:{kind:ActionKindSchema.enum.validate,by:by.id,epoch:scope.epoch,at:receipt.at,snapshot:request.snapshot,operation:hash(request.operation_id),verified:result.verification.filter(v=>v.status==='verified').length,conflicts:result.conflicts.length}},tx);
   return this.#resultPage(stored,0,request.operation_id);
  },outer);
 }
 #resultPage(stored:z.infer<typeof PersonalSyncResult>,offset:number,operation:string){
  const count=Math.max(stored.verification.length,stored.conflicts.length,stored.projections?.length??0);
  const page=(end:number)=>({...stored,...(stored.projections?{projections:stored.projections.slice(offset,end)}:{}),verification:stored.verification.slice(offset,end),conflicts:stored.conflicts.slice(offset,end),next:end<count?Buffer.from(canonicalize({epoch:stored.state.epoch,operation,offset:end})).toString('base64url'):null});
  let end=offset;while(end<count&&end-offset<this.limits.page_items){if(Buffer.byteLength(canonicalize(page(end+1)))>this.#limits.maxRequestBytes-512){if(end===offset)return fail('SYNC_BATCH_LIMIT');break;}end++;}
  return PersonalSyncResult.parse(page(end));
 }
 async result(by:Principal,epoch:string,operation:string,cursor?:string|null){return this.#scope(by,epoch,async(scope,tx)=>{
  const stored=await this.note(by,epoch,'commit-result',hash(operation),tx) as z.infer<typeof PersonalSyncResult>|null;if(!stored)return null;let offset=0;
  if(cursor){try{const p=JSON.parse(Buffer.from(cursor,'base64url').toString());if(p.epoch!==epoch||p.operation!==operation||!Number.isSafeInteger(p.offset)||p.offset<0)throw new Error();offset=p.offset;}catch{return fail('SOURCE_UNAVAILABLE');}}
  return this.#resultPage(stored,offset,operation);
 });}

 async object(by:Principal,epoch:string,id:string,outer?:Transaction):Promise<PersonalSyncObject|null>{
  return this.#scope(by,epoch,async(scope,tx)=>{
   const row=await this.#db.query('SELECT 1 FROM personal_sync_objects WHERE owner=$1 AND epoch=$2 AND id=$3',[scope.owner,scope.epoch,id],tx);if(!row.rowCount)return null;
   const bytes=await this.#payloads.get(scope,id,tx);if(!bytes)throw new IntegrityError('同步对象载荷不完整');return this.#decode(id,bytes);
  },outer);
 }
}
