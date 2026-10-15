import {z} from 'zod';
import {Base64Content,InputRevisionId,OperationId,SourceReference,SourceRevisionId,Sha256,TaskId,registerErrorCodes,registerOperation} from '../../packages/contracts/src/index.ts';

export const MINDMAP_FLOW_VERSION='mindmap-compile/1';
export const MINDMAP_CONTRACT_VERSION='Excel 输出契约 V1';
export const MINDMAP_MAPPING_VERSION='1.0.0';
export const MINDMAP_PACK_VERSION='1.1.0';
export const MINDMAP_WORKBOOK_CREATOR='circle-hub mindmap-compile';
export const MindmapCompileInput=z.object({sourceRevisionId:SourceRevisionId,sourceSha256:Sha256.optional()});
export const MindmapPack={capabilityPackId:'mindmap-compile',version:MINDMAP_PACK_VERSION,title:'脑图用例结构编译',inputFormats:['xmind-2020-content-json','xmind-content-json','topic-tree-json'],contractVersion:MINDMAP_CONTRACT_VERSION,mappingRulesVersion:MINDMAP_MAPPING_VERSION,requiredOperations:['mindmaps.compile'],conclusionScope:'structural-compilation',inputSchema:{type:'object',required:['sourceRevisionId'],properties:{sourceRevisionId:{type:'string',pattern:'^src_'},sourceSha256:{type:'string',pattern:'^[a-f0-9]{64}$'}},additionalProperties:false}} as const;
export const WorkerClaim=z.object({operationId:OperationId,taskId:TaskId,inputRevisionId:InputRevisionId,name:z.literal('mindmaps.compile'),fencingToken:z.number().int().positive(),source:SourceReference,leaseTtlMs:z.literal(60_000),heartbeatMs:z.literal(20_000)});
export const WorkerReport=z.object({fencingToken:z.number().int().positive(),inputRevisionId:InputRevisionId,status:z.enum(['succeeded','partial','failed']),artifactBase64:Base64Content.optional(),error:z.object({code:z.enum(['INVALID_MINDMAP','UNSUPPORTED_MINDMAP','ARTIFACT_VERIFICATION_FAILED','INTERNAL_ERROR']),message:z.string().max(1000)}).optional()}).refine(value=>value.status==='failed'?!!value.error&&!value.artifactBase64:!!value.artifactBase64&&!value.error,'Provide an artifact for completion or an error for failure');
registerErrorCodes({INVALID_MINDMAP:[422,'validation'],UNSUPPORTED_MINDMAP:[422,'validation']});
registerOperation('mindmaps.compile',{reads:['knowledge'],writes:['artifacts-evidence']});
