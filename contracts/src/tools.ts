import {FeedingOffsetSchema,ModelIdentitySchema} from '../generated/shared-interfaces.ts';
// The six MCP tools of the Hub (D06). Schemas here are the single source for the server, the tests and contracts/generated/tools.json.
// Every answer conforms to its output schema, a protocol error included: the envelope plus the tool's empty shape (D05 R[3]),
// never invented run ids, locks or digests.
import { z } from 'zod';
import { KnowledgeContributionPageView, MAX_NODE_CONTRIBUTIONS,ApplicabilityFields } from './contributions.ts';
import { AcceptanceSchema, CallResultSchema, EntryKindSchema, NodeLevelSchema, PackKindSchema, ProvenanceTypeSchema, ReadTierSchema, ResolutionSchema, SourceRoleSchema } from '../generated/vocabulary.ts';
import { IsoTime, Coverage, Envelope as BaseEnvelope, ItemId, PackId, RunId, Sha256, TraceId } from './common.ts';
import { ExternalObjectId, Ground, ReferenceUri, TreePath, referenceUriOf } from './reference.ts';
import { Backlinks } from './views.ts';
import { InputBinding, PackSummary, RunSummary } from './run.ts';
import { Submission } from './submission.ts';
import { PartitionCounts, ValidationResult, partitionCountsOf } from './validation.ts';
import type { EffectClass } from '../generated/vocabulary.ts';

const Envelope=BaseEnvelope.extend({feeding_objects:z.array(Sha256).optional(),feeding_offset:FeedingOffsetSchema.optional(),feeding_pending:z.array(z.strictObject({source:Sha256,missing:z.string(),next_action:z.string()})).optional()});

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
If start_run or get_nodes times out, get_nodes call_query checks the exact original arguments without rerunning them. Use the original trace when known; without it matching calls are candidates, not proven to be the timed-out call.
Rules: quote exact values verbatim from the sources; never invent commands, numbers or identifiers; relay the server's results unchanged and mark your own commentary as model relay.`;

const Fields = {
  run: RunId.describe('Run id returned by start_run'),
};

/** Largest file upload_file takes, in bytes (the source cap of the earlier implementation). */
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
/** Longest base64 text of an upload: four characters for every three bytes, padded. */
export const MAX_UPLOAD_BASE64_LENGTH = 4 * Math.ceil(MAX_UPLOAD_BYTES / 3);
/**
 * The base64 alphabet with up to two trailing `=`. A single character class: a grouped pattern overflows the regular
 * expression stack on a payload near the cap. The length rule of RFC 4648 is a refinement. zod's own base64 is not used
 * because it publishes a format JSON Schema does not define.
 */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

type Path = (string | number)[];
const issue = <T>(ctx: z.core.$RefinementCtx<T>, path: Path, message: string): void => ctx.addIssue({ code: 'custom', path, message });

export const ListTaskPacksInput = z.strictObject({
  kind: PackKindSchema.optional().describe('Only packs of this kind'),
  pack_id: PackId.optional().describe('Only the pack with this exact ID'),
  offset: z.number().int().nonnegative().optional().describe('Continue at this zero-based position in the same filtered list'),
});
export const ListTaskPacksOutput = Envelope.extend({ packs: z.array(PackSummary) }).superRefine((o, ctx) => {
  if (o.call_result === 'error' && o.packs.length > 0) issue(ctx, ['packs'], 'an error answer lists no packs');
});

