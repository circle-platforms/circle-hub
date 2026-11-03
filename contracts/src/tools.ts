import {MemoryWriteInput,MemoryShareInput,MemoryWriteReceipt,MemoryShareBody,MemoryPage,MemoryDocumentView,MemoryCheckResult,MemoryQuery} from './memory.ts';
import {FeedingOffsetSchema,ModelIdentitySchema} from '../generated/shared-interfaces.ts';
// The six MCP tools of the Hub (D06). Schemas here are the single source for the server, the tests and contracts/generated/tools.json.
// Every answer conforms to its output schema, a protocol error included: the envelope plus the tool's empty shape (D05 R[3]),
// never invented run ids, locks or digests.
import { z } from 'zod';
import { KnowledgeShareInput, KnowledgeShareReceipt } from './sharing.ts';
import { SpaceEntryInput, SpaceEntryReceipt, SpaceId, SpaceSearchHit } from './spaces.ts';
import { KnowledgeSpaceKindSchema, KnowledgeSearchScopeSchema, KnowledgeEntryStatusSchema } from '../generated/vocabulary.ts';
import { KnowledgeContributionPageView, MAX_NODE_CONTRIBUTIONS,ApplicabilityFields } from './contributions.ts';
import { AcceptanceSchema, CallResultSchema, EntryKindSchema, NodeLevelSchema, PackKindSchema, ProvenanceTypeSchema, ReadTierSchema, ResolutionSchema, SourceRoleSchema } from '../generated/vocabulary.ts';
import { IsoTime, Coverage, Envelope as BaseEnvelope, ItemId, PackId, RunId, Sha256, TraceId, ProtocolError } from './common.ts';
import { ExternalObjectId, Ground, ReferenceUri, TreePath, referenceUriOf } from './reference.ts';
import { Backlinks } from './views.ts';
import { InputBinding, LocalToolsSummary, PackSummary, RunSummary } from './run.ts';
import { Submission } from './submission.ts';
import { PartitionCounts, ValidationResult, partitionCountsOf } from './validation.ts';
import type { EffectClass } from '../generated/vocabulary.ts';

const Envelope=BaseEnvelope.extend({feeding_objects:z.array(Sha256).optional(),feeding_offset:FeedingOffsetSchema.optional(),feeding_pending:z.array(z.strictObject({source:Sha256,missing:z.string(),next_action:z.string()})).optional()});

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  /** The Chinese name the console shows for the tool; never published to models (tools.json and tools/list leave it out). */
  label: string;
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
Personal packs: list_task_packs includes space for personal workflows and generic skills. Use pack_space on start_run and get_nodes with pack, pack_space and file (default SKILL.md) to read their declared files. Pure generic skills have no acceptance and are read through get_nodes, not started as runs. Owners publish and grant personal packs through the console.
Memory: get_nodes with memory lists or reads preferences, and upload_file with memory writes them optimistically using expected_version and client_key. memory_share previews with check_only=true and confirms on a second call. Memory has separate grants and is never an input or ground. Session mode reads only team and caller-owned enabled current documents.
Sharing: upload_file with share_entry submits a verified personal entry; team_path optionally selects the team directory (default: the personal path); a receipt records that target with a registered rejection or the merged team reference. withdraw_entry withdraws an own team submission or an administrator-authorized team entry. Results require grounds readable by every actual result reader.
Personal knowledge: upload_file with personal_entry writes only to the caller's space; space=personal imports an original without drafting entries. get_nodes with search and scope searches current readable knowledge only without run. During a run, copy exact tree addresses from the frozen team/personal roots and the initiator's currently authorized content.
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
/** One line of the whole filtered list (A05 R[1]): every choice is in the answer even when the details are paged. */
export const PackIndexRow = z.strictObject({ pack: z.string().describe('id@version'), title: z.string(), kind: PackKindSchema });
/**
 * What the run context of the listed packs would hold right now (decision 113), from the Hub's own records: the lease view of
 * every declared lease prefix (R02 R[3]: who holds a key is not said) and the newest observation of every observed device
 * (A05 R[3]: it holds for its moment only). Present only when a listed pack declares the leases or observations context.
 */
