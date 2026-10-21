// The six MCP tools of the Hub (D06). Schemas here are the single source for the server, the tests and contracts/generated/tools.json.
import { z } from 'zod';
import { PackKindSchema } from '../generated/vocabulary.ts';
import { Coverage, Envelope, ItemId, PackId, RunId, Sha256 } from './common.ts';
import { ExternalObjectId, ReferenceUri } from './reference.ts';
import { InputBinding, PackSummary, RunSummary } from './run.ts';
import { Submission } from './submission.ts';
import { ValidationResult } from './validation.ts';
import type { EffectClass } from '../generated/vocabulary.ts';

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  input: z.ZodType;
  output: z.ZodType;
  effect: EffectClass;
  writesHubRecords: boolean;
  /** Reads an external system for some assigned packs, so the tool is open-world for those callers. */
  readsExternal?: boolean;
  /** Same arguments give the same result without new effects. */
  idempotent?: boolean;
}

export const SERVER_INSTRUCTIONS = `This server verifies results; it does not generate them. Typical flow:
1. list_task_packs - see which task packs you may use and what inputs they take.
2. upload_file - upload a local file you were given (the Hub returns a reference). Inputs that live in a supported external system can be passed by identity instead.
3. start_run - freeze the work: requirements, items to judge, locked version and the pack procedure.
4. get_nodes / resolve_reference - read the expected sources and check exact values before you rely on them.
5. submit_result - hand in your results item by item. If the receipt is not accepted, read the errors, fix exactly those points and submit again.
Rules: quote exact values verbatim from the sources; never invent commands, numbers or identifiers; relay the server's results unchanged and mark your own commentary as model relay.`;

const Fields = {
  run: RunId.describe('Run id returned by start_run'),
};

export const ListTaskPacksInput = z.object({
  kind: PackKindSchema.optional().describe('Only packs of this kind'),
});
export const ListTaskPacksOutput = Envelope.extend({ packs: z.array(PackSummary) });

export const UploadFileInput = z.object({
  file_path: z
    .string()
    .meta({ contentEncoding: 'base64', contentMediaType: 'application/octet-stream' })
    .describe('The file to upload. Give the local path; the client sends the file bytes.'),
  media_type: z.string().optional().describe('Media type if known, for example text/markdown'),
  name: z.string().optional().describe('Original file name, for display'),
});
export const UploadFileOutput = Envelope.extend({
  reference: ReferenceUri.optional(),
  sha256: Sha256.optional(),
  size: z.number().int().nonnegative().optional(),
  media_type: z.string().optional(),
  structure: z.record(z.string(), z.unknown()).optional().describe('Summary from the parser that recognised the file'),
});

export const StartRunInput = z.object({
  pack: z.string().describe('Pack id, optionally with a version: case-review or case-review@1.0.0'),
  product: z.string().optional().describe('Product name; every name of a product line is accepted, for example APV or NSAE'),
  version: z.string().optional().describe('Version line, for example 10.4.6'),
  build: z.string().optional().describe('Exact build name; chosen by the pack rule when omitted'),
  inputs: z.record(z.string(), z.union([InputBinding, z.array(InputBinding)])).describe('Input slot name to reference or external object'),
  parameters: z.record(z.string(), z.unknown()).optional(),
  predecessor: RunId.optional().describe('Earlier run this one continues'),
  client_key: z.string().max(200).optional().describe('Client chosen key; repeating it within its time window returns the same run'),
});
export const StartRunOutput = Envelope.extend({ run: RunSummary.optional() });

export const GetNodesInput = z.object({
  run: RunId.optional().describe('Use the knowledge root locked by this run'),
  root: Sha256.optional().describe('Knowledge root digest; defaults to the run root'),
  paths: z.array(z.string().startsWith('/')).optional().describe('Subtrees to read, for example /commands/service'),
  depth: z.number().int().min(0).max(6).optional().describe('Levels below each path; default 1'),
  reference: ReferenceUri.optional().describe('Read the content a reference points at instead of a subtree'),
  cursor: z.string().optional(),
});
export const GetNodesOutput = Envelope.extend({
  nodes: z
    .array(
      z.object({
        path: z.string(),
        name: z.string(),
        level: z.enum(['trunk', 'branch', 'leaf']),
        digest: Sha256,
        children: z.array(z.object({ name: z.string(), digest: Sha256 })),
        entries: z.array(z.object({ entry: Sha256, kind: z.string(), statement: z.string(), reference: ReferenceUri, applicability: z.string() })),
      }),
    )
    .optional(),
  content: z.object({ reference: ReferenceUri, text: z.string().optional(), readable: z.boolean(), note: z.string().optional() }).optional(),
});

export const ResolveReferenceInput = z.object({
  run: RunId,
  text: z.string().min(1).describe('The exact value or quotation to resolve, copied verbatim'),
  expect: z.string().optional().describe('What it should resolve to, for example command or quotation'),
});
export const ResolveReferenceOutput = Envelope.extend({
  resolution: z.enum(['resolved', 'ambiguous', 'unresolved']),
  references: z.array(z.object({ reference: ReferenceUri, text: z.string(), role: z.string().optional() })),
  diagnostics: z.array(z.string()),
});

export const SubmitResultInput = Submission;
export const SubmitResultOutput = ValidationResult.extend({
  call_result: Envelope.shape.call_result,
  next: z.string().nullable().optional(),
});

export const TOOLS: ToolDefinition[] = [
  {
    name: 'list_task_packs',
    title: 'List task packs',
    description: 'List the task packs you may use, with the inputs, parameters and requirements of each.',
    input: ListTaskPacksInput,
    output: ListTaskPacksOutput,
    effect: 'none',
    writesHubRecords: false,
  },
  {
    name: 'upload_file',
    title: 'Upload a file',
    description: 'Upload a local file as a source artifact. Returns a reference to use as a run input. Identical bytes give the same reference.',
    input: UploadFileInput,
    output: UploadFileOutput,
    effect: 'none',
    writesHubRecords: true,
    idempotent: true,
  },
  {
    name: 'start_run',
    title: 'Start a run',
    description: 'Freeze the work for a task pack: requirements, items, locked knowledge version and the pack procedure. Inputs are references from upload_file or external object identities.',
    input: StartRunInput,
    output: StartRunOutput,
    effect: 'none',
    writesHubRecords: true,
    readsExternal: true,
  },
  {
    name: 'get_nodes',
    title: 'Read knowledge nodes',
    description: 'Read subtrees of the knowledge tree locked by a run, or the content a reference points at.',
    input: GetNodesInput,
    output: GetNodesOutput,
    effect: 'none',
    writesHubRecords: false,
  },
  {
    name: 'resolve_reference',
    title: 'Resolve a value to a reference',
    description: 'Preview how an exact value or quotation resolves against the sources bound to a run. The result is a preview and not evidence.',
    input: ResolveReferenceInput,
    output: ResolveReferenceOutput,
    effect: 'none',
    writesHubRecords: false,
  },
  {
    name: 'submit_result',
    title: 'Submit results',
    description: 'Submit your results item by item. The Hub validates them and returns the receipt, partitions and the terminal state of every requirement. Repeating a submission returns the current result.',
    input: SubmitResultInput,
    output: SubmitResultOutput,
    effect: 'none',
    writesHubRecords: true,
    idempotent: true,
  },
];

export { Coverage, ItemId, PackId, ExternalObjectId, Fields };