export const UploadFileInput = z.strictObject({
  file_path: z
    .string()
    .min(1)
    .max(MAX_UPLOAD_BASE64_LENGTH, { abort: true })
    .regex(BASE64, 'the file content in base64 (RFC 4648, padded, no line breaks), not a path')
    .refine((text) => text.length % 4 === 0, 'base64 text has a length divisible by four (RFC 4648 padding)')
    .meta({ contentEncoding: 'base64', contentMediaType: 'application/octet-stream' })
    .describe('The file to upload. Give the local path; the client sends the file bytes.'),
  media_type: z.string().optional().describe('Media type if known, for example text/markdown'),
  name: z.string().optional().describe('Original file name, for display'),
  provenance_type: ProvenanceTypeSchema.extract(['declared', 'client_captured']).optional().describe('Client-declared upload provenance; defaults to declared. client_captured is for Circle operation captures and stays declaration grade.'),
});
// safeExtend: the receipt, optional in the envelope, is required here, and the envelope's refinements stay.
export const UploadFileOutput = Envelope.safeExtend({
  acceptance: AcceptanceSchema,
  reference: referenceUriOf('src').optional().describe('src:<sha256> of the stored bytes, to use as a run input; only when accepted'),
  sha256: Sha256.optional(),
  size: z.number().int().nonnegative().optional(),
  media_type: z.string().optional(),
  structure: z.record(z.string(), z.unknown()).optional().describe('Summary from the parser that recognised the file'),
}).superRefine((o, ctx) => {
  if (o.acceptance !== 'accepted') {
    if (o.reference !== undefined) issue(ctx, ['reference'], 'an upload that is not accepted has no reference');
  } else if (o.reference === undefined || o.sha256 === undefined || o.size === undefined) {
    issue(ctx, ['reference'], 'an accepted upload returns its reference, sha256 and size');
  } else if (o.reference !== `src:${o.sha256}`) {
    issue(ctx, ['reference'], 'the reference of an upload is src:<sha256> of its bytes');
  }
});

export const StartRunInput = z.strictObject({
  pack: z.string().min(1).describe('Pack id from list_task_packs, optionally followed by @version'),
  product: z.string().optional().describe('Product name; every name of a product line is accepted'),
  version: z.string().optional().describe('Version line of the product'),
  build: z.string().optional().describe('Exact build name; chosen by the pack rule when omitted'),
  model_identity: ModelIdentitySchema.optional().describe('Explicit model and family declaration; submissions from this same observed session can reuse it'),
  inputs: z.record(z.string(), z.union([InputBinding, z.array(InputBinding)])).describe('Input slot name to reference or external object'),
  parameters: z.record(z.string(), z.unknown()).optional().describe('The parameters the pack declares, as one object by name, for example {"<name>": <value>}; list_task_packs lists every pack parameter with its name, description and schema'),
  submission_due:IsoTime.optional().describe('Requested absolute submission deadline; the service binds its actual finite policy before writing the run'),
  predecessor: RunId.optional().describe('Earlier run this one continues'),
  client_key: z
    .string()
    .min(1)
    .max(200)
    .refine((key) => !key.includes('\u0000'), 'no NUL character in a client key')
    .optional()
    .describe('Client chosen key; repeating it within its time window returns the same run'),
});
/** The result the Hub computed itself at start_run, for a run whose requirements are all facts: stored, readable by reference. */
export const ProductionResult = z.strictObject({
  reference: referenceUriOf('rec').describe('the validation_result record of the run; read it with get_nodes and this reference'),
  counts: PartitionCounts,
});
export const StartRunOutput = Envelope.extend({ run: RunSummary.optional(), result: ProductionResult.optional() }).superRefine((o, ctx) => {
  if ((o.call_result === 'ok') !== (o.run !== undefined)) issue(ctx, ['run'], 'an ok answer carries the run and an error answer carries none');
  if (o.result !== undefined && o.run === undefined) issue(ctx, ['result'], 'a result belongs to a run');
});

const CallQuery=z.strictObject({
  start_run:z.record(z.string(),z.unknown()).optional().describe('Exact arguments of your earlier start_run call'),
  get_nodes:z.record(z.string(),z.unknown()).optional().describe('Exact arguments of your earlier get_nodes call'),
  trace:TraceId.optional().describe('The original trace when known; omit it to list matching candidates'),
}).superRefine((value,ctx)=>{if((value.start_run===undefined)===(value.get_nodes===undefined))issue(ctx,[],'provide exactly one original call argument object');});

export const GetNodesInput = z.strictObject({
  run: RunId.optional().describe('Use the knowledge root locked by this run'),
  root: Sha256.optional().describe('Knowledge root digest; defaults to the run root'),
  paths: z
    .array(TreePath)
    .max(256)
    .optional()
    .describe('Subtrees to read: node paths copied verbatim from get_nodes or from a tree reference, for example / or /commands/show'),
  depth: z.number().int().min(0).max(6).optional().describe('Levels below each path; default 1'),
  reference: ReferenceUri.optional().describe('Read the content a reference points at instead of a subtree'),
  cursor: z.string().optional(),
  call_query:CallQuery.optional().describe('Check your own in-flight call and recent completion logs without rerunning it; provide the exact original arguments'),
});