export const PackContextView = z.strictObject({
  leases: z.array(z.strictObject({
    prefix: z.string().min(1),
    packs: z.array(z.string()).describe('the listed packs (id@version) that declare this lease prefix'),
    registrations: z.array(z.strictObject({ prefix: z.string().min(1), mine: z.boolean() })),
    held: z.array(z.strictObject({ key: z.string().min(1), since: IsoTime, until: IsoTime.nullable(), run: z.string().min(1), jobs: z.array(z.string()), mine: z.boolean() })),
  })),
  observations: z.array(z.strictObject({
    label: z.string().min(1),
    build: z.string().nullable(),
    base: z.string().nullable(),
    observed_at: IsoTime,
    packs: z.array(z.string()).describe('the listed packs (id@version) that declare the observations context'),
  })),
});
export type PackContextView = z.infer<typeof PackContextView>;
export const ListTaskPacksOutput = Envelope.extend({
  packs: z.array(PackSummary),
  index: z.array(PackIndexRow).optional().describe('Every pack of the same filter, one row each, whatever the offset'),
  context: PackContextView.optional(),
}).superRefine((o, ctx) => {
  if (o.call_result === 'error' && o.packs.length > 0) issue(ctx, ['packs'], 'an error answer lists no packs');
});

export const UploadFileInput = z.strictObject({
  memory:MemoryWriteInput.optional().describe('Create or optimistically edit client session preferences; expected_version is null for creation. Personal writes belong to the caller; team writes require an administrator. This mode returns no evidence reference.'),
  memory_share:MemoryShareInput.optional().describe('Share the caller\'s current personal memory with the team. First use check_only=true, then confirm; limits and administrator changes are checked again. No review or model generation occurs.'),
  file_path: z
    .string()
    .min(1)
    .max(MAX_UPLOAD_BASE64_LENGTH, { abort: true })
    .regex(BASE64, 'the file content in base64 (RFC 4648, padded, no line breaks), not a path')
    .refine((text) => text.length % 4 === 0, 'base64 text has a length divisible by four (RFC 4648 padding)')
    .meta({ contentEncoding: 'base64', contentMediaType: 'application/octet-stream' })
    .describe('The file to upload. Give the local path; the client sends the file bytes.').optional(),
  share_entry: KnowledgeShareInput.optional().describe('Submit one caller-owned verified entry to team knowledge; optional team_path chooses the team directory, otherwise the personal path; records the target and returns a merged/rejected receipt without an approval queue'),
  withdraw_entry: KnowledgeShareInput.optional().describe('Withdraw a caller-owned personal entry or a permitted team submission; old references keep their immutable content'),
  personal_entry: SpaceEntryInput.optional().describe('Store a personal knowledge entry instead of a file; quotes are verified by the Hub; a note without grounds is unverified'),
  space: KnowledgeSpaceKindSchema.extract(['personal']).optional().describe('Import a file into the caller personal knowledge space; the Hub never drafts an entry'),
  media_type: z.string().optional().describe('Media type if known, for example text/markdown'),
  name: z.string().optional().describe('Original file name, for display'),
  provenance_type: ProvenanceTypeSchema.extract(['declared', 'client_captured']).optional().describe('Client-declared upload provenance; defaults to declared. client_captured is for Circle operation captures and stays declaration grade.'),
  captured_at: IsoTime.optional().describe('The original capture moment declared by the client, not the Hub receipt moment; Hub receipt is kept separately in the record created_at'),
}).refine(input => [input.file_path,input.personal_entry,input.share_entry,input.withdraw_entry,input.memory,input.memory_share].filter(value=>value!==undefined).length===1, 'provide exactly one payload mode').refine(input=>!(input.memory||input.memory_share)||[input.space,input.media_type,input.name,input.provenance_type,input.captured_at].every(v=>v===undefined),'memory mode accepts no file metadata');
// safeExtend: the receipt, optional in the envelope, is required here, and the envelope's refinements stay.
export const UploadFileOutput = Envelope.safeExtend({
  memory_write:MemoryWriteReceipt.optional(),
  memory_share:MemoryCheckResult.optional(),
  personal_entry: SpaceEntryReceipt.optional(),
  share: KnowledgeShareReceipt.optional(),
  withdrawn_reference: referenceUriOf('tree').optional(),
  acceptance: AcceptanceSchema,
  reference: referenceUriOf('src').optional().describe('src:<sha256> of the stored bytes, to use as a run input; only when accepted'),
  artifact: Sha256.optional().describe('Exact source_artifact record, so equal-byte captures can be bound independently; only when accepted'),
  sha256: Sha256.optional(),
  size: z.number().int().nonnegative().optional(),
  media_type: z.string().optional(),
  structure: z.record(z.string(), z.unknown()).optional().describe('Summary from the parser that recognised the file'),
}).superRefine((o, ctx) => {
  if (o.acceptance !== 'accepted') {
    if (o.reference !== undefined) issue(ctx, ['reference'], 'an upload that is not accepted has no reference');
    if (o.artifact !== undefined) issue(ctx, ['artifact'], 'an upload that is not accepted has no exact artifact record');
    if(o.memory_write!==undefined)issue(ctx,['memory_write'],'a refused memory write has no saved receipt');
    if (o.personal_entry !== undefined) issue(ctx, ['personal_entry'], 'a refused entry has no receipt');
  } else if(o.memory_write!==undefined||o.memory_share!==undefined){
    if(o.reference!==undefined||o.sha256!==undefined||o.artifact!==undefined)issue(ctx,['memory_write'],'memory never yields an evidence reference');
  } else if(o.share!==undefined||o.withdrawn_reference!==undefined){
    if(o.reference!==undefined)issue(ctx,['reference'],'an entry operation has no file receipt');
  } else if (o.personal_entry !== undefined) {
    if (o.reference !== undefined) issue(ctx, ['reference'], 'an entry receipt is separate from a file receipt');
  } else if (o.reference === undefined || o.sha256 === undefined || o.size === undefined) {
    issue(ctx, ['reference'], 'an accepted upload returns its reference, sha256 and size');
  } else if (o.reference !== `src:${o.sha256}`) {
    issue(ctx, ['reference'], 'the reference of an upload is src:<sha256> of its bytes');
  }
});

