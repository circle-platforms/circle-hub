// Client-context preferences are never evidence. These identifiers deliberately are not references.
import {z} from 'zod';
import {Sha256,IsoTime,UserId} from './common.ts';
import {TreePath} from './reference.ts';
import {SpaceId,SpaceGrantBody} from './spaces.ts';
import {KnowledgeSpaceKindSchema,KnowledgeSearchScopeSchema,MemoryStatusSchema,MemoryShareEffectSchema,KnowledgeShareStatusSchema} from '../generated/vocabulary.ts';
import {RecordKindSchema} from './records.ts';
export const MEMORY_RECORD_KINDS=RecordKindSchema.extract(['memory_document','memory_version','memory_grant','memory_share']).options;
export const isMemoryRecordKind=(kind:string)=>new Set<string>(MEMORY_RECORD_KINDS).has(kind);
const Text=z.string().refine(text=>text.isWellFormed(),'well-formed Unicode text');
const Key=Text.min(1).max(200).refine(value=>!value.includes('\0'),'no NUL in client key');
export const MemoryWriteInput=z.strictObject({space:KnowledgeSpaceKindSchema.default('personal'),document:Sha256.optional(),expected_version:Sha256.nullable(),title:Text.min(1).max(300).optional(),path:TreePath.optional(),markdown:Text.optional(),enabled:z.boolean().optional(),client_key:Key})
 .refine(value=>value.document?value.expected_version!==null:value.expected_version===null&&value.title!==undefined&&value.markdown!==undefined,'create requires title, markdown and null expected_version; update requires document and expected_version');
export type MemoryWriteInput=z.infer<typeof MemoryWriteInput>;
export const MemoryQuery=z.strictObject({scope:KnowledgeSearchScopeSchema.default('all'),document:Sha256.optional(),version:Sha256.optional(),for_session:z.boolean().default(false),cursor:z.string().max(4000).optional()})
 .refine(q=>q.version===undefined||q.document!==undefined,'a version belongs to a document')
 .refine(q=>!q.for_session||(q.document?q.version!==undefined:q.scope==='team'||q.scope==='personal'),'session reads pin a version; session lists select team or personal');
export const MemoryDocumentBody=z.strictObject({space:SpaceId,by:UserId,at:IsoTime,intent:Sha256});
export const MemoryVersionBody=z.strictObject({document:Sha256,space:SpaceId,parent:Sha256.nullable(),title:Text.min(1).max(300),path:TreePath,state:MemoryStatusSchema.extract(['enabled','disabled']),bytes:z.number().int().nonnegative(),markdown:Text.nullable(),content_version:Sha256.nullable(),by:UserId,at:IsoTime,intent:Sha256,payload:Sha256})
 .refine(v=>(v.markdown===null)===(v.content_version!==null),'inline text or one content version');
export type MemoryVersionBody=z.infer<typeof MemoryVersionBody>;
export const MemoryGrantBody=SpaceGrantBody.safeExtend({intent:Sha256});
export const MemoryShareInput=z.strictObject({document:Sha256,version:Sha256,team_path:TreePath.optional(),client_key:Key,check_only:z.boolean().default(false)});
export const MemoryShareBody=z.strictObject({document:Sha256,version:Sha256,by:UserId,at:IsoTime,intent:Sha256,payload:Sha256,status:KnowledgeShareStatusSchema,code:z.string().nullable(),message:z.string(),target_path:TreePath,team_document:Sha256.nullable(),team_version:Sha256.nullable(),effect:MemoryShareEffectSchema.nullable(),replaces:Sha256.nullable()});
export type MemoryShareBody=z.infer<typeof MemoryShareBody>;
export const MemoryMetadata=z.strictObject({document:Sha256,version:Sha256,space:SpaceId,title:Text,path:TreePath,state:MemoryStatusSchema,bytes:z.number().int().nonnegative(),updated_at:IsoTime,updated_by:UserId,auto_load_allowed:z.boolean()});
export type MemoryMetadata=z.infer<typeof MemoryMetadata>;
export const MemoryPage=z.strictObject({scope:KnowledgeSearchScopeSchema,snapshot:Sha256,items:z.array(MemoryMetadata).max(50),next:z.string().nullable()});
export const MemoryDocumentView=MemoryMetadata.extend({current_version:Sha256,markdown:Text,offset:z.number().int().nonnegative(),next:z.string().nullable()});
export const MemoryWriteReceipt=z.strictObject({document:Sha256,version:Sha256,previous_version:Sha256.nullable(),space:SpaceId,state:MemoryStatusSchema,bytes:z.number().int().nonnegative(),updated_at:IsoTime,unchanged:z.boolean()});
export type MemoryWriteReceipt=z.infer<typeof MemoryWriteReceipt>;
export const MEMORY_SCHEMAS={'memory-document@1':MemoryDocumentBody,'memory-version@1':MemoryVersionBody,'memory-grant@1':MemoryGrantBody,'memory-share@1':MemoryShareBody};