const NodeEntry = z.strictObject({
  entry: Sha256,
  kind: EntryKindSchema,
  statement: z.string(),
  reference: referenceUriOf('tree').describe('Tree address of the node pinned to this entry, tree:<root><path>@<entry>; cite it verbatim as a ground'),
  applicability: z.string(),
  applicability_fields:ApplicabilityFields.optional(),
  applicability_context:z.strictObject({composition:Sha256.nullable(),criteria_digest:Sha256.nullable()}).optional(),
  data: z.record(z.string(), z.unknown()).optional().describe('Machine-readable content of the entry, for example the signatures and typed parameters of a catalog leaf'),
});

const KnowledgeNode = z.strictObject({
  path: TreePath,
  reference: referenceUriOf('tree').describe('Tree address of the node, tree:<root><path>; cite it verbatim as a ground'),
  name: z.string(),
  level: NodeLevelSchema.describe('Position label of the node, computed from the tree height'),
  digest: Sha256,
  children: z.array(z.strictObject({ name: z.string(), path: TreePath, digest: Sha256 })),
  entries: z.array(NodeEntry),
  contributions: z.array(KnowledgeContributionPageView).max(MAX_NODE_CONTRIBUTIONS).optional().describe('A bounded page of contributions beside the tree; continue with next; not part of the root digest'),
  backlinks: Backlinks.optional(),
  feeding_objects:z.array(z.strictObject({object:Sha256,reference:referenceUriOf('rec')})).max(100).optional(),
  feeding_complete:z.boolean().optional(),
  feeding_structure: z.string().optional().describe('The knowledge-structure@1 contract document (the feeding shapes beside seedlings, kb-feeding), returned on the root path `/` so the model reads the one shape it may feed against; not part of the root digest'),
});

export const GetNodesOutput = Envelope.extend({
  call_status:z.strictObject({
    tool:z.string(),
    active_total:z.number().int().nonnegative(),
    active:z.array(z.strictObject({trace:TraceId,started_at:IsoTime})),
    completed:z.array(z.strictObject({trace:TraceId,at:IsoTime,call_result:CallResultSchema,error_code:z.string().nullable(),duration_ms:z.number().int().nonnegative(),run:RunId.nullable(),run_record:referenceUriOf('rec').optional(),result_record:referenceUriOf('rec').optional()})),
    truncated:z.boolean(),
    missing:z.string().optional(),next_action:z.string(),
  }).optional(),
  root: Sha256.optional().describe('Knowledge root the nodes belong to'),
  nodes: z.array(KnowledgeNode).optional(),
  content: z
    .strictObject({
      reference: ReferenceUri,
      read_tier: ReadTierSchema.describe('model_readable: text is given; function_bytes_only: only sha256 and structure; retain_only: neither'),
      text: z.string().optional(),
      sha256: Sha256.optional(),
      structure: z.record(z.string(), z.unknown()).optional().describe('Summary from the parser, when the bytes are for functions only'),
      readable: z.boolean(),
      note: z.string().optional(),
    })
    .refine((c) => c.text === undefined || c.read_tier === 'model_readable', { message: 'text is given only for a model readable source (D06 F[3])', path: ['text'] })
    .optional(),
}).superRefine((o, ctx) => {
  if (o.call_result === 'error') {
    if ((o.nodes ?? []).length > 0 || o.content !== undefined || o.call_status !== undefined) issue(ctx, ['nodes'], 'an error answer carries no nodes, content or call status');
    return;
  }
  if(o.call_status!==undefined && (o.root!==undefined || o.nodes!==undefined || o.content!==undefined))issue(ctx,['call_status'],'a call status is separate from a knowledge or reference read');
  const nodes = o.nodes ?? [];
  if (nodes.length > 0 && o.root === undefined) issue(ctx, ['root'], 'nodes come with the root they belong to');
  if (o.root === undefined) return;
  nodes.forEach((node, i) => {
    for(const linked of node.backlinks?.entries??[])if(!linked.reference.startsWith(`tree:${o.root}${linked.path}@`))issue(ctx,['nodes',i,'backlinks'],'a related source must belong to this root and path');
    const address = `tree:${o.root}${node.path}`;
    if (node.reference !== address) issue(ctx, ['nodes', i, 'reference'], `the reference of this node is ${address}`);
    node.entries.forEach((entry, j) => {
      if (entry.reference !== `${address}@${entry.entry}`) issue(ctx, ['nodes', i, 'entries', j, 'reference'], `the reference of this entry is ${address}@${entry.entry}`);
    });
  });
});

