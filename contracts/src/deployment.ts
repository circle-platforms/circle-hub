// Deployment input reuses the domain schemas; registration is owned by contracts.
import { z } from 'zod';
import { PermissionRoleSchema } from '../generated/vocabulary.ts';
import { PackId, UserId, TeamId, IsoTime, Sha256, idOf } from './common.ts';
import { ExecutorSource, ResourceId, ResourceRecord, ExactPackRef, TestEnvironmentId, TestEnvironmentPrefix, TestEnvironmentResource } from './resources.ts';
import { SecretReference, VariableName, VariableRecord } from './variables.ts';

import { ProductId, BuildInfo } from './product.ts';

export const DeploymentSyncTarget = z.strictObject({
  product: ProductId,
  line: BuildInfo.shape.line.nullable(),
});
export type DeploymentSyncTarget = z.infer<typeof DeploymentSyncTarget>;
export const DeploymentSyncTargets = z.array(DeploymentSyncTarget).max(100).refine(targets => new Set(targets.map(target => JSON.stringify([target.product, target.line]))).size === targets.length, 'product and version line pairs are unique');
export const DEPLOYMENT_SYNC_CONFIGURATION_KEY = 'deployment-sync';
export const DEPLOYMENT_SYNC_INTENT_SCHEMA = 'deployment-sync-intent@1';
export const DeploymentSyncIntent = z.strictObject({ schema: z.literal(DEPLOYMENT_SYNC_INTENT_SCHEMA), targets: DeploymentSyncTargets });
export type DeploymentSyncIntent = z.infer<typeof DeploymentSyncIntent>;

export const DeploymentVariable = VariableRecord;
export const DeploymentDocument = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  sha256: Sha256,
  size: z.number().int().nonnegative().max(2 * 1024 * 1024),
  bytesBase64: z.string().max(4 * Math.ceil(2 * 1024 * 1024 / 3)).regex(/^[A-Za-z0-9+/]*={0,2}$/).refine(value => value.length % 4 === 0, 'base64 length is divisible by four'),
  mediaType: z.string().min(1).max(200),
  fileName: z.string().min(1).max(300),
});

export const ExecutorStableName = z.string().min(1).max(200)
  .refine(value => value === value.trim() && !/\p{Cc}/u.test(value), '名字不能含首尾空白或控制字符')
  .refine(value => ![UserId, TeamId, ResourceId, TestEnvironmentId, idOf('exe')].some(schema => schema.safeParse(value).success), '名字不能使用内部编号');
export const EXECUTOR_NAME_PREFIX = 'executor-name.';
export const ExecutorNameBinding = z.strictObject({ schema: z.literal('executor-name@1'), executor: idOf('exe'), name: ExecutorStableName });
export type ExecutorNameBinding = z.infer<typeof ExecutorNameBinding>;

