import {z} from 'zod';
import {AssetId,ArtifactId,SourceRevisionId,Sha256,registerErrorCodes,registerOperation} from '../../../packages/contracts/src/index.ts';
export const ExecutionInput=z.object({sourceRevisionId:SourceRevisionId.optional(),artifactId:ArtifactId.optional(),sourceSha256:Sha256.optional(),gatewayAssetId:AssetId,commandSourceAssetId:AssetId,build:z.string().min(1).max(200),platform:z.string().min(1).max(100).nullable().optional(),module:z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).optional(),deadlineMs:z.number().int().min(1000).max(3600000).default(3600000)}).strict().refine(value=>!!value.sourceRevisionId!==!!value.artifactId,'Provide exactly one source or artifact');
export const ExecutionPack={capabilityPackId:'apv-case-execute',version:'1.0.0',title:'APV 工作簿上机执行',inputFormats:['apv-execution-xlsx/1'],contractVersion:'APV_EXCEL_CONTRACT | apv.excel.runtime | v1',requiredOperations:['cases.verify','cases.execute','cases.observe'],conclusionScope:'gateway-device-observation',inputSchema:z.toJSONSchema(ExecutionInput,{io:'input'})};
registerErrorCodes({INVALID_EXECUTION_WORKBOOK:[422,'validation'],COMMAND_VALIDATION_FAILED:[422,'validation'],GATEWAY_REFUSED:[422,'execution']});
registerOperation('cases.verify',{reads:['knowledge','registered-source'],writes:['artifacts-evidence']});
registerOperation('cases.execute',{reads:['knowledge','registered-source','test-bed'],writes:['device-config','artifacts-evidence']});
registerOperation('cases.observe',{reads:['test-bed'],writes:['artifacts-evidence']});
