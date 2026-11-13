// Deployment input reuses the domain schemas; registration is owned by contracts.
import { z } from 'zod';
import { PermissionRoleSchema } from '../generated/vocabulary.ts';
import { PackId, UserId, TeamId } from './common.ts';
import { ExecutorSource, ResourceId, ResourceRecord, ExactPackRef } from './resources.ts';
import { SecretReference, VariableName } from './variables.ts';

const name = z.string().min(1).max(200);
export const DeploymentResource = z.strictObject({
  id: ResourceId.optional(),
  definition: z.strictObject({
    system_pack: ExactPackRef,
    name: ResourceRecord.shape.name,
    environment: ResourceRecord.shape.environment,
    origins: ResourceRecord.shape.origins,
    allow_plaintext: ResourceRecord.shape.allow_plaintext.default([]),
    credentials: z.record(z.string(), VariableName).default({}),
    settings: ResourceRecord.shape.settings.default({}),
    limits: ResourceRecord.shape.limits,
  }),
  enabled: z.boolean().default(true),
});
export const DeploymentDefinition = z.strictObject({
  schema: z.literal('deployment@1'),
  accounts: z.array(z.strictObject({ id: UserId.optional(), name, role: PermissionRoleSchema, disabled: z.boolean().default(false) })).default([]),
  teams: z.array(z.strictObject({ id: TeamId.optional(), name, members: z.array(name).default([]) })).default([]),
  packs: z.array(z.strictObject({ ref: ExactPackRef, directory: name.optional(), install: z.boolean().default(false), dependsOn: z.array(ExactPackRef).default([]) })).default([]),
  resources: z.array(DeploymentResource).default([]),
  executors: z.array(ExecutorSource).default([]),
  workflowAssignments: z.array(z.union([
    z.strictObject({ pack: PackId, user: name }),
    z.strictObject({ pack: PackId, team: name }),
  ])).default([]),
  resourceAssignments: z.array(z.union([
    z.strictObject({ resource: name, team: name }),
    z.strictObject({ resource: name, all: z.literal(true) }),
  ])).default([]),
  knowledgeSources: z.array(PackId).default([]),
}).superRefine((value, ctx) => {
  for (const key of ['accounts', 'teams'] as const) {
    const names = value[key].map(row => row.name);
    if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', path: [key], message: '名字重复' });
  }
  const resourceNames = value.resources.map(row => row.definition.name);
  if (new Set(resourceNames).size !== resourceNames.length) ctx.addIssue({ code: 'custom', path: ['resources'], message: '资源名字重复' });
  const targets = value.executors.map(row => row.target);
  if (new Set(targets).size !== targets.length) ctx.addIssue({ code: 'custom', path: ['executors'], message: '执行器目标重复' });
  for (const executor of value.executors) {
    if (executor.credential !== undefined && !SecretReference.safeParse(executor.credential).success)
      ctx.addIssue({ code: 'custom', path: ['executors'], message: '凭据只能引用命名密钥' });
  }
});
export type DeploymentDefinition = z.infer<typeof DeploymentDefinition>;

/** Private maintenance envelope. Its payload is validated by the records owner, never by the public deployment parser. */
export const ProtectedConfigurationEnvelope = z.strictObject({
  schema: z.literal('protected-deployment@1'),
  createdAt: z.iso.datetime(),
  payloadSha256: z.string().regex(/^[0-9a-f]{64}$/),
  payload: z.unknown().refine(value => value !== undefined, 'protected configuration payload is required'),
});
export const ProtectedConfigurationReceipt = z.strictObject({
  file: z.string().regex(/^private-config-snapshots\/[0-9a-f-]{36}\.json$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type ProtectedConfigurationReceipt = z.infer<typeof ProtectedConfigurationReceipt>;