export const ResolveReferenceInput = z
  .strictObject({
    run: RunId.optional().describe('Use the sources bound to this run'),
    root: Sha256.optional().describe('Knowledge root digest; resolves tree: and constituent src: grounds without a run'),
    text: z.string().min(1).describe('The exact value or quotation to resolve, copied verbatim'),
    expect: z.string().optional().describe('What it should resolve to, for example command or quotation'),
  })
  .superRefine((val, ctx) => {
    if (val.run === undefined && val.root === undefined) {
      issue(ctx, ['run'], 'provide exactly one of run or root');
    } else if (val.run !== undefined && val.root !== undefined) {
      issue(ctx, ['root'], 'provide exactly one of run or root');
    }
  });
export const ResolveReferenceOutput = Envelope.extend({
  resolution: ResolutionSchema.optional().describe('How the value resolves; absent on a protocol error'),
  references: z
    .array(z.strictObject({ reference: Ground, text: z.string(), role: SourceRoleSchema.optional() }))
    .describe('Possible referents, citable as grounds; empty on a protocol error'),
  diagnostics: z.array(z.string()),
}).superRefine((o, ctx) => {
  if (o.call_result === 'ok' && o.resolution === undefined) issue(ctx, ['resolution'], 'an ok answer states the resolution');
  if (o.call_result === 'error' && (o.resolution !== undefined || o.references.length > 0)) {
    issue(ctx, ['resolution'], 'an error answer has no resolution and no referents: absent and unavailable look the same (D05 R[3])');
  }
});

export const SubmitResultInput = Submission;
export const SubmitResultOutput = Envelope.safeExtend({
  acceptance: AcceptanceSchema,
  result: ValidationResult.optional().describe(
    'The validation result (validation@1) when the submission was validated against a run you may use; absent on a protocol error such as an unknown or unavailable run. A repeated submission returns the stored result, whose trace is that of the call that produced it',
  ),
  counts: PartitionCounts.optional().describe('Counts derived from result.partitions, only when the submission was accepted'),
}).superRefine((o, ctx) => {
  if (o.result !== undefined && o.result.acceptance !== o.acceptance) issue(ctx, ['result', 'acceptance'], 'the receipt and the validation result agree');
  if (o.acceptance !== 'accepted') {
    if (o.counts !== undefined) issue(ctx, ['counts'], 'a submission that is not accepted has no partitions to count (V05 R[5])');
    return;
  }
  if (o.result === undefined) issue(ctx, ['result'], 'an accepted submission comes with its validation result');
  if (o.counts === undefined) issue(ctx, ['counts'], 'an accepted submission comes with its counts');
  if (o.result === undefined || o.counts === undefined) return;
  const derived = partitionCountsOf(o.result.partitions);
  const counts: Record<string, number> = o.counts;
  if (Object.entries(derived).some(([key, value]) => counts[key] !== value)) issue(ctx, ['counts'], 'counts are derived from result.partitions (W08 R[0])');
});

export const TOOLS: ToolDefinition[] = [
  {
    name: 'list_task_packs',
    title: 'List task packs',
    description: 'List the task packs you may use, with inputs, parameters and requirements. Filter by exact pack_id or continue a truncated list with offset.',
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
    description: 'Read subtrees or referenced content; use call_query with exact original arguments to check your own long start_run or get_nodes call without rerunning it.',
    input: GetNodesInput,
    output: GetNodesOutput,
    effect: 'none',
    writesHubRecords: false,
  },
  {
    name: 'resolve_reference',
    title: 'Resolve a value to a reference',
    description:
      'Preview how an exact value or quotation resolves against the sources bound to a run (using run) or against a standalone knowledge root (using root). When run is given, resolves against run-bound sources, catalog commands and records. When root is given, resolves tree: addresses and constituent src: grounds without starting a run. Exactly one of run or root must be provided. The result is a preview and not evidence.',
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
