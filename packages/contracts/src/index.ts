import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const API_VERSION = '1.0.0';
export const FLOW_VERSION = 'synthetic-lbx/1';
export const LEASE_TTL_MS = 60_000;
export const HEARTBEAT_MS = 20_000;
export const IDEMPOTENCY_WINDOW_MS = 86_400_000;
export const MAX_BODY_BYTES = 65_536;

const identity = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9][A-Za-z0-9_-]*$`));
export const TaskId = identity('task');
export const InputRevisionId = identity('inrev');
export const OperationId = identity('op');
export const ScopeId = identity('scp');
export const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export function newId(prefix: 'task' | 'inrev' | 'op' | 'pin' | 'src' | 'snap' | 'evd' | 'art' | 'rule' | 'audit'): string {
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

export const SubmitRequest = z.object({ scopeId: ScopeId, title: z.string().min(1).max(2000),
  idempotencyKey: z.string().min(8).max(200), input: z.record(z.string(), z.unknown()).default({}) });
export type SubmitRequest = z.infer<typeof SubmitRequest>;
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
}