const name = ExecutorStableName;
export const DEPLOYMENT_SCHEMA = 'deployment@3';
/** A confirmed owner-held booking namespace, not a test environment or an environment assignment. */
export const BookingPrefix = z.strictObject({ prefix: TestEnvironmentPrefix.shape.prefix, owner: name });
export type BookingPrefix = z.infer<typeof BookingPrefix>;
/** Public exports require complete names and targets; unknown canonical registrations must be reported, never guessed or omitted. */
export const DeploymentTestEnvironment = z.strictObject({
  name, target: z.string().min(1).max(200),
  prefixes: z.array(TestEnvironmentPrefix.pick({ prefix: true, owner: true }).safeExtend({ owner: name })).default([]),
  resources: z.array(TestEnvironmentResource.pick({ key: true, owner: true }).safeExtend({ owner: name })).default([]),
  executors: z.array(name).default([]), enabled: z.boolean().default(true),
}).superRefine((value, ctx) => {
  if (!value.prefixes.length && !value.resources.length) ctx.addIssue({ code: 'custom', path: ['prefixes'], message: '测试环境须声明前缀或精确资源键' });
  for (const [field, values] of [['prefixes', value.prefixes.map(row => row.prefix)], ['resources', value.resources.map(row => row.key)], ['executors', value.executors]] as const)
    if (new Set(values).size !== values.length) ctx.addIssue({ code: 'custom', path: [field], message: '测试环境登记项重复' });
});
export type DeploymentTestEnvironment = z.infer<typeof DeploymentTestEnvironment>;
export const DeploymentEnvironmentAssignment = z.union([
  z.strictObject({ environment: name, user: name, expiresAt: IsoTime.nullable().default(null) }),
  z.strictObject({ environment: name, team: name, expiresAt: IsoTime.nullable().default(null) }),
  z.strictObject({ environment: name, all: z.literal(true), expiresAt: IsoTime.nullable().default(null) }),
]);
export type DeploymentEnvironmentAssignment = z.infer<typeof DeploymentEnvironmentAssignment>;
export const DeploymentExecutor = z.strictObject({name,definition:ExecutorSource.safeExtend({id:z.never().optional()})});
export const DeploymentResource = z.strictObject({
  definition: z.strictObject({
    system_pack: ExactPackRef,
    name,
    environment: ResourceRecord.shape.environment,
    origins: ResourceRecord.shape.origins,
    allow_plaintext: ResourceRecord.shape.allow_plaintext.default([]),
    credentials: z.record(z.string(), SecretReference).default({}),
    settings: ResourceRecord.shape.settings.default({}),
    limits: ResourceRecord.shape.limits,
  }),
  enabled: z.boolean().default(true),
});
export const DeploymentDefinition = z.strictObject({
  schema: z.literal(DEPLOYMENT_SCHEMA),
  accounts: z.array(z.strictObject({ name, role: PermissionRoleSchema, disabled: z.boolean().default(false) })).default([]),
  teams: z.array(z.strictObject({ name, members: z.array(name).default([]) })).default([]),
  packs: z.array(z.strictObject({ ref: ExactPackRef, directory: name.optional(), install: z.boolean().default(false), dependsOn: z.array(ExactPackRef).default([]) })).default([]),
  resources: z.array(DeploymentResource).default([]),
  executors: z.array(DeploymentExecutor).default([]),
  testEnvironments: z.array(DeploymentTestEnvironment).default([]),
  environmentAssignments: z.array(DeploymentEnvironmentAssignment).default([]),
  bookingPrefixes: z.array(BookingPrefix).default([]),
  workflowAssignments: z.array(z.union([
    z.strictObject({ pack: PackId, user: name }),
    z.strictObject({ pack: PackId, team: name }),
  ])).default([]),
  resourceAssignments: z.array(z.union([
    z.strictObject({ resource: name, team: name }),
    z.strictObject({ resource: name, all: z.literal(true) }),
  ])).default([]),
  knowledgeSources: z.array(PackId).default([]),
  knowledgeSync: DeploymentSyncTargets.optional(),
  variables: z.array(DeploymentVariable).default([]),
  documents: z.array(DeploymentDocument).default([]),
  missingConfiguration: z.array(z.string().min(1)).default([]),
}).superRefine((value, ctx) => {
  for (const key of ['accounts', 'teams', 'variables', 'documents', 'testEnvironments'] as const) {
    const names = value[key].map(row => row.name);
    if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', path: [key], message: '名字重复' });
  }
  const targets = value.testEnvironments.map(row => row.target);
  const bookingPrefixes = value.bookingPrefixes.map(row => row.prefix);
  if (new Set(bookingPrefixes).size !== bookingPrefixes.length) ctx.addIssue({ code: 'custom', path: ['bookingPrefixes'], message: '预订前缀重复' });
  if (new Set(targets).size !== targets.length) ctx.addIssue({ code: 'custom', path: ['testEnvironments'], message: '同一目标只能登记一个测试环境，多个执行器应关联到同一环境' });
  const recipients = value.environmentAssignments.map(row => JSON.stringify([row.environment, 'user' in row ? ['user', row.user] : 'team' in row ? ['team', row.team] : ['all']]));
  if (new Set(recipients).size !== recipients.length) ctx.addIssue({ code: 'custom', path: ['environmentAssignments'], message: '测试环境的受众分配重复' });
  const resourceNames = value.resources.map(row => row.definition.name);
  if (new Set(resourceNames).size !== resourceNames.length) ctx.addIssue({ code: 'custom', path: ['resources'], message: '资源名字重复' });
  const executorNames=value.executors.map(row=>row.name);
  if(new Set(executorNames).size!==executorNames.length)ctx.addIssue({code:'custom',path:['executors'],message:'执行器名字重复'});
  for (const executor of value.executors) {
    if (executor.definition.credential !== undefined && !SecretReference.safeParse(executor.definition.credential).success)
      ctx.addIssue({ code: 'custom', path: ['executors'], message: '凭据只能引用命名密钥' });
  }
});
export type DeploymentDefinition = z.infer<typeof DeploymentDefinition>;

/** Private maintenance envelope. Its payload is validated by the records owner, never by the public deployment parser. */
export const ProtectedConfigurationEnvelope = z.strictObject({
  schema: z.literal('protected-deployment@1'),
  createdAt: IsoTime,
  payloadSha256: Sha256,
  payload: z.unknown().refine(value => value !== undefined, 'protected configuration payload is required'),
});
export type ProtectedConfigurationEnvelope = z.infer<typeof ProtectedConfigurationEnvelope>;
export const ProtectedConfigurationReceipt = z.strictObject({
  file: z.string().regex(/^private-config-snapshots\/[0-9a-f-]{36}\.json$/),
  sha256: Sha256,
  bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type ProtectedConfigurationReceipt = z.infer<typeof ProtectedConfigurationReceipt>;

export const schemas: Record<string, z.ZodType> = {
  [DEPLOYMENT_SCHEMA]: DeploymentDefinition,
  'executor-name@1': ExecutorNameBinding,
  [DEPLOYMENT_SYNC_INTENT_SCHEMA]: DeploymentSyncIntent,
  'protected-deployment@1': ProtectedConfigurationEnvelope,
};
