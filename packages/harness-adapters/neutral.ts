import { z } from 'zod';

// Neutral manifests: what the hub stores for each governed harness primitive.
// Fields follow docs/design/harness-primitives.md section 二; fields the spec
// names without a shape use the minimal shape recorded in the brief's 待定
// section. Manifests never carry endpoints, secrets, environment variable
// values, or absolute paths; harness-specific data survives in
// `harnessSpecific` with secret values stripped.

export const HARNESS_IDS = ['claude-code', 'codex'] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

// The adapter boundary is a virtual file table: the hub hands bytes in at
// import and receives bytes back at export.
export type VirtualFiles = Record<string, string | Uint8Array>;

export const WARNING_CODES = [
  'FRONTMATTER_UNCLOSED',
  'FRONTMATTER_LINE_SKIPPED',
  'NAME_DERIVED_FROM_PATH',
  'HOOK_EVENT_UNMAPPED',
  'HOOK_ENTRY_SKIPPED',
  'CONFIG_EXTRA_KEYS',
  'CONFIG_JSON_INVALID',
  'PROVIDER_VALUES_STRIPPED',
  'PROVIDER_CWD_DROPPED',
  'PROVIDER_ENTRY_INVALID',
  'HOOK_COMMAND_PATH',
  'SECRET_PLACEHOLDER',
  'SOURCE_FILE_MISSING',
  'PROVIDER_COMMAND_ABSOLUTE',
  'PROVIDER_ARG_REDACTED',
  'PROVIDER_TRANSPORT_UNKNOWN',
  'PROVIDER_SHAPE_UNKNOWN',
  'CANONICAL_NORMALIZATION',
  'UNRECOGNIZED_FILE',
  'CROSS_HARNESS_EXPORT',
  'NO_HARNESS_PROJECTION',
  'MANIFEST_INVALID',
  'TOML_LINE_SKIPPED',
] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

export interface AdapterWarning {
  code: WarningCode;
  path: string;
  detail: string;
}

export interface ImportResult {
  manifests: HubManifest[];
  warnings: AdapterWarning[];
}

export interface ExportResult {
  files: VirtualFiles;
  warnings: AdapterWarning[];
}

export const TRANSPORTS = ['stdio', 'streamable-http'] as const;
export type Transport = (typeof TRANSPORTS)[number];

export const CREDENTIAL_MODES = ['static', 'platform-issued', 'external-oauth'] as const;
export type CredentialMode = (typeof CREDENTIAL_MODES)[number];

export const HOOK_LANGUAGES = ['ts', 'shell'] as const;
export type HookLanguage = (typeof HOOK_LANGUAGES)[number];

const harnessSpecific = z.record(z.string(), z.unknown()).default({});
// Every manifest points at the files it was derived from; bytes stay out of
// the manifest and are frozen by the hub on the asset side.
const manifestFiles = z
  .array(z.looseObject({ path: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }))
  .default([]);
const base = {
  sourceHarness: z.string().min(1),
  knownCompatible: z.array(z.string()).default([]),
  files: manifestFiles,
  harnessSpecific,
};

// Schemas are loose (pass-through) so export-time validation never drops
// fields a newer hub added to a stored manifest.

export const hubSkillSchema = z.looseObject({
  kind: z.literal('hub-skill/1'),
  name: z.string().min(1),
  description: z.string().default(''),
  version: z.string().optional(),
  entry: z.string().min(1),
  tools: z.array(z.string()).default([]),
  inputs: z.array(z.string()).default([]),
  outputs: z.array(z.string()).default([]),
  triggers: z.array(z.string()).default([]),
  model: z.string().optional(),
  ...base,
});
export type HubSkill = z.infer<typeof hubSkillSchema>;

// hub-tool/1 does not exist as a standalone manifest: the spec keeps tools
// inside the provider's `provides`, not in a separate kind.

export const hubProviderSchema = z.looseObject({
  kind: z.literal('hub-provider/1'),
  name: z.string().min(1),
  transport: z.enum(TRANSPORTS).optional(),
  provides: z
    .looseObject({
      tools: z.array(z.string()).default([]),
      resources: z.array(z.string()).default([]),
      prompts: z.array(z.string()).default([]),
    })
    .optional(),
  reads: z.array(z.string()).default([]),
  writes: z.array(z.string()).default([]),
  credentials: z.array(z.string()).default([]),
  credentialMode: z.enum(CREDENTIAL_MODES).optional(),
  ...base,
});
export type HubProvider = z.infer<typeof hubProviderSchema>;

export const hubHookSchema = z.looseObject({
  kind: z.literal('hub-hook/1'),
  event: z.string().min(1),
  order: z.number().int().nonnegative().optional(),
  handler: z.string().min(1),
  language: z.enum(HOOK_LANGUAGES),
  deterministic: z.boolean().optional(),
  ...base,
});
export type HubHook = z.infer<typeof hubHookSchema>;

export const hubInstructionSchema = z.looseObject({
  kind: z.literal('hub-instruction/1'),
  scope: z.string().min(1).optional(),
  applies: z.array(z.string()).default([]),
  fileName: z.string().min(1),
  ...base,
});
export type HubInstruction = z.infer<typeof hubInstructionSchema>;

export const hubAgentSchema = z.looseObject({
  kind: z.literal('hub-agent/1'),
  name: z.string().min(1),
  description: z.string().default(''),
  tools: z.array(z.string()).default([]),
  model: z.string().optional(),
  ...base,
});
export type HubAgent = z.infer<typeof hubAgentSchema>;

export const hubCommandSchema = z.looseObject({
  kind: z.literal('hub-command/1'),
  name: z.string().min(1),
  description: z.string().default(''),
  arguments: z.string().optional(),
  ...base,
});
export type HubCommand = z.infer<typeof hubCommandSchema>;

export const hubManifestSchema = z.discriminatedUnion('kind', [
  hubSkillSchema,
  hubProviderSchema,
  hubHookSchema,
  hubInstructionSchema,
  hubAgentSchema,
  hubCommandSchema,
]);
export type HubManifest = z.infer<typeof hubManifestSchema>;
