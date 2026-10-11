import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const API_VERSION = '1.0.0';
export const FLOW_VERSION = 'synthetic-lbx/1';
export const MINDMAP_FLOW_VERSION = 'mindmap-compile/1';
export const PACK_FLOWS={'mindmap-compile':MINDMAP_FLOW_VERSION,'defect-review':'defect-review/1','lbx-healthcheck':'lbx-healthcheck/1'} as const;
export const LEASE_TTL_MS = 60_000;
export const HEARTBEAT_MS = 20_000;
export const IDEMPOTENCY_WINDOW_MS = 86_400_000;
export const MAX_BODY_BYTES = 65_536;
export const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
export const MAX_WORKER_REPORT_BYTES = 32 * 1024 * 1024;
export const MINDMAP_CONTRACT_VERSION = 'Excel 输出契约 V1';
export const MINDMAP_MAPPING_VERSION = '1.0.0';
export const MINDMAP_PACK_VERSION = '1.0.0';

const identity = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9][A-Za-z0-9_-]*$`));
export const TaskId = identity('task');
export const InputRevisionId = identity('inrev');
export const OperationId = identity('op');
export const ScopeId = identity('scp');
export const SourceRevisionId = identity('src');
export const ArtifactId = identity('art');
export const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const Base64Content = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/).refine(value =>
  value.length % 4 === 0 && Buffer.from(value,'base64').toString('base64') === value,'Expected canonical standard base64');
export function newId(prefix: 'task' | 'inrev' | 'op' | 'pin' | 'src' | 'snap' | 'evd' | 'art' | 'rule' | 'audit' | 'rec'): string {
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

export const STANDARD_OPERATIONS = {
  'product.version': { reads: ['device-state'], writes: [] },
  'product.config.read': { reads: ['device-state'], writes: [] },
  'product.config.write': { reads: ['device-state'], writes: ['device-config'] },
  'defects.search': { reads: ['external-system'], writes: [] },
  'defects.comment': { reads: ['external-system'], writes: ['external-system'] },
  'docs.fetch': { reads: ['knowledge'], writes: [] },
  'docs.convert': { reads: ['knowledge'], writes: ['artifacts-evidence'] },
  'mindmaps.compile': { reads: ['knowledge'], writes: ['artifacts-evidence'] },
} as const;
export const StandardOperation = z.enum(Object.keys(STANDARD_OPERATIONS) as [keyof typeof STANDARD_OPERATIONS, ...Array<keyof typeof STANDARD_OPERATIONS>]);
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
    if (canonicalHash(operation.effects) !== canonicalHash(STANDARD_OPERATIONS[operation.name]) || seen.has(operation.name)) {
      context.addIssue({ code: 'custom', path: ['operations', index], message: 'Operation effect declaration or identity is inconsistent' });
    }
    if (operation.effects.writes.length && operation.idempotency === 'none') {
      context.addIssue({ code: 'custom', path: ['operations', index], message: 'Writes require a declared idempotency strategy' });
    }
    seen.add(operation.name);
  }
});
export type ConnectorManifest = z.infer<typeof ConnectorManifest>;

export const SubmitRequest = z.object({ scopeId: ScopeId, title: z.string().min(1).max(2000).default('Compile mindmap test cases'),
  idempotencyKey: z.string().min(8).max(200), capabilityPackId: z.enum(['mindmap-compile','defect-review','lbx-healthcheck']).optional(),
  input: z.record(z.string(), z.unknown()).default({}) });
export type SubmitRequest = z.infer<typeof SubmitRequest>;
export const DevLoginRequest = z.object({ username: z.string().max(100), password: z.string().max(1000),
  expiresInMs: z.number().int().positive().optional() });
export const DevLoginResult = z.object({ token: z.string(), tokenType: z.literal('Bearer'), expiresAt: z.string(),
  principalId: z.string(), tenantId: z.string(), scopes: z.array(ScopeId) });
export const SourceUpload = z.object({ scopeId: ScopeId, fileName: z.string().min(1).max(240), contentBase64: Base64Content });
export const SourceReference = z.object({ sourceRevisionId: SourceRevisionId, sha256: Sha256, size: z.number().int().nonnegative(), fileName: z.string(), scopeId: ScopeId });
export const MindmapCompileInput = z.object({ sourceRevisionId: SourceRevisionId, sourceSha256: Sha256.optional() });
export const ArtifactReference = z.object({ artifactId: ArtifactId, sha256: Sha256, size: z.number().int().positive(),
  fileName: z.string(), mediaType: z.enum(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/json','text/plain']),
  downloadPath: z.string() });
export const UnmappedElement = z.object({ path: z.string(), reason: z.string() });
export type UnmappedElement = z.infer<typeof UnmappedElement>;
export const MindmapPack = {
  capabilityPackId: 'mindmap-compile', version: MINDMAP_PACK_VERSION,
  title: '脑图用例结构编译', inputFormats: ['xmind-2020-content-json', 'xmind-content-json', 'topic-tree-json'],
  contractVersion: MINDMAP_CONTRACT_VERSION, mappingRulesVersion: MINDMAP_MAPPING_VERSION,
  requiredOperations: ['mindmaps.compile'], conclusionScope: 'structural-compilation',
  inputSchema: { type: 'object', required: ['sourceRevisionId'], properties: {
    sourceRevisionId: { type: 'string', pattern: '^src_' }, sourceSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, additionalProperties: false },
} as const;
export const DefectReviewPack={capabilityPackId:'defect-review',version:'1.0.0',title:'合成缺陷核对与回写',
  requiredOperations:['defects.search','defects.comment','docs.fetch','docs.convert','product.version'],conclusionScope:'synthetic-defect-review'} as const;
export const LbxPack={capabilityPackId:'lbx-healthcheck',version:'1.0.0',title:'合成 LBX 健康检查',
  requiredOperations:['product.version','product.config.read','product.config.write','docs.fetch'],conclusionScope:'synthetic-configuration-verification'} as const;
export const RuleRequest=z.object({scopeId:ScopeId,capabilityPackId:z.literal('defect-review'),servicePrincipalId:z.string().regex(/^prn_/),
  bindings:z.object({defects:z.string(),documents:z.string(),product:z.string()}),intervalMs:z.number().int().min(100).max(60_000).default(1000),simulateCommentTimeout:z.boolean().default(false)});
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
  approvalId: z.string().optional() });
export type OperationRequest = z.infer<typeof OperationRequest>;
export const ApprovalProposal = OperationRequest.omit({idempotencyKey:true,deadlineMs:true,approvalId:true});
export const ConclusionRequest=z.object({inputRevisionId:InputRevisionId,kind:ConclusionKind,methodId:z.literal('lbx-healthcheck').optional(),
  evidenceIds:z.array(z.string().regex(/^evd_/)).max(16).default([]),judgment:z.enum(['supports','refutes','abstained']).default('abstained'),rationale:z.string().max(2000).default('')});
export const ChecklistPredicate=z.enum(['assessment-completed','configuration-conforms','professional-opinion','defect-reviewed','comment-reconciled','documents-converted']);
export const ChecklistRequest=z.object({inputRevisionId:InputRevisionId,items:z.array(z.object({itemId:z.string().min(1).max(100),requiresFact:z.boolean(),required:z.boolean(),predicate:ChecklistPredicate})).min(1).max(30)});
export const ChecklistResponse=z.object({inputRevisionId:InputRevisionId,conclusionId:z.string().regex(/^rec_/)});
export const actionDigest = (value: Pick<OperationRequest, 'inputRevisionId' | 'name' | 'target' | 'targetIdentity' | 'args'>): string => canonicalHash({
  inputRevisionId: value.inputRevisionId, name: value.name, target: value.target,
  targetIdentity: value.targetIdentity, args: value.args,
});
export const Event = z.object({ seq: z.number().int().positive(), taskId: TaskId, kind: z.string(),
  payload: z.record(z.string(), z.unknown()), createdAt: z.string() });
export type Event = z.infer<typeof Event>;

const registry = {
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
  INVALID_MINDMAP: [422, 'validation'], UNSUPPORTED_MINDMAP: [422, 'validation'],
  ARTIFACT_VERIFICATION_FAILED: [409, 'semantic-insufficient'], SOURCE_HASH_MISMATCH: [409, 'conflict-stale'],
} as const;
export type ErrorCode = keyof typeof registry;
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly category: string;
  readonly details: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message); this.code = code; this.httpStatus = registry[code][0]; this.category = registry[code][1]; this.details = details;
  }
}
export function requireCondition(condition: unknown, code: ErrorCode, message: string): asserts condition {
  if (!condition) throw new ApiError(code, message);
}

export interface AuthContext { principalId: string; tenantId: string; kind: 'user' | 'service' | 'worker'; workerId?: string }
export interface Policy extends AuthContext { scopes: string[]; grants: string[]; targets: string[]; defects: string[] }
export interface Task {
  taskId: string; tenantId: string; scopeId: string; principalId: string; title: string; phase: TaskPhase;
  inputRevisionId: string; input: Record<string, unknown>; revision: number; flowVersion: string;
  capabilityPackId?: string; packVersion?: string;
}
export const WorkerClaim = z.object({ operationId: OperationId, taskId: TaskId, inputRevisionId: InputRevisionId,
  name: z.literal('mindmaps.compile'), fencingToken: z.number().int().positive(), source: SourceReference,
  leaseTtlMs: z.literal(60_000), heartbeatMs: z.literal(20_000) });
export const ExecutionClaim = z.object({ operationId:OperationId,taskId:TaskId,inputRevisionId:InputRevisionId,
  name:StandardOperation,kind:z.enum(['execute','reconcile']),target:z.string(),targetIdentity:z.string(),
  args:z.record(z.string(),z.unknown()),actionDigest:Sha256,parentOperationId:OperationId.optional(),
  fencingToken:z.number().int().positive(),leaseTtlMs:z.literal(60_000),heartbeatMs:z.literal(20_000) });
export const AnyWorkerClaim = z.union([WorkerClaim,ExecutionClaim]);
export const ExecutionReport = z.object({ fencingToken:z.number().int().positive(),inputRevisionId:InputRevisionId,
  status:z.enum(['succeeded','failed','unknown']),output:z.record(z.string(),z.unknown()).default({}),
  error:z.object({ code:z.string(),message:z.string().max(1000) }).optional() });
export const WorkerReport = z.object({ fencingToken: z.number().int().positive(), inputRevisionId: InputRevisionId,
  status: z.enum(['succeeded','partial','failed']), artifactBase64: Base64Content.optional(),
  error: z.object({ code: z.enum(['INVALID_MINDMAP','UNSUPPORTED_MINDMAP','ARTIFACT_VERIFICATION_FAILED','INTERNAL_ERROR']), message: z.string().max(1000) }).optional(),
}).refine(value => value.status === 'failed' ? !!value.error && !value.artifactBase64 : !!value.artifactBase64 && !value.error,
  'Provide an artifact for completion or an error for failure');
export const TaskResult = z.object({ taskId: TaskId, inputRevisionId: InputRevisionId, phase: TaskPhase,
  capabilityPackId: z.string().optional(), status: z.enum(['accepted','running','succeeded','partial','failed','unknown','cancel-requested','cancelled']),
  artifacts: z.array(ArtifactReference), evidence: z.array(z.object({ evidenceId: z.string(), kind: ConclusionKind,
    sha256: Sha256, size: z.number(), downloadPath: z.string() })), unmapped: z.array(UnmappedElement),
  verification: z.object({ reader: z.string(), rowCount: z.number().int().nonnegative(), sourceSha256: Sha256,
    irSha256: Sha256, artifactSha256: Sha256 }).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export const TaskView = z.object({ taskId: TaskId,tenantId:z.string(),scopeId:ScopeId,principalId:z.string(),title:z.string(),
  phase:TaskPhase,inputRevisionId:InputRevisionId,input:z.record(z.string(),z.unknown()),revision:z.number().int().positive(),
  flowVersion:z.string(),capabilityPackId:z.string().optional(),packVersion:z.string().optional(),
  pendingInputs:z.array(z.object({ requestId:z.string(),inputRevisionId:InputRevisionId,kind:z.string(),question:z.string(),
    binding:z.record(z.string(),z.unknown()),expiresAt:z.string(),status:z.string() })).optional(),
});
export const SubmittedTask = TaskView.extend({ deduplicated:z.boolean() });
export const EventPage = z.object({ events:z.array(Event),after:z.number().int().nonnegative() });
export const CLIENT_ROUTES = {
  devLogin:{ method:'POST',path:'/v1/auth/dev-login',request:DevLoginRequest,response:DevLoginResult },
  sources:{ method:'POST',path:'/v1/sources',request:SourceUpload,response:SourceReference },
  packs:{ method:'GET',path:'/v1/packs' },
  submit:{ method:'POST',path:'/v1/tasks/submit',request:SubmitRequest,response:SubmittedTask },
  status:{ method:'GET',path:'/v1/tasks/{taskId}/status',response:TaskView },
  events:{ method:'GET',path:'/v1/tasks/{taskId}/events?after={seq}',response:EventPage },
  result:{ method:'GET',path:'/v1/tasks/{taskId}/result',response:TaskResult },
  input:{ method:'POST',path:'/v1/tasks/{taskId}/input',request:InputRequest,response:TaskView },
  sourceContent:{ method:'GET',path:'/v1/sources/{sourceRevisionId}/content' },
  artifactContent:{ method:'GET',path:'/v1/artifacts/{artifactId}/content' },
} as const;
