// Personal HTTP sync contracts. These schemas are deliberately absent from MCP tool inputs.
import {z} from 'zod';
import {Sha256,IsoTime,Versioned,PackVersion} from './common.ts';
import {Ground} from './reference.ts';
import {SpaceEntryContent} from './spaces.ts';
import {PackManifest} from './pack.ts';
import {SyncModeSchema,SyncStatusSchema,SyncObjectKindSchema,MemoryStatusSchema,KnowledgeEntryStatusSchema,PackKindSchema} from '../generated/vocabulary.ts';
import {PROTOCOL_CODES} from '../generated/protocol.ts';
export const PERSONAL_SYNC_LIMITS=Object.freeze({objectBytes:8*1024*1024,chunkBytes:1024*1024,batchObjects:64,pageItems:500,sessionSeconds:86400});
const Id=z.uuid();
const Text=z.string().refine(s=>s.isWellFormed(),'well-formed Unicode');
const Key=z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const PersonalSyncBase64=z.string().max(12*1024*1024).refine(s=>/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)&&Buffer.from(s,'base64').toString('base64')===s,'canonical padded base64');
const sortedUnique=(a:readonly string[])=>a.every((v,i)=>i===0||a[i-1]<v);
const Hashes=z.array(Sha256).max(500).refine(sortedUnique,'sorted unique hashes');
const Revision={item_id:Id,parents:Hashes,directory_id:Id};
const object=<K extends z.infer<typeof SyncObjectKindSchema>,S extends z.ZodType>(kind:K,body:S)=>z.strictObject({schema:z.literal('personal-sync-object@1'),kind:z.literal(SyncObjectKindSchema.enum[kind]),body});
const Bytes=object('bytes',z.strictObject({bytes_base64:PersonalSyncBase64.refine(s=>Buffer.from(s,'base64').length<=PERSONAL_SYNC_LIMITS.chunkBytes,'bounded byte chunk')}));
const Source=object('source_revision',z.strictObject({...Revision,name:Text.min(1).max(300).nullable(),media_type:z.string().min(1).max(200),raw_sha256:Sha256,size:z.number().int().nonnegative(),chunks:z.array(Sha256).max(4096)}));
const Entry=object('entry_revision',z.strictObject({...Revision,content:SpaceEntryContent.extend({data:z.record(z.string(),z.unknown()),applicability:z.record(z.string(),z.unknown()).nullable()}),grounds:z.array(z.union([z.strictObject({source:Sha256,parser:Versioned,selector:Text.min(1).max(4000),quotation:Sha256}),z.strictObject({reference:Ground,quotation:Sha256}),z.strictObject({entry:Sha256,quotation:Sha256})])).max(100)}));
const Directory=object('directory_revision',z.strictObject({item_id:Id,parents:Hashes,parent_directory:Id.nullable(),name:Text.max(300)}));
const Memory=object('memory_revision',z.strictObject({...Revision,title:Text.min(1).max(300),markdown:Text,state:MemoryStatusSchema.extract(['enabled','disabled'])}));
const Pack=object('pack_manifest',z.strictObject({item_id:Id,parents:Hashes,manifest:PackManifest.safeExtend({kind:PackKindSchema.extract(['workflow','skill'])})}));
export const PersonalSyncItem=z.strictObject({kind:SyncObjectKindSchema.extract(['source_revision','entry_revision','directory_revision','memory_revision','pack_manifest']),item_id:Id,heads:Hashes.refine(a=>a.length>0,'at least one head')});
const Page=object('inventory_page',z.strictObject({items:z.array(PersonalSyncItem).max(500).refine(rows=>sortedUnique(rows.map(row=>row.kind+':'+row.item_id)),'sorted unique items')}));
const Snapshot=object('snapshot',z.strictObject({parents:Hashes,pages:Hashes}));
const Deletion=object('deletion',z.strictObject({item_id:Id,parents:Hashes.refine(a=>a.length>0),target_kind:PersonalSyncItem.shape.kind}));
export const PersonalSyncObject=z.discriminatedUnion('kind',[Bytes,Source,Entry,Directory,Memory,Pack,Page,Snapshot,Deletion]);
export type PersonalSyncObject=z.infer<typeof PersonalSyncObject>;
export const PersonalSyncDescriptor=z.strictObject({id:Sha256,kind:SyncObjectKindSchema,bytes:z.number().int().min(0).max(PERSONAL_SYNC_LIMITS.objectBytes)});
const Batch=z.array(Sha256).max(PERSONAL_SYNC_LIMITS.batchObjects).refine(a=>new Set(a).size===a.length,'unique batch objects');
const Scope={epoch:Id};
const Operation={...Scope,operation_id:Key};
export const PersonalSyncClient=z.strictObject({client_id:Id,name:Text.min(1).max(100)});
export const PersonalSyncSession=z.strictObject({client_id:Id,epoch:Id,known_state:Sha256.nullable(),base_snapshot:Sha256.nullable()});
export const PersonalSyncMissing=z.strictObject({...Scope,objects:Batch});
export const PersonalSyncDownload=PersonalSyncMissing;
export const PersonalSyncUpload=z.strictObject({schema:z.literal('personal-sync-upload@1'),...Operation,objects:z.array(z.strictObject({id:Sha256,bytes_base64:PersonalSyncBase64})).min(1).max(PERSONAL_SYNC_LIMITS.batchObjects)}).refine(v=>new Set(v.objects.map(o=>o.id)).size===v.objects.length,'unique objects');
export const PersonalSyncCommit=z.strictObject({schema:z.literal('personal-sync-commit@1'),...Operation,expected_state:Sha256,base_snapshot:Sha256.nullable(),snapshot:Sha256});
export const PersonalSyncModeCheck=z.strictObject({mode:SyncModeSchema});
export const PersonalSyncModeChange=z.strictObject({...Operation,mode:SyncModeSchema,expected_state:Sha256,check:Sha256.nullable(),confirm_purge:z.boolean()}).refine(v=>v.mode!==SyncModeSchema.enum.local||(v.confirm_purge&&v.check!==null),'local mode requires a checked purge');
export const PersonalSyncState=z.strictObject({epoch:Id,mode:SyncModeSchema,status:SyncStatusSchema,state_version:Sha256,snapshot:Sha256.nullable(),last_synced_at:IsoTime.nullable(),used_bytes:z.number().int().nonnegative(),capacity_bytes:z.number().int().nonnegative(),limits:z.strictObject({object_bytes:z.number().int().positive(),batch_bytes:z.number().int().positive(),batch_objects:z.number().int().positive().max(64),page_items:z.number().int().positive().max(500),session_seconds:z.number().int().positive()})});
export const PersonalSyncInventory=z.strictObject({snapshot:Sha256,objects:z.array(PersonalSyncDescriptor).max(500),next:Text.max(4000).nullable()});
export const PersonalSyncTransfer=z.strictObject({objects:z.array(z.strictObject({id:Sha256,bytes_base64:PersonalSyncBase64})).max(64),missing:Batch});
const Counts=z.strictObject({accepted:z.number().int().nonnegative(),existing:z.number().int().nonnegative(),downloaded:z.number().int().nonnegative(),bytes:z.number().int().nonnegative()});
export const PersonalSyncReceipt=z.strictObject({operation_id:Key,epoch:Id,request:Sha256,previous_state:Sha256.nullable(),state_version:Sha256,counts:Counts,at:IsoTime});
export const PersonalSyncVerification=z.strictObject({object:Sha256,status:KnowledgeEntryStatusSchema.extract(['verified','unverified']),rule_version:PackVersion,scanner:Versioned,parser_lock:Sha256.nullable(),positions:z.array(z.strictObject({ground:z.number().int().nonnegative().max(99),code:z.string().refine(s=>Object.hasOwn(PROTOCOL_CODES,s))})).max(500).optional(),parser_locks:z.array(z.strictObject({parser:Versioned,digest:Sha256.nullable()})).max(100).optional(),codes:z.array(z.string().refine(s=>Object.hasOwn(PROTOCOL_CODES,s))).max(100),checked_at:IsoTime});
export const PersonalSyncConflict=z.strictObject({item_id:Id,heads:Hashes.refine(a=>a.length>0),structural:z.boolean().optional()}).refine(v=>v.heads.length>1||v.structural===true,'multiple heads or an observed structural conflict');
export const PersonalSyncProjection=z.strictObject({kind:PersonalSyncItem.shape.kind,item_id:Id,object:Sha256,reference:Ground.optional(),document:Sha256.optional(),version:Sha256.optional(),installed:z.boolean().optional()});
export const PersonalSyncResult=z.strictObject({state:PersonalSyncState,receipt:PersonalSyncReceipt,projections:z.array(PersonalSyncProjection).max(500).optional(),verification:z.array(PersonalSyncVerification).max(500),conflicts:z.array(PersonalSyncConflict).max(500),next:Text.max(4000).nullable()});
export const PersonalSyncError=z.strictObject({code:z.string().refine(s=>Object.hasOwn(PROTOCOL_CODES,s)),state:PersonalSyncState.optional(),retry_after_seconds:z.number().int().positive().optional()});
/**
 * HTTP status of each code a sync route answers with. A registered code not listed here answers 422. Two transport
 * refusals also carry SOURCE_UNAVAILABLE with another status: 401 (no live access Bearer) and 403 (refused Origin).
 */