export const StartRunInput = z.strictObject({
  pack: z.string().min(1).describe('Pack id from list_task_packs, optionally followed by @version'),
  pack_space: SpaceId.optional().describe('Personal owner id for a personal workflow; omitted or team selects the team catalog'),
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
/** The inputs of the reader's packs that accept the type (`system:kind`, exact) of a source the run read (decision 113). */
export const AcceptedBy = z.strictObject({
  type: z.string().min(1),
  inputs: z.array(z.strictObject({ pack: z.string().describe('id@version'), slot: z.string().min(1), role: SourceRoleSchema })),
});
export const StartRunOutput = Envelope.extend({ run: RunSummary.optional(), result: ProductionResult.optional(), accepted_by: z.array(AcceptedBy).optional(), local_tools: LocalToolsSummary.optional().describe('the tools/ files of the pack this run froze; absent when it ships none. An answer-level fact: the run record itself never changes') }).superRefine((o, ctx) => {
  if ((o.call_result === 'ok') !== (o.run !== undefined)) issue(ctx, ['run'], 'an ok answer carries the run and an error answer carries none');
  if (o.result !== undefined && o.run === undefined) issue(ctx, ['result'], 'a result belongs to a run');
  if (o.local_tools !== undefined && o.run === undefined) issue(ctx, ['local_tools'], 'local tools belong to a run');
});

const CallQuery=z.strictObject({
  start_run:z.record(z.string(),z.unknown()).optional().describe('Exact arguments of your earlier start_run call'),
  get_nodes:z.record(z.string(),z.unknown()).optional().describe('Exact arguments of your earlier get_nodes call'),
  trace:TraceId.optional().describe('The original trace when known; omit it to list matching candidates'),
}).superRefine((value,ctx)=>{if((value.start_run===undefined)===(value.get_nodes===undefined))issue(ctx,[],'provide exactly one original call argument object');});

export const GetNodesInput = z.strictObject({
  memory:MemoryQuery.optional().describe('List or read versioned client preferences without a run. Session lists select team or personal; session document reads pin a listed version. A grant permits browsing only. Continue with memory.cursor; these documents cannot be grounds.'),
  pack: z.string().min(1).max(100).optional().describe('Read a visible pack file without starting a run; especially SKILL.md for a generic skill'),
  pack_space: SpaceId.optional(),
  file: z.string().min(1).max(1000).optional().describe('Declared relative pack file; defaults to SKILL.md'),
  space: SpaceId.optional().describe('team or the personal space owner user id; defaults to the caller personal space when no root is provided'),
  search: z.string().min(1).max(200).optional().describe('Full-text knowledge search without run only; results are leads, never task evidence'),
  scope: KnowledgeSearchScopeSchema.optional().describe('Search personal, team, shared with the caller, or all visible spaces'),
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
}).refine(input=>input.memory===undefined||[input.pack,input.pack_space,input.file,input.space,input.search,input.scope,input.run,input.root,input.paths,input.depth,input.reference,input.cursor,input.call_query].every(v=>v===undefined),'memory is an independent non-evidence mode');

const NodeEntry = z.strictObject({
  status: KnowledgeEntryStatusSchema.optional(),
  grounds_withdrawn:z.array(Ground).optional(),
  grounds_withdrawn_hidden_count:z.number().int().nonnegative().optional().describe('Count of withdrawn ancestors whose references the current reader cannot read; no paths or digests'),
  grounds: z.array(z.strictObject({ reference: Ground, quotation: z.string() })).optional(),
  cited_count: z.number().int().nonnegative().nullable().optional(),
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
  memory_page:MemoryPage.optional(),
  memory_document:MemoryDocumentView.optional(),
  warnings:z.array(ProtocolError).max(100).optional().describe('Unavailable knowledge search scopes omitted from the matches; never claim a complete search while warnings are present'),
  matches: z.array(SpaceSearchHit).optional(),
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
    if (o.memory_page!==undefined||o.memory_document!==undefined||(o.nodes ?? []).length > 0 || o.content !== undefined || (o.matches ?? []).length > 0 || o.call_status !== undefined) issue(ctx, ['nodes'], 'an error answer carries no nodes, content or call status');
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
  withdrawn_grounds:z.array(Ground).optional().describe("Live withdrawal qualifier, outside the immutable historical result"),
  withdrawn_grounds_hidden_count:z.number().int().nonnegative().optional().describe('Count of currently unreadable withdrawn grounds, without their identities'),
  acceptance: AcceptanceSchema,
  result: ValidationResult.optional().describe(
    'The validation result (validation@1) when the submission was validated against a run you may use; absent on a protocol error such as an unknown or unavailable run. A repeated submission returns the stored result, whose trace is that of the call that produced it',
  ),
  counts: PartitionCounts.optional().describe('Counts derived from result.partitions, only when the submission was accepted'),
  dispatch: z.array(z.strictObject({
    job: Sha256.optional().describe('The job the Hub dispatched for this run'),
    executor: z.string().min(1).max(200).optional().describe('The executor the job runs on'),
    result: ReferenceUri.optional().describe('The job result once it is complete (src:), readable by the runner: one row per dispatched item'),
    text: z.string().min(1).max(800).describe('What happened or what is missing, in the user language'),
  })).max(16).optional().describe('Jobs of this run that the Hub dispatches by a hub_template effect row once a submission is accepted and the release conditions hold (W03, decision 105). Repeating the same submission reads their progress'),
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
    label: '查询工作流',
    title: 'List task packs',
    description: 'List the task packs you may use, with inputs, parameters and requirements. Filter by exact pack_id or continue a truncated list with offset.',
    input: ListTaskPacksInput,
    output: ListTaskPacksOutput,
    effect: 'none',
    writesHubRecords: false,
  },
  {
    name: 'upload_file',
    label: '上传文件',
    title: 'Upload a file',
    description: 'Upload a file for a run, or set space=personal to import a private original. Instead of file_path, personal_entry stores caller-authored personal knowledge: grounds and verbatim quotations are checked; a note without grounds stays unverified. The Hub drafts no content. Identical file bytes give the same source reference. Use memory or memory_share instead for versioned session preferences: no evidence reference is returned.',
    input: UploadFileInput,
    output: UploadFileOutput,
    effect: 'none',
    writesHubRecords: true,
  },
  {
    name: 'start_run',
    label: '启动任务',
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
    label: '读取知识',
    title: 'Read knowledge nodes',
    description: 'Read a permitted pack file with pack, pack_space and file, or personal/team knowledge nodes and immutable references. Without run, search and scope find visible knowledge as leads. With run, search is rejected: read exact addresses from the frozen versions. upload_file with personal_entry stores a caller-authored note or verified entry. Use call_query with exact original arguments to check your own long start_run or get_nodes call without rerunning it.',
    input: GetNodesInput,
    output: GetNodesOutput,
    effect: 'none',
    writesHubRecords: false,
  },
  {
    name: 'resolve_reference',
    label: '引用解析',
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
    label: '提交结果',
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
