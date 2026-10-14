import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const API_VERSION = '1.0.0';
export const FLOW_VERSION = 'task/1';
export const PACK_FLOWS={'asset-tool':'asset-tool/1','asset-registration':'asset-registration/1','skill-run':'skill-run/1','asset-index':'asset-index/1','change-set':'change-set/1'} as const;
export const LEASE_TTL_MS = 60_000;
export const HEARTBEAT_MS = 20_000;
export const IDEMPOTENCY_WINDOW_MS = 86_400_000;
export const MAX_BODY_BYTES = 65_536;
export const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
export const MAX_WORKER_REPORT_BYTES = 32 * 1024 * 1024;

const identity = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9][A-Za-z0-9_-]*$`));
export const TaskId = identity('task');
export const InputRevisionId = identity('inrev');
export const OperationId = identity('op');
export const ScopeId = identity('scp');
export const SourceRevisionId = identity('src');
export const ArtifactId = identity('art');
export const EntityId=identity('ent');
export const EntityRevisionId=identity('erev');
export const RelationId=identity('rel');
export const AssetId=identity('ast');
export const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const Base64Content = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/).refine(value =>
  value.length % 4 === 0 && Buffer.from(value,'base64').toString('base64') === value,'Expected canonical standard base64');
export function newId(prefix: 'task' | 'inrev' | 'op' | 'pin' | 'src' | 'snap' | 'evd' | 'art' | 'rule' | 'audit' | 'rec' | 'ent' | 'erev' | 'rel' | 'rrev' | 'ast' | 'knr' | 'skp' | 'ofl' | 'svc' | 'cst' | 'mcr'): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}
export function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter(key => record[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}
export const canonicalHash = (value: unknown): string => sha256(canonicalJson(value));

export const TaskPhase = z.enum(['admitted', 'running', 'waiting-input', 'waiting-resource',
  'waiting-review', 'under-review', 'delivered', 'failed', 'cancelled', 'unknown']);
export type TaskPhase = z.infer<typeof TaskPhase>;
export const OperationStatus = z.enum(['accepted', 'running', 'succeeded', 'failed', 'unknown',
  'reconciled', 'partial', 'cancel-requested', 'cancel-delivered', 'stopped-observed', 'still-running']);
export type OperationStatus = z.infer<typeof OperationStatus>;
export const ConclusionKind = z.enum(['script-conclusion', 'model-judgment', 'unknown']);
export type ConclusionKind = z.infer<typeof ConclusionKind>;
export const terminalTask = (phase: TaskPhase): boolean => ['delivered', 'failed', 'cancelled'].includes(phase);

export const STANDARD_OPERATIONS:Record<string,{reads:string[];writes:string[]}> = {
  'product.version': { reads: ['device-state'], writes: [] },
  'product.config.read': { reads: ['device-state'], writes: [] },
  'product.config.write': { reads: ['device-state'], writes: ['device-config'] },
  'defects.search': { reads: ['external-system'], writes: [] },
  'defects.comment': { reads: ['external-system'], writes: ['external-system'] },
  'docs.fetch': { reads: ['knowledge'], writes: [] },
  'docs.convert': { reads: ['knowledge'], writes: ['artifacts-evidence'] },
  'tools.invoke': { reads: ['registered-source'], writes: ['artifacts-evidence'] },
  'assets.publish':{reads:['registered-assets'],writes:['asset-registry']},
  'assets.execute':{reads:['registered-assets'],writes:['artifacts-evidence']},
  'changesets.apply':{reads:['registered-assets'],writes:['asset-registry']},
};
const OperationName=z.string().regex(/^[a-z][a-z0-9._-]{0,149}$/);
export function registerOperation(name:string,effects:{reads:string[];writes:string[]}):void{OperationName.parse(name);const old=STANDARD_OPERATIONS[name];if(old&&canonicalHash(old)!==canonicalHash(effects))throw new Error('Operation effect registration conflicts');STANDARD_OPERATIONS[name]=effects;}
export const StandardOperation=OperationName.refine(name=>Object.hasOwn(STANDARD_OPERATIONS,name),'Operation is not registered');
export type StandardOperation = z.infer<typeof StandardOperation>;
export const Effects = z.object({ reads: z.array(z.string()), writes: z.array(z.string()) });
export const ConnectorManifest = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/), version: z.literal('1.0.0'), synthetic: z.literal(true),
  roles: z.array(z.enum(['defects', 'documents', 'product'])).min(1),
  operations: z.array(z.object({ name: StandardOperation, effects: Effects,
    idempotency: z.enum(['none', 'marker', 'content-hash']),
    reconciliation: z.enum(['read-back', 'content-hash', 'observation']) } )).min(1),
  events: z.object({ mode: z.enum(['cursor-poll', 'none']) }),
}).superRefine((manifest, context) => {
  const seen = new Set<string>();
  for (const [index, operation] of manifest.operations.entries()) {
    if (!STANDARD_OPERATIONS[operation.name]||canonicalHash(operation.effects) !== canonicalHash(STANDARD_OPERATIONS[operation.name]) || seen.has(operation.name)) {
      context.addIssue({ code: 'custom', path: ['operations', index], message: 'Operation effect declaration or identity is inconsistent' });
    }
    if (operation.effects.writes.length && operation.idempotency === 'none') {
      context.addIssue({ code: 'custom', path: ['operations', index], message: 'Writes require a declared idempotency strategy' });
    }
    seen.add(operation.name);
  }
});
export type ConnectorManifest = z.infer<typeof ConnectorManifest>;

export const SubmitRequest = z.object({ scopeId: ScopeId, title: z.string().min(1).max(2000).default('Run a task'),
  idempotencyKey: z.string().min(8).max(200), capabilityPackId:z.string().regex(/^[a-z][a-z0-9-]{0,99}$/).optional(),
  input: z.record(z.string(), z.unknown()).default({}) });
export type SubmitRequest = z.infer<typeof SubmitRequest>;
export const DevLoginRequest = z.object({ username: z.string().max(100), password: z.string().max(1000),
  expiresInMs: z.number().int().positive().optional() });
export const DevLoginResult = z.object({ token: z.string(), tokenType: z.literal('Bearer'), expiresAt: z.string(),
  principalId: z.string(), tenantId: z.string(), scopes: z.array(ScopeId),subjectType:z.enum(['human','service-client']).optional(),roles:z.array(z.object({scopeId:ScopeId,role:z.enum(['admin','member','viewer'])})).optional() });
export const AuthRefreshRequest=z.object({}).strict();
export const SourceUpload = z.object({ scopeId: ScopeId, fileName: z.string().min(1).max(240), contentBase64: Base64Content });
export const SourceReference = z.object({ sourceRevisionId: SourceRevisionId, sha256: Sha256, size: z.number().int().nonnegative(), fileName: z.string(), scopeId: ScopeId });
const PackageName=z.string().regex(/^[a-z][a-z0-9-]{0,99}$/);
const PackageVersion=z.string().regex(/^\d+\.\d+\.\d+$/);
export const AssetKind=z.enum(['connector-instance','credential-reference','knowledge-source','knowledge-snapshot','environment-resource','skill-package','instruction','agent','command','trigger','bot','scope-role','scope-policy','runtime-profile','execution-submission']);
export const AssetLifecycle=z.enum(['draft','approved','running','disabled','declined']);
export const ToolDescriptor=z.object({name:z.string().min(1).max(160),description:z.string(),inputSchema:z.object({type:z.literal('object')}).catchall(z.unknown()),annotations:z.record(z.string(),z.unknown()).optional(),effect:z.enum(['read','write']),minimumRole:z.enum(['viewer','member','admin']),approval:z.boolean()}).strict();
export const AssetDeclaration=z.object({reads:z.array(z.string()).max(100),writes:z.array(z.string()).max(100),credentials:z.array(AssetId).max(100),executionIsChange:z.boolean().optional(),allowedTestHosts:z.array(z.string().min(1).max(200)).max(100).optional(),hostCommandPolicies:z.record(z.string(),z.record(z.string(),z.unknown())).optional(),provides:z.object({tools:z.array(ToolDescriptor).max(100).optional(),resources:z.array(z.record(z.string(),z.unknown())).max(100).optional(),prompts:z.array(z.record(z.string(),z.unknown())).max(100).optional()}).strict().optional()}).strict();
export const AssetRegistration=z.object({assetId:AssetId.optional(),scopeId:ScopeId,kind:AssetKind,name:z.string().min(1).max(200),version:PackageVersion,
  ownerPrincipalId:z.string().regex(/^prn_/).optional(),declaration:AssetDeclaration,configuration:z.record(z.string(),z.unknown()).default({}),readers:z.array(z.string()).max(1000).optional()}).strict();
export type AssetRegistration=z.infer<typeof AssetRegistration>;
export const AssetTransition=z.object({version:PackageVersion,sha256:Sha256,state:AssetLifecycle});
export const ServiceClientId=identity('svc');
const OAuthScope=z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]{1,150}$/);
export const ServiceClientRegistration=z.object({scopeId:ScopeId,resourceAssetId:AssetId,name:z.string().min(1).max(200),secret:z.string().min(32).max(2048),scopes:z.array(OAuthScope).max(100),resourceScopes:z.array(OAuthScope).max(100).default([])}).strict();
export const ServiceClientRotation=z.object({secret:ServiceClientRegistration.shape.secret}).strict();
export const CredentialRegistration=z.object({version:PackageVersion,value:z.string().min(1).max(65536),ownerPrincipalId:z.string().regex(/^prn_/).optional(),mode:z.literal('static-secret').optional()}).strict().refine(input=>input.mode!=='static-secret'||input.value.length>=32&&!/[\r\n\x00]/.test(input.value),'Static Bearer secrets need at least 32 characters and cannot contain header controls');
export const OAuthGrantInput=z.object({connectorAssetId:AssetId,connectorVersion:PackageVersion,profileRef:z.string().min(1).max(200),clientCredentialId:AssetId.optional(),idempotencyKey:z.string().min(8).max(200)}).strict();
export const AssetListQuery=z.object({limit:z.coerce.number().int().min(1).max(100).default(20),after:AssetId.optional(),kind:AssetKind.optional(),lifecycle:AssetLifecycle.optional()});
export const ObjectTypeReference=z.object({packageId:PackageName,version:PackageVersion,typeId:PackageName}).strict();
export const AttributeKind=z.enum(['string','number','boolean','string[]','object','any']);
export const ObjectTypeDefinition=z.object({id:PackageName,attributes:z.record(z.string().min(1).max(100),AttributeKind),
  required:z.array(z.string()).max(100).default([])}).strict().refine(value=>value.required.every(key=>Object.hasOwn(value.attributes,key)),'Required attributes must be declared');
export const ObjectTypePackage=z.object({id:PackageName,version:PackageVersion,types:z.array(ObjectTypeDefinition).min(1).max(100)}).strict()
  .refine(value=>new Set(value.types.map(type=>type.id)).size===value.types.length,'Object type identities must be unique');
export type ObjectTypePackage=z.infer<typeof ObjectTypePackage>;
export const ObjectSourceKey=z.object({system:PackageName,objectType:z.string().min(1).max(100),externalId:z.string().min(1).max(200)}).strict();
export const ObjectSource=ObjectSourceKey.extend({revision:z.string().min(1).max(300),contentBase64:Base64Content,sha256:Sha256.optional()}).strict();
export const ObjectAccess=z.object({sourceReaders:z.array(z.string().min(1).max(200)).max(1000),platformReaders:z.array(z.string().min(1).max(200)).max(1000)}).strict();
export const ObjectObservation=z.object({scopeId:ScopeId,observationKey:z.string().min(1).max(200),source:ObjectSource,type:ObjectTypeReference,
  attributes:z.record(z.string(),z.unknown()),acl:ObjectAccess}).strict();
export type ObjectObservation=z.infer<typeof ObjectObservation>;
export const RelationObservation=z.object({scopeId:ScopeId,observationKey:z.string().min(1).max(200),type:PackageName,
  fromEntityId:EntityId,toEntityId:EntityId,source:ObjectSource,acl:ObjectAccess}).strict();
export type RelationObservation=z.infer<typeof RelationObservation>;
export const ObjectListQuery=z.object({limit:z.coerce.number().int().min(1).max(100).default(20),after:EntityId.optional(),
  typeId:PackageName.optional(),system:PackageName.optional()});
export const EntityView=z.object({entityId:EntityId,entityRevisionId:EntityRevisionId,scopeId:ScopeId,type:ObjectTypeReference,
  knowledgeCategory:z.enum(['product','consolidated']),sourceType:z.string(),
  source:ObjectSourceKey.extend({revision:z.string()}),attributes:z.record(z.string(),z.unknown()),
  provenance:z.object({observationKey:z.string(),observedAt:z.string(),observerId:z.string(),origin:z.literal('manual-observation'),raw:SourceReference})});
export const ObjectPage=z.object({items:z.array(EntityView),total:z.number().int().nonnegative(),nextCursor:EntityId.nullable()});
export const KnowledgeRecordId=identity('knr');
export const SourceArtifactId=identity('sar');
export const KnowledgeCategory=z.enum(['product','consolidated']);
export const KnowledgeSourceType=z.enum(['document','command-tree','external-artifact','query-mirror','build-record','environment-view','shared-session','skill-run','bot-run','review-correction','footprint']);
export const KnowledgeSourceInput=z.object({scopeId:ScopeId,sourceId:z.string().min(1).max(1000),revision:z.string().min(1).max(300),path:z.string().min(1).max(2000),
  knowledgeCategory:KnowledgeCategory,sourceType:KnowledgeSourceType,parserVersion:z.string().min(1).max(100),contentBase64:Base64Content,sha256:Sha256.optional(),
  acl:ObjectAccess,sharing:z.object({allowed:z.boolean(),teamPromotion:z.boolean()}).strict().optional()}).strict();
export const KnowledgeEvidenceInput=z.object({sourceRecordId:KnowledgeRecordId,start:z.number().int().nonnegative(),end:z.number().int().positive(),quoteBase64:Base64Content.optional()}).strict();
export const KnowledgeEntityInput=z.object({sourceRecordId:KnowledgeRecordId,subject:z.string().min(1).max(500),kind:z.string().min(1).max(100),name:z.string().min(1).max(500),
  aliases:z.array(z.string()).max(100).default([]),attributes:z.record(z.string(),z.unknown()).default({}),entityRevisionId:EntityRevisionId.optional()}).strict();
export const KnowledgeClaimInput=z.object({scopeId:ScopeId,subject:z.string().min(1).max(500),predicate:z.string().min(1).max(200),value:z.unknown(),
  conditions:z.record(z.string(),z.unknown()).default({}),evidenceIds:z.array(KnowledgeRecordId).min(1).max(100),entityIds:z.array(KnowledgeRecordId).max(100).default([]),
  origin:z.enum(['manual','script','model']).default('manual')}).strict();
export const KnowledgeReviewRequest=z.object({reviewerId:z.string().regex(/^prn_/)}).strict();
export const KnowledgeReviewInput=z.object({decision:z.enum(['approve','reject']),promote:z.boolean().default(false),reason:z.string().min(1).max(2000),ruleVersion:z.string().min(1).max(100),productClaimId:KnowledgeRecordId.optional()}).strict();
export const KnowledgeSnapshotInput=z.object({scopeId:ScopeId,knowledgeCategory:KnowledgeCategory,expectedSnapshotId:KnowledgeRecordId.nullable()}).strict();
export const KnowledgeSearchQuery=z.object({q:z.string().max(1000).default(''),mode:z.enum(['exact','prefix','directory','fulltext']).default('fulltext'),
  limit:z.coerce.number().int().min(1).max(100).default(20),includeCandidates:z.enum(['true','false']).default('false')});
export const ToolName=z.string().min(1).max(150).regex(/^[a-z0-9._]+$/);
export const ToolView=z.object({name:ToolName,title:z.string(),description:z.string(),inputSchema:z.object({type:z.literal('object')}).catchall(z.unknown()),
  effect:z.enum(['read','write']),mode:z.enum(['sync','task']),permission:z.string(),minimumRole:z.enum(['viewer','member','admin']).optional(),approval:z.boolean().optional(),annotations:z.record(z.string(),z.unknown()).optional(),assetId:AssetId,assetVersion:PackageVersion});
export const ToolCallInput=z.object({args:z.record(z.string(),z.unknown()),idempotencyKey:z.string().min(8).max(200),sourceArtifactId:SourceArtifactId.optional()}).strict();
export const ToolEvidence=z.object({evidenceId:z.string(),sha256:Sha256});
export const ToolCallResult=z.union([z.object({result:z.unknown(),evidence:z.array(ToolEvidence)}),z.object({taskId:TaskId,phase:TaskPhase})]);
export const SafeRelativePath=z.string().min(1).max(500).refine(path=>!path.startsWith('/')&&!/^[a-z]:/i.test(path)&&!path.includes('\\')&&!/[\x00-\x1f]/.test(path)&&path.split('/').every(part=>part!==''&&part!=='.'&&part!=='..'&&part!=='.git'),'Use a safe relative path');
export const ModuleEntry=z.object({id:PackageName,kind:z.enum(['skill-pack','product-line']),root:SafeRelativePath,manifestPath:SafeRelativePath,version:PackageVersion,files:z.array(z.object({path:SafeRelativePath.refine(path=>path.split('/').every(part=>!part.startsWith('.')),'Module files cannot be hidden'),sha256:Sha256}).strict()).min(1).max(100),digest:Sha256}).strict();
export const ModuleCatalog=z.object({schema:z.literal('circle-packs/modules/1'),modules:z.array(ModuleEntry).max(1000)}).strict().refine(value=>new Set(value.modules.map(module=>module.id)).size===value.modules.length,'Module ids must be unique');
export const ModuleBytes=z.array(z.object({path:SafeRelativePath,base64:Base64Content,sha256:Sha256}).strict()).min(1).max(100);
export const SourceArtifactFileInput=z.object({path:SafeRelativePath,role:z.string().min(1).max(100),mediaType:z.string().min(1).max(200).default('application/octet-stream'),sourceRevisionId:SourceRevisionId.optional(),sourceRecordId:KnowledgeRecordId.optional(),sha256:Sha256.optional()}).strict().refine(value=>!!value.sourceRevisionId!==!!value.sourceRecordId,'Provide one original source revision or product SourceRevision record');
export const SourceArtifactConfiguration=z.object({schema:z.literal('external-source-artifact/1'),metadata:z.record(z.string(),z.unknown()).default({}),files:z.array(SourceArtifactFileInput).min(1).max(100)}).strict().refine(value=>new Set(value.files.map(file=>file.path)).size===value.files.length,'Artifact file paths must be unique');
export const SourceArtifactRegistration=z.object({scopeId:ScopeId,name:z.string().min(1).max(200),version:PackageVersion,metadata:z.record(z.string(),z.unknown()).default({}),files:z.array(SourceArtifactFileInput).min(1).max(100),readers:z.array(z.string()).max(1000).optional()}).strict().refine(value=>new Set(value.files.map(file=>file.path)).size===value.files.length,'Artifact file paths must be unique');
export const SourceArtifactView=z.object({assetId:AssetId,scopeId:ScopeId,version:PackageVersion,sha256:Sha256,lifecycle:AssetLifecycle,sourceArtifactId:SourceArtifactId.nullable(),metadata:z.record(z.string(),z.unknown()),files:z.array(z.object({path:SafeRelativePath,role:z.string(),mediaType:z.string(),sourceRevisionId:SourceRevisionId,sourceRecordId:KnowledgeRecordId,sha256:Sha256,size:z.number().int().nonnegative()})),provenance:z.object({kind:z.literal('user-upload'),semanticQuality:z.literal('not-asserted')})});
export const SkillPackId=identity('skp');
export const SkillManifest=z.object({id:PackageName,version:PackageVersion,title:z.string().min(1).max(500),owner:z.string().min(1).max(200),
  tools:z.array(ToolName).max(100).refine(values=>new Set(values).size===values.length),triggers:z.array(z.enum(['manual','schedule','event'])).min(1).max(3),
  inputs:z.record(z.string(),z.unknown()),outputs:z.array(SafeRelativePath).min(1).max(100).refine(paths=>new Set(paths).size===paths.length),model:z.unknown()}).strict();
export const SkillPackSubmission=z.object({manifest:SkillManifest,files:ModuleBytes,
  trial:z.object({toolCalls:z.array(z.object({name:ToolName,argsSha256:Sha256,ok:z.boolean()}).strict()).max(1000),outputs:z.array(z.object({path:SafeRelativePath,sha256:Sha256}).strict()).max(100)}).strict(),module:ModuleEntry.optional()}).strict();
export const ModuleInstallRequest=z.object({module:ModuleEntry,files:ModuleBytes,trial:SkillPackSubmission.shape.trial.optional()}).strict();
export const SkillPackCheck=z.object({undeclaredTools:z.array(ToolName),missingTools:z.array(ToolName)});
export const SkillPackView=z.object({skillPackId:SkillPackId,digest:Sha256,status:z.enum(['candidate','registered','declined','superseded']),check:SkillPackCheck,changeSetId:z.string().nullable().optional(),approvalTaskId:TaskId,
  manifest:SkillManifest,ownerPrincipalId:z.string(),scopeId:ScopeId,assetId:AssetId,assetVersion:PackageVersion});
export const SkillRunInput=z.object({inputs:z.record(z.string(),z.unknown()),idempotencyKey:z.string().min(8).max(200)}).strict();
const TriggerBase=z.object({scopeId:ScopeId,version:PackageVersion,name:z.string().min(1).max(200)});
export const MIN_SCHEDULE_INTERVAL_MS=60_000;
export const TriggerRegistration=z.discriminatedUnion('kind',[
  TriggerBase.extend({kind:z.literal('schedule'),intervalMs:z.number().int().min(MIN_SCHEDULE_INTERVAL_MS).max(31536000000),startsAt:z.iso.datetime()} ).strict(),
  TriggerBase.extend({kind:z.literal('event'),sourceAssetId:AssetId,eventName:z.string().min(1).max(100)}).strict(),
]);
export const BotRegistration=TriggerBase.extend({skillPackId:SkillPackId,triggerAssetId:AssetId,identityPrincipalId:z.string().regex(/^prn_/),channel:z.string().min(1).max(100),inputs:z.record(z.string(),z.unknown())}).strict();
export const ConnectorEventInput=z.object({externalId:z.string().min(1).max(300),name:z.string().min(1).max(100),payload:z.record(z.string(),z.unknown())}).strict();
export const ArtifactReference = z.object({ artifactId: ArtifactId, sha256: Sha256, size: z.number().int().positive(),
  fileName: z.string(), mediaType: z.enum(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/json','text/plain']),
  downloadPath: z.string() });
export const UnmappedElement = z.object({ path: z.string(), reason: z.string() });
export type UnmappedElement = z.infer<typeof UnmappedElement>;
export const RuleRequest=z.object({scopeId:ScopeId,capabilityPackId:z.string().regex(/^[a-z][a-z0-9-]{0,99}$/),servicePrincipalId:z.string().regex(/^prn_/),
  bindings:z.record(z.string(),z.string()),intervalMs:z.number().int().min(100).max(60_000).default(1000),simulateCommentTimeout:z.boolean().default(false)});
export const ADMIN_ROUTES={tasks:'/v1/admin/tasks',workers:'/v1/admin/workers',approvals:'/v1/admin/approvals',events:'/v1/admin/events',audit:'/v1/admin/audit',connectors:'/v1/admin/connectors',restart:'/v1/admin/restart'} as const;
export const InputRequest = z.object({ inputRevisionId: InputRevisionId, requestId: z.string().optional(),
  response: z.record(z.string(), z.unknown()).optional(),
  replacement: z.record(z.string(), z.unknown()).optional() }).refine(value => !!value.response !== !!value.replacement,
    'Provide exactly one response or replacement');
export const ApprovalRequest = z.object({ inputRevisionId: InputRevisionId, targetIdentity: z.string().min(1),
  actionDigest: Sha256, approve: z.boolean() });
export const OperationRequest = z.object({ inputRevisionId: InputRevisionId, name: StandardOperation,
  target: z.string().min(1).max(200), targetIdentity: z.string().min(1).max(300),
  args: z.record(z.string(), z.unknown()).default({}),
  idempotencyKey: z.string().min(8).max(200), deadlineMs: z.number().int().min(1).max(3_600_000).default(300_000),
  approvalId: z.string().optional(),authorizationAssetId:AssetId.optional() });
export type OperationRequest = z.infer<typeof OperationRequest>;
export const ApprovalProposal = OperationRequest.omit({idempotencyKey:true,deadlineMs:true,approvalId:true});
export const ApprovalView=z.object({approvalId:z.string(),taskId:TaskId,inputRevisionId:InputRevisionId,applicantId:z.string(),
  targetIdentity:z.string(),actionDigest:Sha256,action:ApprovalProposal,status:z.enum(['open','approved','declined','superseded','expired']),
  approvedBy:z.string().nullable(),expiresAt:z.string(),supersededBy:z.string().nullable().optional(),decisionMode:z.enum(['self','independent']).nullable().optional(),singleAdminMode:z.boolean().optional(),verification:z.unknown().optional()});
export type ApprovalView=z.infer<typeof ApprovalView>;
export const ScopeRolePatch=z.object({principalId:z.string().regex(/^prn_/),role:z.enum(['admin','member','viewer']).nullable(),idempotencyKey:z.string().min(8).max(200)}).strict();
export const ScopeSla=z.object({awaitingMyApproval:z.number().int().positive().max(1e13),awaitingMyInput:z.number().int().positive().max(1e13),submittedByMe:z.number().int().positive().max(1e13),assignedToMe:z.number().int().positive().max(1e13),exceptions:z.number().int().positive().max(1e13)}).strict();
export const ScopePolicyPatch=z.object({twoPersonRule:z.boolean(),slaMs:ScopeSla.optional(),idempotencyKey:z.string().min(8).max(200)}).strict();
export const ChangeSetSubmission=z.object({scopeId:ScopeId,title:z.string().min(1).max(500).optional(),items:z.array(z.object({assetId:AssetId,version:PackageVersion,sha256:Sha256}).strict()).min(1).max(100),idempotencyKey:z.string().min(8).max(200)}).strict();
export const ConclusionRequest=z.object({inputRevisionId:InputRevisionId,kind:ConclusionKind,methodId:z.string().regex(/^[a-z][a-z0-9-]{0,99}$/).optional(),
  evidenceIds:z.array(z.string().regex(/^evd_/)).max(16).default([]),judgment:z.enum(['supports','refutes','abstained']).default('abstained'),rationale:z.string().max(2000).default('')});
export const ChecklistPredicate=z.string().min(1).max(100);
export const ChecklistRequest=z.object({inputRevisionId:InputRevisionId,items:z.array(z.object({itemId:z.string().min(1).max(100),requiresFact:z.boolean(),required:z.boolean(),predicate:ChecklistPredicate})).min(1).max(30)});
export const ChecklistResponse=z.object({inputRevisionId:InputRevisionId,conclusionId:z.string().regex(/^rec_/)});
export const actionDigest = (value: Pick<OperationRequest, 'inputRevisionId' | 'name' | 'target' | 'targetIdentity' | 'args'>): string => canonicalHash({
  inputRevisionId: value.inputRevisionId, name: value.name, target: value.target,
  targetIdentity: value.targetIdentity, args: value.args,
});
export const RetainedEventContent=z.object({evidenceId:z.string().optional(),artifactId:z.string().optional(),sha256:Sha256.optional(),fileName:z.string().optional(),downloadPath:z.string()}).refine(value=>Boolean(value.evidenceId)!==Boolean(value.artifactId),'Exactly one retained object id is required');
export const EventContent=z.object({sha256:Sha256,size:z.number().int().nonnegative(),downloadPath:z.string(),retained:z.array(RetainedEventContent).optional()});
export const Event = z.object({ seq: z.number().int().positive(), taskId: TaskId, kind: z.string(),
  payload: z.record(z.string(), z.unknown()), createdAt: z.string(),content:EventContent.optional() });
export type Event = z.infer<typeof Event>;

const registry:Record<string,[number,string]> = {
  INVALID_PAYLOAD: [400, 'validation'], BODY_TOO_LARGE: [413, 'validation'], UNSUPPORTED_VERSION: [400, 'validation'],
  UNAUTHENTICATED: [401, 'permission'], FORBIDDEN_SCOPE: [403, 'permission'], FORBIDDEN_ACTION: [403, 'permission'],
  FORBIDDEN_TARGET: [403, 'permission'], SELF_APPROVAL: [403, 'permission'],
  TARGET_NOT_FOUND: [404, 'target'], TARGET_IDENTITY_MISMATCH: [409, 'target'],
  IDEMPOTENCY_MISMATCH: [409, 'conflict-stale'], INPUT_REVISION_STALE: [409, 'conflict-stale'],
  INPUT_EXPIRED: [409, 'conflict-stale'], DECISION_CONFLICT: [409, 'conflict-stale'],
  APPROVAL_REQUIRED: [409, 'permission'], APPROVAL_STALE: [409, 'conflict-stale'],
  FENCING_STALE: [409, 'lease'], LEASE_EXPIRED: [409, 'lease'], RESOURCE_BUSY: [409, 'lease'],
  CONNECTOR_DISABLED: [409, 'permission'], EVIDENCE_INSUFFICIENT: [409, 'semantic-insufficient'],
  UPSTREAM_TIMEOUT: [504, 'transient'], INTERNAL_ERROR: [500, 'internal'],
  OBJECT_NOT_VISIBLE: [404, 'permission'], IDENTITY_UNMAPPED: [409, 'permission'],
  ASSET_NOT_VISIBLE: [404,'permission'],
  ARTIFACT_VERIFICATION_FAILED: [409, 'semantic-insufficient'], SOURCE_HASH_MISMATCH: [409, 'conflict-stale'],
  SOURCE_ABSENT:[404,'source-absent'],SOURCE_FORBIDDEN:[403,'permission'],SOURCE_LOGIN_EXPIRED:[401,'authentication'],SOURCE_UNREACHABLE:[503,'source-unreachable'],
  SHARING_REQUIRED:[403,'permission'],
  TOOL_NAME_CONFLICT:[409,'conflict-stale'],RESULT_TOO_LARGE:[413,'validation'],
  SKILLPACK_CHECK_FAILED:[422,'validation'],RUNTIME_VERSION_MISMATCH:[409,'conflict-stale'],RUNTIME_FAILED:[502,'execution'],
  DEPENDENCY_NOT_APPROVED:[409,'dependency'],
  COMMAND_NOT_IN_TREE:[422,'execution'],DESTRUCTIVE_COMMAND:[422,'execution'],BUILD_MISMATCH:[409,'execution'],GATEWAY_UNREACHABLE:[503,'execution'],PERMISSION_DENIED:[403,'permission'],LEASE_UNAVAILABLE:[409,'execution'],SOURCE_NOT_APPROVED:[409,'dependency'],
  RATE_LIMITED:[429,'transient'],
  IMPORT_NOT_DECLARED:[422,'validation'],HOOK_FAILED:[422,'execution'],
  SANDBOX_UNAVAILABLE:[503,'execution'],
  RECEIPT_PROCESSING_FAILED:[500,'execution'],
};
export function registerErrorCodes(errors:Record<string,[number,string]>):void{for(const [code,definition] of Object.entries(errors)){if(registry[code]&&canonicalHash(registry[code])!==canonicalHash(definition))throw new Error('Error registration conflicts');registry[code]=definition;}}
export type ErrorCode = string;
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly category: string;
  readonly details: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message); this.code = code; const definition=registry[code]??registry.INTERNAL_ERROR;this.httpStatus = definition[0]; this.category = definition[1]; this.details = details;
  }
}
export function requireCondition(condition: unknown, code: ErrorCode, message: string): asserts condition {
  if (!condition) throw new ApiError(code, message);
}

export interface RunConstraint {taskId:string;tools:string[];scopes:string[];grants:string[];operationId?:string;fencingToken?:number}
export interface AuthContext { principalId: string; tenantId: string; kind: 'user' | 'service' | 'worker'; workerId?: string;run?:RunConstraint;tokenDigest?:string }
export interface Policy extends AuthContext { scopes: string[]; grants: string[]; targets: string[]; defects: string[];scopeGrants?:Record<string,string[]>;roles?:{scopeId:string;role:'admin'|'member'|'viewer'}[] }
export interface Task {
  taskId: string; tenantId: string; scopeId: string; principalId: string; title: string; phase: TaskPhase;
  inputRevisionId: string; input: Record<string, unknown>; revision: number; flowVersion: string;
  capabilityPackId?: string; packVersion?: string;waitingReason?:string|null;assignee?:string|null;dueAt?:string|null;
}
export const ExecutionClaim = z.object({ operationId:OperationId,taskId:TaskId,inputRevisionId:InputRevisionId,
  name:StandardOperation,kind:z.enum(['execute','reconcile']),target:z.string(),targetIdentity:z.string(),
  args:z.record(z.string(),z.unknown()),actionDigest:Sha256,parentOperationId:OperationId.optional(),
  fencingToken:z.number().int().positive(),leaseTtlMs:z.literal(60_000),heartbeatMs:z.literal(20_000) });
export const AnyWorkerClaim = ExecutionClaim.partial({kind:true,target:true,targetIdentity:true,actionDigest:true}).extend({source:SourceReference.optional(),args:z.record(z.string(),z.unknown()).default({})});
export const ExecutionReport = z.object({ fencingToken:z.number().int().positive(),inputRevisionId:InputRevisionId,
  status:z.enum(['succeeded','failed','unknown']),output:z.record(z.string(),z.unknown()).default({}),
  error:z.object({ code:z.string(),message:z.string().max(1000),details:z.record(z.string(),z.unknown()).optional() }).optional() });
export const TaskResult = z.object({ taskId: TaskId, inputRevisionId: InputRevisionId, phase: TaskPhase,
  result:z.unknown().optional(),
  runtime:z.record(z.string(),z.unknown()).optional(),
  capabilityPackId: z.string().optional(), status: z.enum(['accepted','running','succeeded','partial','failed','unknown','cancel-requested','cancelled']),
  artifacts: z.array(ArtifactReference), evidence: z.array(z.object({ evidenceId: z.string(), kind: ConclusionKind,
    sha256: Sha256, size: z.number(), downloadPath: z.string() })), unmapped: z.array(UnmappedElement),
  verification: z.object({ reader: z.string(), rowCount: z.number().int().nonnegative(), sourceSha256: Sha256,
    irSha256: Sha256, artifactSha256: Sha256 }).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export const TaskView = z.object({ taskId: TaskId,tenantId:z.string(),scopeId:ScopeId,principalId:z.string(),title:z.string(),
  phase:TaskPhase,inputRevisionId:InputRevisionId,input:z.record(z.string(),z.unknown()),revision:z.number().int().positive(),
  flowVersion:z.string(),capabilityPackId:z.string().optional(),packVersion:z.string().optional(),waitingReason:z.string().nullable().optional(),assignee:z.string().nullable().optional(),dueAt:z.string().datetime().nullable().optional(),
  pendingInputs:z.array(z.object({ requestId:z.string(),inputRevisionId:InputRevisionId,kind:z.string(),question:z.string(),
    binding:z.record(z.string(),z.unknown()),expiresAt:z.string(),status:z.string() })).optional(),
});
export type TaskView=z.infer<typeof TaskView>;
export const TaskListQuery=z.object({limit:z.coerce.number().int().min(1).max(100).default(20),kind:z.enum(['work','tool','index']).optional(),capabilityPackId:z.string().regex(/^[a-z][a-z0-9-]{0,99}$/).optional(),after:TaskId.optional()});
export const RegistryPageQuery=z.object({view:z.literal('page'),limit:z.coerce.number().int().min(1).max(100).default(20),cursor:z.string().min(1).max(4096).optional(),scopeId:ScopeId.optional(),productLineId:z.string().min(1).max(200).optional(),flowVersion:z.string().min(1).max(200).optional(),status:z.string().min(1).max(100).optional(),lifecycle:z.string().min(1).max(100).optional(),owner:z.string().min(1).max(200).optional(),minAgeMs:z.coerce.number().int().min(0).max(1e13).optional(),maxAgeMs:z.coerce.number().int().min(0).max(1e13).optional(),sort:z.enum(['age','updatedAt']).default('updatedAt'),order:z.enum(['asc','desc']).default('desc')}).refine(q=>q.minAgeMs===undefined||q.maxAgeMs===undefined||q.minAgeMs<=q.maxAgeMs,'Minimum age must not exceed maximum age');
export type RegistryPageQuery=z.infer<typeof RegistryPageQuery>;
export const RegistryPage=z.object({total:z.number().int().nonnegative(),items:z.array(z.unknown()),cursor:z.string().nullable()});
export const WorkQueue=z.enum(['awaitingMyApproval','awaitingMyInput','submittedByMe','assignedToMe','exceptions']);
export const TaskPageQuery=RegistryPageQuery.safeExtend({kind:TaskListQuery.shape.kind,capabilityPackId:TaskListQuery.shape.capabilityPackId,queue:WorkQueue.optional(),exception:z.enum(['unknown','expired','superseded','failed']).optional()}).refine(value=>value.exception===undefined||value.queue==='exceptions','Exception group requires the exceptions queue');
const {view:_queueView,limit:_queueLimit,cursor:_queueCursor,queue:_queueSelection,exception:_queueException,...queueFacetShape}=TaskPageQuery.shape;
export const QueueQuery=z.object({...queueFacetShape,view:z.literal('page').optional()}).strict().refine(q=>q.minAgeMs===undefined||q.maxAgeMs===undefined||q.minAgeMs<=q.maxAgeMs,'Minimum age must not exceed maximum age');
export const TaskAssignment=z.object({inputRevisionId:InputRevisionId,assignee:z.string().regex(/^prn_/).nullable().optional(),dueAt:z.string().datetime().nullable().optional()}).strict().refine(value=>value.assignee!==undefined||value.dueAt!==undefined,'Specify an assignee or dueAt');
export const AssetPageQuery=RegistryPageQuery.extend({kind:AssetKind.optional()});
export const NotificationQuery=z.object({cursor:z.coerce.number().int().nonnegative().default(0),limit:z.coerce.number().int().min(1).max(200).default(100)});
export const NotificationView=z.object({seq:z.number().int().nonnegative(),taskId:TaskId.nullable(),scopeId:ScopeId,kind:z.string(),payload:z.record(z.string(),z.unknown()),createdAt:z.string(),content:EventContent.optional()});
export const NotificationPage=z.object({items:z.array(NotificationView),cursor:z.number().int().nonnegative(),hasMore:z.boolean(),replayWindow:z.object({minCursor:z.number().nonnegative(),replayEvents:z.number().int().positive(),maxRows:z.number().int().positive()}).optional()});
export const QueueCounter=z.object({count:z.number().int().nonnegative(),oldestWaitMs:z.number().nonnegative(),overSla:z.number().int().nonnegative(),slaMs:z.number().int().positive().nullable()});
export const QueueView=z.object({awaitingMyApproval:QueueCounter,awaitingMyInput:QueueCounter,submittedByMe:QueueCounter,assignedToMe:QueueCounter,exceptions:QueueCounter.extend({groups:z.record(z.string(),QueueCounter).optional(),omittedGroups:z.record(z.string(),z.object({reason:z.literal('facet-not-applicable'),facets:z.array(z.string())})).optional()}),slaByScope:z.record(ScopeId,ScopeSla).optional(),workerOfflineAfterMs:z.number().int().positive().optional()});
export const WorkerView=z.object({workerId:z.string(),draining:z.boolean(),lastSeen:z.string().datetime(),offline:z.boolean(),workerOfflineAfterMs:z.number().int().positive()});
export const SubmittedTask = TaskView.extend({ deduplicated:z.boolean() });
export const EventPage = z.object({ events:z.array(Event),after:z.number().int().nonnegative() });
export const CLIENT_ROUTES = {
  devLogin:{ method:'POST',path:'/v1/auth/dev-login',request:DevLoginRequest,response:DevLoginResult },
  authRefresh:{method:'POST',path:'/v1/auth/refresh',request:AuthRefreshRequest,response:DevLoginResult},
  authLogout:{method:'POST',path:'/v1/auth/logout',request:AuthRefreshRequest},
  notifications:{method:'GET',path:'/v1/notifications',query:NotificationQuery,response:NotificationPage},
  notificationStream:{method:'GET',path:'/v1/notifications/stream',contentType:'text/event-stream'},
  queues:{method:'GET',path:'/v1/queues',query:QueueQuery,response:QueueView},
  workers:{method:'GET',path:'/v1/workers',pageQuery:RegistryPageQuery,response:z.union([z.array(WorkerView),RegistryPage])},
  adminWorkers:{method:'GET',path:'/v1/admin/workers',pageQuery:RegistryPageQuery,pageResponse:RegistryPage},
  adminAudit:{method:'GET',path:'/v1/admin/audit',pageQuery:RegistryPageQuery,pageResponse:RegistryPage},
  taskAssignment:{method:'POST',path:'/v1/tasks/{taskId}/assignment',request:TaskAssignment,response:TaskView},
  mcp:{method:'POST',path:'/mcp',protocolVersion:'2025-11-25'},
  harnessImport:{method:'POST',path:'/v1/harness/import'},
  harnessExport:{method:'GET',path:'/v1/assets/{id}/harness-export'},
  permissionExport:{method:'GET',path:'/v1/scopes/{scopeId}/permission-export'},
  sources:{ method:'POST',path:'/v1/sources',request:SourceUpload,response:SourceReference },
  packs:{ method:'GET',path:'/v1/packs' },
  submit:{ method:'POST',path:'/v1/tasks/submit',request:SubmitRequest,response:SubmittedTask },
  tasks:{ method:'GET',path:'/v1/tasks',query:z.union([TaskPageQuery,TaskListQuery.extend({view:z.undefined().optional()})]),response:z.union([z.array(TaskView),RegistryPage]) },
  approvals:{ method:'GET',path:'/v1/tasks/{taskId}/approvals',pageQuery:RegistryPageQuery,response:z.union([z.array(ApprovalView),RegistryPage]) },
  adminApprovals:{method:'GET',path:'/v1/admin/approvals',pageQuery:RegistryPageQuery,pageResponse:RegistryPage},
  scopes:{method:'GET',path:'/v1/scopes',pageQuery:RegistryPageQuery,pageResponse:RegistryPage},
  scopeRoles:{method:'GET',path:'/v1/scopes/{scopeId}/roles'},
  scopeRoleSubmit:{method:'POST',path:'/v1/scopes/{scopeId}/roles',request:ScopeRolePatch},
  scopePolicySubmit:{method:'POST',path:'/v1/scopes/{scopeId}/policy',request:ScopePolicyPatch},
  changeSetSubmit:{method:'POST',path:'/v1/change-sets',request:ChangeSetSubmission},
  changeSets:{method:'GET',path:'/v1/change-sets',pageQuery:RegistryPageQuery,pageResponse:RegistryPage},
  changeSet:{method:'GET',path:'/v1/change-sets/{changeSetId}'},
  runtimeProfiles:{method:'GET',path:'/v1/runtime-profiles'},
  objectTypes:{method:'GET',path:'/v1/object-types',pageQuery:RegistryPageQuery,pageResponse:RegistryPage},
  assets:{method:'GET',path:'/v1/assets',query:z.union([AssetPageQuery,AssetListQuery.extend({view:z.undefined().optional()})]),pageResponse:RegistryPage},
  assetSubmit:{method:'POST',path:'/v1/assets',request:AssetRegistration},
  asset:{method:'GET',path:'/v1/assets/{assetId}'},
  assetLifecycle:{method:'POST',path:'/v1/assets/{assetId}/lifecycle',request:AssetTransition},
  serviceClients:{method:'POST',path:'/v1/service-clients',request:ServiceClientRegistration},
  serviceClientList:{method:'GET',path:'/v1/service-clients',pageQuery:RegistryPageQuery,pageResponse:RegistryPage},
  serviceClient:{method:'GET',path:'/v1/service-clients/{clientId}'},
  serviceClientRotate:{method:'POST',path:'/v1/service-clients/{clientId}/rotate',request:ServiceClientRotation},
  serviceClientRevoke:{method:'POST',path:'/v1/service-clients/{clientId}/revoke',request:z.object({}).strict()},
  serviceToken:{method:'POST',path:'/token',contentType:'application/x-www-form-urlencoded'},
  introspect:{method:'POST',path:'/v1/introspect',contentType:'application/x-www-form-urlencoded'},
  sourceBundle:{method:'GET',path:'/v1/builds/{build}/bundle'},
  sourceBlob:{method:'GET',path:'/v1/blobs/{sha}'},
  sourceArtifactSubmit:{method:'POST',path:'/v1/source-artifacts',request:SourceArtifactRegistration,response:SourceArtifactView},
  sourceArtifact:{method:'GET',path:'/v1/source-artifacts/{assetId}',response:SourceArtifactView},
  oauthDevice:{method:'POST',path:'/v1/credentials/oauth/device',request:OAuthGrantInput},
  oauthPoll:{method:'POST',path:'/v1/credentials/oauth/device/{flowId}/poll',request:z.object({}).strict()},
  oauthClientCredentials:{method:'POST',path:'/v1/credentials/oauth/client-credentials',request:OAuthGrantInput},
  tools:{method:'GET',path:'/v1/tools',pageQuery:RegistryPageQuery,response:z.union([z.array(ToolView),RegistryPage])},
  toolCall:{method:'POST',path:'/v1/tools/{name}/call',request:ToolCallInput,response:ToolCallResult},
  skillCandidate:{method:'GET',path:'/v1/skillpacks/{id}'},
  skillpacks:{method:'GET',path:'/v1/skillpacks',pageQuery:RegistryPageQuery,response:z.union([z.array(SkillPackView),RegistryPage])},
  skillpackSubmit:{method:'POST',path:'/v1/skillpacks',request:SkillPackSubmission,response:SkillPackView,scopeHeader:'X-Scope-Id'},
  skillpackRun:{method:'POST',path:'/v1/skillpacks/{id}/runs',request:SkillRunInput,response:z.object({taskId:TaskId})},
  moduleInstall:{method:'POST',path:'/v1/modules/install',request:ModuleInstallRequest,scopeHeader:'X-Scope-Id'},
  trigger:{method:'POST',path:'/v1/automations/triggers',request:TriggerRegistration},
  bot:{method:'POST',path:'/v1/automations/bots',request:BotRegistration},
  botRuns:{method:'GET',path:'/v1/automations/bots/{assetId}/runs',pageQuery:RegistryPageQuery,pageResponse:RegistryPage},
  connectorEvent:{method:'POST',path:'/v1/connectors/{assetId}/events',request:ConnectorEventInput},
  objects:{method:'GET',path:'/v1/objects',query:z.union([RegistryPageQuery.safeExtend({typeId:PackageName.optional(),system:PackageName.optional()}),ObjectListQuery.extend({view:z.undefined().optional()})]),response:z.union([ObjectPage,RegistryPage])},
  object:{method:'GET',path:'/v1/objects/{entityId}',response:EntityView},
  objectObservations:{method:'GET',path:'/v1/objects/{entityId}/observations'},
  objectRelations:{method:'GET',path:'/v1/objects/{entityId}/relations'},
  status:{ method:'GET',path:'/v1/tasks/{taskId}/status',response:TaskView },
  events:{ method:'GET',path:'/v1/tasks/{taskId}/events?after={seq}',response:EventPage },
  eventContent:{method:'GET',path:'/v1/tasks/{taskId}/events/{seq}/content',mediaType:'application/json',sha256Header:'x-content-sha256'},
  result:{ method:'GET',path:'/v1/tasks/{taskId}/result',response:TaskResult },
  input:{ method:'POST',path:'/v1/tasks/{taskId}/input',request:InputRequest,response:TaskView },
  sourceContent:{ method:'GET',path:'/v1/sources/{sourceRevisionId}/content' },
  sourceList:{method:'GET',path:'/v1/sources',query:RegistryPageQuery,response:RegistryPage},
  evidence:{method:'GET',path:'/v1/evidence',query:RegistryPageQuery,response:RegistryPage},
  artifacts:{method:'GET',path:'/v1/artifacts',query:RegistryPageQuery,response:RegistryPage},
  artifactContent:{ method:'GET',path:'/v1/artifacts/{artifactId}/content' },
} as const;