export const PERSONAL_SYNC_ERROR_STATUS={SOURCE_UNAVAILABLE:404,SOURCE_RETRYABLE:503,SYNC_RATE_LIMITED:429,SYNC_BATCH_LIMIT:413,SYNC_VERSION_CONFLICT:409,SYNC_EPOCH_CHANGED:409,SYNC_MODE_LOCAL:409,SYNC_OBJECT_INVALID:422,SYNC_OBJECT_HASH_MISMATCH:422,SYNC_OBJECT_MISSING:422,SYNC_SESSION_EXPIRED:422,IDEMPOTENCY_MISMATCH:422,SPACE_CAPACITY_EXCEEDED:422,SPACE_CREDENTIALS_DETECTED:422,SPACE_CONTENT_UNINSPECTABLE:422,MEMORY_CREDENTIALS_DETECTED:422,MEMORY_DOCUMENT_LIMIT:422} as const satisfies Partial<Record<keyof typeof PROTOCOL_CODES,number>>;
export const personalSyncErrorStatus=(code:string):number=>(PERSONAL_SYNC_ERROR_STATUS as Record<string,number>)[code]??422;
// Route identifiers are protocol addresses, never MCP tools. Dynamic path components are separately authenticated.
export const PERSONAL_SYNC_HTTP_ROUTES={state:{method:'GET',path:'/api/sync/v1/state'},client:{method:'POST',path:'/api/sync/v1/clients'},session:{method:'POST',path:'/api/sync/v1/sessions'},inventory:{method:'GET',path:'/api/sync/v1/sessions/{id}/inventory'},missing:{method:'POST',path:'/api/sync/v1/sessions/{id}/missing'},upload:{method:'POST',path:'/api/sync/v1/sessions/{id}/upload'},download:{method:'POST',path:'/api/sync/v1/sessions/{id}/download'},commit:{method:'POST',path:'/api/sync/v1/sessions/{id}/commit'},operation:{method:'GET',path:'/api/sync/v1/operations/{id}'},abort:{method:'POST',path:'/api/sync/v1/sessions/{id}/abort'},modeCheck:{method:'POST',path:'/api/sync/v1/mode/check'},mode:{method:'POST',path:'/api/sync/v1/mode'}} as const;
export const PERSONAL_SYNC_SCHEMAS={'personal-sync-object@1':PersonalSyncObject,'personal-sync-client@1':PersonalSyncClient,'personal-sync-session@1':PersonalSyncSession,'personal-sync-missing@1':PersonalSyncMissing,'personal-sync-download@1':PersonalSyncDownload,'personal-sync-upload@1':PersonalSyncUpload,'personal-sync-commit@1':PersonalSyncCommit,'personal-sync-mode-check@1':PersonalSyncModeCheck,'personal-sync-mode-change@1':PersonalSyncModeChange,'personal-sync-state@1':PersonalSyncState,'personal-sync-inventory@1':PersonalSyncInventory,'personal-sync-transfer@1':PersonalSyncTransfer,'personal-sync-receipt@1':PersonalSyncReceipt,'personal-sync-verification@1':PersonalSyncVerification,'personal-sync-result@1':PersonalSyncResult,'personal-sync-error@1':PersonalSyncError};

