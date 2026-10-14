import {z} from 'zod';
import {ExecutionTransitionAssetPin,SafeRelativePath,ToolName,registerOperation,OperationRequest} from '../../contracts/src/index.ts';

export const MODULE_EXECUTE='module-execute';
export const FLOW_OPERATION='flow.invoke';
registerOperation(FLOW_OPERATION,{reads:['registered-assets','evidence'],writes:['declared-resource-effects']});
export const MODULE_EXECUTE_VERSION='1.0.0';
export const MODULE_EXECUTE_FLOW='module-execute/1';
const deadlineMs=OperationRequest.shape.deadlineMs.unwrap().optional();
const path=z.array(z.string().min(1).max(100).refine(value=>!['__proto__','constructor','prototype'].includes(value))).min(1).max(16);
export const FlowSubmission=z.object({deadlineMs,flowId:z.string().regex(/^[a-z][a-z0-9-]{0,99}$/),methodPin:ExecutionTransitionAssetPin,resources:z.record(ToolName,ExecutionTransitionAssetPin),sources:z.record(ToolName,ExecutionTransitionAssetPin).default({}),value:z.record(z.string(),z.unknown()).default({}),controlledBytes:z.array(z.object({slot:z.string().min(1).max(200),role:z.string().min(1).max(100),source:ToolName,path:SafeRelativePath}).strict()).max(256).default([])}).strict();
export const FlowDefinition=z.object({schema:z.literal('circle-packs/flow/1'),id:z.string().regex(/^[a-z][a-z0-9-]{0,99}$/),version:z.string().min(1).max(200),driver:z.literal('hub-execution-transition/1'),deadlineMs,transition:z.object({path:SafeRelativePath,export:z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/)}).strict(),initialState:z.unknown()}).strict();
const leaseArgument=ToolName.refine(value=>!['__proto__','constructor','prototype'].includes(value));
// An explicit map is closed: an absent Tool or {} receives no lease fields.
// Omission of the whole map preserves the legacy worker's global names.
const leaseMapping=z.object({idArgument:leaseArgument.optional(),fenceArgument:leaseArgument.optional()}).strict().refine(value=>!value.idArgument||!value.fenceArgument||value.idArgument!==value.fenceArgument,'Lease argument targets must be distinct');
const lease=z.object({acquireTool:ToolName,heartbeatTool:ToolName,releaseTool:ToolName,idPath:path,fencePath:path,idArgument:ToolName,fenceArgument:ToolName,ttlSecondsPath:path,argumentsByTool:z.record(ToolName,leaseMapping).optional()}).strict();
const refusal=z.object({stagePath:path,preDispatchStages:z.array(z.string().min(1).max(100)).min(1).max(20),dispatchedPath:path,remoteIdPath:path,codePath:path,reasonPath:path}).strict();
export const ProviderPolicy=z.object({schema:z.literal('hub-provider-observation/1'),submitTool:ToolName,statusTool:ToolName,resultTool:ToolName,reconcileTool:ToolName,taskIdArgument:ToolName,remoteIdPath:path,requestHashPath:path,inputSha256Path:path,byteHashesPath:path,statePath:path,runningValues:z.array(z.string().min(1).max(100)).min(1).max(20),terminalValues:z.array(z.string().min(1).max(100)).min(1).max(20),receiptSchema:z.record(z.string(),z.unknown()),lease,refusal}).strict();
export const ProviderConfiguration=z.object({schema:z.literal('hub-provider/1'),transport:z.literal('streamable-http'),runtimeProfileType:z.literal('execution').default('execution'),runtimeProfileRef:z.string().min(1).max(200),credentialMode:z.enum(['static-secret','server-issued','external-oauth','oauth','personal']).optional(),serviceClientId:z.string().optional(),authorizationScopes:z.array(z.string().min(1).max(150)).max(100).optional(),receiptPolicy:ProviderPolicy,executionPolicy:z.object({allowedPrincipals:z.array(z.string()).max(1000)}).strict().optional()}).strict();
export function field(value:any,keys:string[]):any{let current=value;for(const key of keys){if(!current||typeof current!=='object'||!Object.hasOwn(current,key))return undefined;current=current[key];}return current;}