export const PersonalSyncAbort=z.strictObject({...Operation});
export const PersonalSyncSessionReply=z.strictObject({session_id:Id,expires_at:IsoTime,state:PersonalSyncState,inventory_cursor:Text.max(4000).nullable()});
export const PersonalSyncModeImpact=z.strictObject({check:Sha256,expected_state:Sha256,mode:SyncModeSchema,personal_bytes:z.number().int().nonnegative(),directory_grants:z.number().int().nonnegative(),pending_shares:z.number().int().nonnegative().nullable(),team_copies_preserved:z.number().int().nonnegative()});
Object.assign(PERSONAL_SYNC_SCHEMAS,{'personal-sync-abort@1':PersonalSyncAbort,'personal-sync-session-reply@1':PersonalSyncSessionReply,'personal-sync-mode-impact@1':PersonalSyncModeImpact});
export const PersonalSyncHttpProtocol=z.strictObject({schema:z.literal('personal-sync-http@1'),routes:z.strictObject(Object.fromEntries(Object.entries(PERSONAL_SYNC_HTTP_ROUTES).map(([key,route])=>[key,z.strictObject({method:z.literal(route.method),path:z.literal(route.path)})])))});
Object.assign(PERSONAL_SYNC_SCHEMAS,{'personal-sync-http@1':PersonalSyncHttpProtocol});

export const PERSONAL_SYNC_DEFAULT_MODE=SyncModeSchema.enum.hub;

export const PersonalSyncModeResult=z.strictObject({state:PersonalSyncState,receipt:PersonalSyncReceipt});
Object.assign(PERSONAL_SYNC_SCHEMAS,{'personal-sync-mode-result@1':PersonalSyncModeResult});
