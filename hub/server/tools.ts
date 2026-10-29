import { KnowledgeError } from '../knowledge/api.ts';
import type { ContributionLayer } from '../knowledge/api.ts';
// The six tools (D06) over the ports: input parsing, the semantics the server owns (list_task_packs, upload_file, get_nodes)
// and delegation to RunsService for the rest. Every answer is validated against the tool's output schema before it is sent;
// one that does not conform is an internal error and never reaches the caller (D05). isError is true only when the answer is
// a protocol error or a receipt that is not accepted: call_result 'error' (the envelope ties the two together); unknown
// stays inside an accepted answer and is never an error. The content is one block of plain Chinese text (D05 R[0]); the
// JSON is the structuredContent only. Each handler also says what the text may use besides the answer (TextContext): the
// server pages content read by reference (get_nodes {reference, cursor}), so every text may offer page cursors; start_run
// adds the run record, the whole production result and the evidence gaps, submit_result the stored result.
import { readFileSync } from 'node:fs';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import { PROTOCOL_CODES, type ProtocolCode } from '../../contracts/generated/protocol.ts';
import type { Acceptance, CallResult } from '../../contracts/generated/vocabulary.ts';
import { annotationsFor, type ToolAnnotations } from '../../contracts/src/annotations.ts';
import { RunId, type ProtocolError } from '../../contracts/src/common.ts';
import type { PackSummary } from '../../contracts/src/run.ts';
import {
  GetNodesInput,
  ListTaskPacksInput,
  MAX_UPLOAD_BYTES,
  ResolveReferenceInput,
  StartRunInput,
  TOOLS,
  UploadFileInput,
  type ToolDefinition,
} from '../../contracts/src/tools.ts';
import type { CallContext } from '../ports.ts';
import { IntegrityError, RecordsError, isSha256, withRequestPermissions, type Principal } from '../records/api.ts';
import { ParseLimitError, ParseSyntaxError, ParseEncodingError, ReferenceSyntaxError, UNAVAILABLE_MESSAGE, createDocumentCache, parseReference, resolveReference, sandboxReadDiagnostic, type ReaderIdentity, type Reference } from '../refs/api.ts';
import { SandboxError } from '../rules/api.ts';
import type { ServerDeps } from './api.ts';
import { clipNote, describeError, describeInternalError } from './notes.ts';
import { recordReaderFor, sourceReaderFor } from './readers.ts';
import { feedingText, fallbackText, pageCursorProblem, toolText, type TextContext } from './text.ts';
import { callStatus } from './call-status.ts';
import { cachedReadReply } from './read-replies.ts';
import { recoverRead } from './recover-read.ts';
import { base64Size, decodeBase64Strict, isMediaType, mediaTypeFor, mediaTypeIsAuthoritative, structureOfAsync as structureOf } from './upload.ts';

export { describeError, describeInternalError } from './notes.ts';

/** The call context handed to the services: CallContext plus a way to put the real reason of a neutral answer in the admin note. */
export interface ServerCallContext extends CallContext {
  /** The real reason behind a neutral answer (absent, forbidden, failed): admins see it in the call log, the caller never does. */
  adminNote(reason: string): void;
}

/** What one JSON-RPC request contributes to its call-log line (B08). */
export interface CallState {
  method: string;
  /** Tool name or protocol method, as logged. */
  tool: string;
  args: unknown;
  started: number;
  runId: string | null;
  callResult: CallResult | null;
  acceptance: Acceptance | null;
  errorCode: string | null;
  notes: string[];
}

export interface ToolCall {
  principal: Principal;
  context: ServerCallContext;
  state: CallState;
}

export interface PublishedTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
}

type ToolName = 'list_task_packs' | 'upload_file' | 'start_run' | 'get_nodes' | 'resolve_reference' | 'submit_result';
type Answer = Record<string, unknown>;
/** A handler's answer and what its text may use besides it; `paging` is set for every tool by callTool. */
interface Reply {
  answer: Answer;
  text?: TextContext;
}
type Handler = (deps: ServerDeps, call: ToolCall, args: Record<string, unknown>) => Promise<Reply>;

/** The server takes get_nodes {reference, cursor}: every text may offer page cursors (TextContext.paging). */
const PAGING = true;

/** The published schemas (contracts/generated/tools.json), the same ones clients validate against. */
function loadPublished(): Map<string, PublishedTool> {
  const list = JSON.parse(readFileSync(new URL('../../contracts/generated/tools.json', import.meta.url), 'utf8')) as PublishedTool[];
  const byName = new Map(list.map((tool) => [tool.name, tool]));
  const names = TOOLS.map((tool) => tool.name);
  if (list.length !== names.length || names.some((name) => !byName.has(name))) {
    throw new Error('contracts/generated/tools.json does not list exactly the tools of contracts/src/tools.ts; run npm run gen:contracts');
  }
  return byName;
}

export const PUBLISHED: ReadonlyMap<string, PublishedTool> = loadPublished();
const DEFINITIONS: ReadonlyMap<string, ToolDefinition> = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** The tool's own empty shape for a protocol error (D05 R[3]): no invented run ids, locks or digests. */
const EMPTY: Record<ToolName, Answer> = {
  list_task_packs: { packs: [] },
  upload_file: { acceptance: 'not_accepted' },
  start_run: {},
  get_nodes: {},
  resolve_reference: { references: [], diagnostics: [] },
  submit_result: { acceptance: 'not_accepted' },
};

export function errorAnswer(tool: ToolName, errors: ProtocolError[], extra: Answer = {}): Answer {
  return { call_result: 'error', errors, ...EMPTY[tool], ...extra };
}

/** The neutral answer for absent and forbidden alike (D05 R[3]); the real reason goes to the admin note only. */
export function unavailable(): ProtocolError {
  return { code: 'SOURCE_UNAVAILABLE', message: UNAVAILABLE_MESSAGE, fix: PROTOCOL_CODES.SOURCE_UNAVAILABLE.fix };
}

/** RFC 6901 JSON Pointer of a zod issue path. */
export function pointerOfPath(path: readonly PropertyKey[]): string {
  return path.map((part) => `/${String(part).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}

const ARGUMENT_FIX = '按工具的输入模式改正这个参数后再调用';

function violation(tool: ToolName, path: string, message: string, fix = ARGUMENT_FIX): ProtocolError {
  return { code: 'SUBMISSION_SCHEMA_VIOLATION', message: `参数不符合 ${tool} 的输入模式：${message}`, fix, path };
}

/** Longest pointer an error carries; a longer one (a huge key) points at the whole call instead, so the answer stays valid. */
const MAX_ERROR_POINTER = 1024;

/** One protocol error per zod issue (at most 20); an unknown key points at the key itself. */
export function schemaErrors(tool: ToolName, error: z.ZodError): ProtocolError[] {
  const out: ProtocolError[] = [];
  const at = (path: readonly PropertyKey[]): string => {
    const pointer = pointerOfPath(path);
    return pointer.length <= MAX_ERROR_POINTER ? pointer : '';
  };
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) out.push(violation(tool, at([...issue.path, key]), `不认识的参数 ${key.length > 100 ? `${key.slice(0, 100)}…` : key}`));
    } else {
      out.push(violation(tool, at(issue.path), issue.message.slice(0, 500)));
    }
    if (out.length >= 20) break;
  }
  return out.slice(0, 20);
}

function protocolCodeOf(error: unknown): ProtocolCode | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && Object.hasOwn(PROTOCOL_CODES, code) ? (code as ProtocolCode) : null;
}

export function internalError(trace: string): McpError {
  return new McpError(ErrorCode.InternalError, `Hub 内部错误，原因已记入管理员日志（追踪 ${trace}）`, { trace });
}

/** A thrown error with a registered protocol code becomes that error answer; anything else is an internal error. */
function fromThrown(tool: ToolName, error: unknown, call: ToolCall): Answer {
  if (error instanceof SandboxError) {
    // Pack-controlled diagnostics and stdout may contain source bytes; retain only the code and safe declaration identity.
    const diagnostic = sandboxReadDiagnostic(error);
    call.context.adminNote(diagnostic.admin);
    return errorAnswer(tool, [{ code: 'SOURCE_RETRYABLE', message: diagnostic.message, fix: diagnostic.fix }]);
  }
  const code = protocolCodeOf(error);
  if (code === null) {
    call.context.adminNote(describeInternalError(error));
    throw internalError(call.context.traceId);
  }
  if (code === 'SOURCE_UNAVAILABLE') {
    call.context.adminNote(describeError(error));
    return errorAnswer(tool, [unavailable()]);
  }
  const thrown = error as { message?: unknown; fix?: unknown };
  const message = typeof thrown.message === 'string' && thrown.message.length > 0 ? thrown.message : PROTOCOL_CODES[code].when;
  const fix = typeof thrown.fix === 'string' && thrown.fix.length > 0 ? thrown.fix : PROTOCOL_CODES[code].fix;
  return errorAnswer(tool, [{ code, message, fix }]);
}

// ---------------------------------------------------------------- tools/list

/** An input slot that takes an external object type, written system:type (no slash, unlike a media type). */
export function isExternalType(accepts: string): boolean {
  return /^[a-z][a-z0-9-]*:[a-z][a-z0-9_-]*$/.test(accepts);
}

/**
 * The system of the Hub's own knowledge views (`knowledge:impact|facets|index:…`, hub/knowledge VIEW_SYSTEM; named here so
 * that loading the server does not load the knowledge package, and pinned to it by a test). They are bound like external
 * objects, but start_run reads them from the Hub's own records, not from an external system.
 */
export const KNOWLEDGE_VIEW_SYSTEM = 'knowledge';

/** An accepted type that start_run reads from an external system: system:type, except the Hub's own knowledge views. */
export function readsOutside(accepts: string): boolean {
  return isExternalType(accepts) && accepts.slice(0, accepts.indexOf(':')) !== KNOWLEDGE_VIEW_SYSTEM;
}

export function readsExternalFor(summaries: readonly PackSummary[]): boolean {
  return summaries.some((pack) => pack.inputs.some((input) => input.accepts.some(readsOutside)));
}

/**
 * Whether start_run reads an external system for this caller (D06 F[2], D03 R[6]): an assigned pack has an input slot that
 * takes an external object (the Hub's knowledge views are not one), or binds expected sources at start_run (workflow
 * `expected_sources`), whatever its inputs accept. The summaries do not say the latter, so each pack is loaded; a pack that
 * cannot be loaded counts as reading outside (the cautious annotation), with the reason in the admin note.
 */
export async function startRunReadsExternal(deps: ServerDeps, principal: Principal, note: (reason: string) => void = () => {}): Promise<boolean> {
  const summaries = await deps.workflows.summaries(principal);
  if (readsExternalFor(summaries)) return true;
  for (const summary of summaries) {
    let loaded;
    try {
      loaded = await deps.workflows.forUser(principal, summary.pack);
    } catch (error) {
      note(`pack ${summary.pack} could not be loaded to derive the start_run annotation: ${describeError(error)}`);
      return true;
    }
    if (loaded === null) continue;
    if (loaded.workflow.expected_sources !== undefined || loaded.workflow.inputs.some((input) => input.accepts.some(readsOutside))) return true;
  }
  return false;
}

/** The six tools with the published schemas and the caller's annotations (D06 F[2]: start_run is open-world when it reads outside). */
export async function listTools(deps: ServerDeps, principal: Principal, note: (reason: string) => void = () => {}): Promise<PublishedTool[]> {
  const external = await startRunReadsExternal(deps, principal, note);
  return TOOLS.map((tool) => {
    const published = PUBLISHED.get(tool.name)!;
    return {
      name: tool.name,
      title: published.title,
      description: published.description,
      inputSchema: published.inputSchema,
      outputSchema: published.outputSchema,
      annotations: annotationsFor(tool.effect, tool.writesHubRecords, { readsExternal: tool.readsExternal === true && external, idempotent: tool.idempotent === true }),
    };
  });
}

// ---------------------------------------------------------------- handlers

const listTaskPacks: Handler = async (deps, call, args) => {
  const parsed = ListTaskPacksInput.safeParse(args);
  if (!parsed.success) return { answer: errorAnswer('list_task_packs', schemaErrors('list_task_packs', parsed.error)) };
  const packs = await deps.workflows.summaries(call.principal);
  const { kind, pack_id: packId, offset = 0 } = parsed.data;
  const filtered = packs.filter((pack) => (kind === undefined || pack.kind === kind) && (packId === undefined || pack.id === packId));
  return {
    answer: { call_result: 'ok', errors: [], packs: filtered.slice(offset) },
    text: { packList: { offset, ...(kind === undefined ? {} : { kind }), ...(packId === undefined ? {} : { packId }) } },
  };
};

const NAME = /^[^\p{Cc}]{1,300}$/u;

const uploadFile: Handler = async (deps, call, args) => ({ answer: await upload(deps, call, args) });

async function upload(deps: ServerDeps, call: ToolCall, args: Record<string, unknown>): Promise<Answer> {
  const parsed = UploadFileInput.safeParse(args);
  if (!parsed.success) return errorAnswer('upload_file', schemaErrors('upload_file', parsed.error));
  const { file_path: text, media_type: given, name } = parsed.data;
  const limit = Math.min(deps.config.limits.maxUploadBytes, MAX_UPLOAD_BYTES);
  const size = base64Size(text);
  if (size > limit) {
    return errorAnswer('upload_file', [violation('upload_file', '/file_path', `文件 ${size} 字节，超过上限 ${limit} 字节；不会截断保存`, '上传更小的文件；上限由管理员配置')]);
  }
  const bytes = decodeBase64Strict(text);
  if (bytes === null) {
    return errorAnswer('upload_file', [violation('upload_file', '/file_path', 'file_path 不是规范的 base64（填充位不为零，或有多余的填充）', '按 RFC 4648 重新编码文件的字节：带填充，不换行')]);
  }
  if (given !== undefined && !isMediaType(given)) return errorAnswer('upload_file', [violation('upload_file', '/media_type', '媒体类型的写法不对，例如 text/markdown')]);
  if (name !== undefined && (!NAME.test(name) || !name.isWellFormed())) {
    return errorAnswer('upload_file', [violation('upload_file', '/name', '文件名是 1 到 300 个字符，不含控制字符')]);
  }
  let mediaType = mediaTypeFor(bytes, given, name);
  const authoritative = mediaTypeIsAuthoritative(given, name);
  let refusal: ProtocolError | null = null;
  let suggestMediaType = false;
  let structure: Record<string, unknown> | null = null;
  try {
    structure = await structureOf(deps.parsers, bytes, mediaType, (error) => {
      suggestMediaType = mediaType !== 'text/plain' && !(error instanceof ParseLimitError) && (error instanceof ParseSyntaxError || error instanceof ParseEncodingError);
      refusal = { code: error.code, message: `${error.parser}：${error.message}`, fix: error.fix };
    });
  } catch (error) {
    call.context.adminNote(`structure summary failed: ${describeError(error)}`);
    throw error;
  }
  if (refusal && authoritative) return errorAnswer('upload_file', [refusal]);
  if (refusal) {
    const rejected = refusal as ProtocolError;
    const guessed = mediaType;
    const fallback = await structureOf(deps.parsers, bytes, 'text/plain');
    if (fallback !== null) { mediaType = 'text/plain'; structure = fallback; }
    structure = { ...(structure ?? {}), media_type_guessed: true, guessed_media_type: guessed, guessed_refusal: rejected, note: `媒体类型由字节猜测，猜测格式未通过核验，文件仍原样保存；${rejected.message}；修正：${rejected.fix}${suggestMediaType ? '；若类型猜测有误，请用 media_type 明确指定实际格式后重传' : ''}` };
  }
  let artifact;
  try {
    artifact = await deps.records.artifacts.ingest({
      bytes,
      mediaType,
      origin: { upload: { session: call.context.sessionId, message: null } },
      author: { user: call.principal.id, declared: null },
      provenanceType: parsed.data.provenance_type ?? 'declared',
      // B02 R[3]: what is uploaded for a run is visible to its uploader and to admins; widening goes through a share.
      visibility: { readers: [call.principal.id], admins: true, packs: [], shareable: true },
      readTier: 'model_readable',
      name: name ?? null,
    });
  } catch (error) {
    if (error instanceof RecordsError && error.code === 'CREDENTIAL_IN_UPLOAD') {
      const detail = error.detail as { sha256?: unknown };
      return errorAnswer('upload_file', [{ code: 'CREDENTIAL_IN_UPLOAD', message: error.message, fix: error.fix ?? PROTOCOL_CODES.CREDENTIAL_IN_UPLOAD.fix }], {
        ...(typeof detail.sha256 === 'string' ? { sha256: detail.sha256 } : {}),
        size: bytes.length,
      });
    }
    throw error;
  }
  await deps.knowledge.feeding?.upload(call.principal,artifact);
  const sha256 = artifact.body.sha256;
  return {
    call_result: 'ok',
    errors: [],
    acceptance: 'accepted',
    reference: `src:${sha256}`,
    feeding_objects:[sha256],
    sha256,
    size: artifact.body.size,
    media_type: artifact.body.media_type,
    ...(structure === null ? {} : { structure }),
  };
}

/** A record digest as a rec: reference, or null for anything that is not a digest. */
const recordReference = (digest: unknown): string | null => (typeof digest === 'string' && isSha256(digest) ? `rec:${digest}` : null);

/**
 * start_run through the engine's startRunDetailed when the assembly gives it (ServerDeps.runsDetail), so the text can name the
 * run record, list the problems of a production result and the evidence gaps; else RunsService.startRun.
 */
const startRun: Handler = async (deps, call, args) => {
  const parsed = StartRunInput.safeParse(args);
  if (!parsed.success) return { answer: errorAnswer('start_run', schemaErrors('start_run', parsed.error)) };
  let answer: Answer;
  let text: TextContext = {};
  if (deps.runsDetail !== undefined) {
    const detail = await deps.runsDetail.startRunDetailed(call.principal, parsed.data, call.context);
    answer = detail.answer as Answer;
    const named = (answer.result as { reference?: unknown } | undefined)?.reference;
    text = {
      record: recordReference(detail.runRecord),
      // Only the result the answer names: its counts and its problems must be of one result.
      production: detail.production !== null && detail.production.reference === named ? detail.production.result : null,
      unavailable: detail.unavailable ?? [],
      gaps: detail.gaps ?? [],
    };
  } else {
    answer = (await deps.runs.startRun(call.principal, parsed.data, call.context)) as Answer;
  }
  const run = (answer.run as { run?: unknown } | undefined)?.run;
  if (typeof run === 'string' && RunId.safeParse(run).success) call.state.runId = run;
  return { answer, text };
};

const resolveTool: Handler = async (deps, call, args) => {
  const parsed = ResolveReferenceInput.safeParse(args);
  if (!parsed.success) return { answer: errorAnswer('resolve_reference', schemaErrors('resolve_reference', parsed.error)) };
  call.state.runId = parsed.data.run ?? null;
  return { answer: (await deps.runs.resolveReference(call.principal, parsed.data, call.context)) as Answer };
};

/**
 * submit_result passes the raw arguments: the runs package stores them as received before anything checks them (W07). An
 * answer that carries a result (accepted or not) names its stored record, looked up by the submission digest.
 */
const submitResult: Handler = async (deps, call, args) => {
  const run = args.run;
  if (typeof run === 'string' && RunId.safeParse(run).success) call.state.runId = run;
  const answer = { ...((await deps.runs.submitResult(call.principal, args, call.context)) as Answer) };
  return { answer, text: { record: await storedResult(deps, call, answer) } };
};

/** rec:<digest> of the validation result record an answer carries, or null (no result, or no record of it). */
async function storedResult(deps: ServerDeps, call: ToolCall, answer: Answer): Promise<string | null> {
  const result = answer.result as { run?: unknown; submission?: unknown } | undefined;
  if (deps.runsDetail === undefined || typeof result?.run !== 'string' || typeof result.submission !== 'string') return null;
  for(let attempt=1;attempt<=2;attempt++) {
    try {
      const stored=await deps.runsDetail.getResult(call.principal,result.run,result.submission);
      if(stored!==null)return recordReference(stored.record);
      call.context.adminNote(`defect.result_lookup_miss metric=1 attempt ${attempt}: submission ${result.submission} has no returned result record`);
    } catch(error) {
      call.context.adminNote(`defect.result_lookup_miss metric=1 attempt ${attempt}: submission ${result.submission}: ${describeError(error)}`);
    }
    if(attempt===1)await new Promise(resolve=>setTimeout(resolve,50));
  }
  const next=new Date((deps.now?.()??new Date()).getTime()+1000).toISOString();
  if(Array.isArray(answer.errors))answer.errors=[...answer.errors,{code:'SOURCE_RETRYABLE',message:`缺少已存结果的记录引用（提交 ${result.submission}）；两次查询均未取到，下一次重读时间 ${next}`,fix:`到控制台 /console/runs/${result.run} 按提交 ${result.submission} 查看结果；仍缺时请管理员核对结果记录与索引，恢复后重交同一提交读取当前结果`,path:'/result'}];
  return null;
}

const READ_FIX = '读引用和读子树分两次调用；翻下一页只给 reference 和 cursor';
const CURSOR_FIX = '照抄上一页末尾给出的 cursor，和它的引用一起给；从头读就不给 cursor';

const getNodes: Handler = async (deps, call, args) => {
  const parsed = GetNodesInput.safeParse(args);
  if (!parsed.success) return { answer: errorAnswer('get_nodes', schemaErrors('get_nodes', parsed.error)) };
  const input = parsed.data;
  const note = call.context.adminNote;
  if(input.call_query!==undefined){
    const mixed=(['run','root','paths','depth','reference','cursor'] as const).find(key=>input[key]!==undefined);
    if(mixed)return {answer:errorAnswer('get_nodes',[violation('get_nodes',`/${mixed}`,'查询调用状态时只给 call_query','把调用状态查询与读取内容分开')])};
    const tool=input.call_query.start_run!==undefined?'start_run':'get_nodes';
    // Hash the original argument object, not a schema-transformed copy (for example a JSON __proto__ member).
    const rawQuery=args.call_query as Record<string,unknown>;
    const original=rawQuery[tool] as Record<string,unknown>;
    const trace=input.call_query.trace,status=await callStatus(deps,call.principal,tool,original,trace);
    if(tool==='get_nodes'&&trace&&status.active_total===0&&!status.truncated&&status.completed.length===1&&status.completed[0].call_result==='ok'){
      const cached=cachedReadReply(deps,call.principal.id,original,trace);
      if(cached){
        const restored=await recoverRead(deps,call.principal,original,cached.answer,trace,cached.at);
        if(restored){const {trace:_trace,...answer}=restored;const originalInput=GetNodesInput.safeParse(original);return {answer,text:{cursor:originalInput.success&&originalInput.data.cursor?originalInput.data.cursor:null}};}
        status.missing='暂存的原回答未能按当前权限或来源状态核对';status.next_action='请管理员核对来源、权限和凭据状态；也可按当前权限重读原引用或路径';
      }
    }
    return {answer:{call_result:'ok',errors:[],call_status:status}};
  }
  // An empty cursor is no cursor (a model may fill an optional string with ''), for a reference as for a subtree.
  const cursor = input.cursor === undefined || input.cursor === '' ? null : input.cursor;
  if (input.run !== undefined) call.state.runId = input.run;
  const runDetail = async (run: string) => {
    const detail = await deps.runs.getRun(call.principal, run);
    if (detail === null) note(`run ${run} is absent or not visible to ${call.principal.id}`);
    return detail;
  };
  if (input.reference !== undefined) {
    // A cursor goes with the reference it pages (TextContext.cursor); a subtree read never mixes in.
    const mixed = (['root', 'paths', 'depth'] as const).filter((key) => input[key] !== undefined);
    if (mixed.length > 0) return { answer: errorAnswer('get_nodes', [violation('get_nodes', `/${mixed[0]}`, '按引用读取时不再给 root、paths 或 depth', READ_FIX)]) };
    if (input.run !== undefined && (await runDetail(input.run)) === null) return { answer: errorAnswer('get_nodes', [unavailable()]) };
    return readReference(deps, call, input.reference, input.run, cursor);
  }
  let root = input.root;
  let composition: string | null | undefined;
  let feedingOffset:import('../../contracts/src/feeding.ts').FeedingOffset|undefined;
  if (input.run !== undefined) {
    const detail = await runDetail(input.run);
    if (detail === null) return { answer: errorAnswer('get_nodes', [unavailable()]) };
    root ??= detail.run.root;feedingOffset=detail.run.feeding_offset;
    if(root===detail.run.root){composition=null;const ids=detail.run.target_basis.flatMap(claim=>{const data=claim.statement.data;return data&&data.root===root&&typeof data.composition==='string'?[data.composition]:[];});if(new Set(ids).size===1)composition=ids[0];}
    if (root === undefined) {
      note(`run ${input.run} locked no knowledge root`);
      return { answer: errorAnswer('get_nodes', [violation('get_nodes', '/run', '这次运行没有锁定知识根', '给出要读取的 root，或用 reference 读取已绑定的来源')]) };
    }
  }
  if (root === undefined) {
    return { answer: errorAnswer('get_nodes', [violation('get_nodes', '', '要给出 run、root 或 reference 之一', '给出 start_run 返回的 run，或一个知识根，或一个引用')]) };
  }
  let page;
  for(let attempt=0;;attempt++) {
    try {
      page=await deps.knowledge.getNodes({root,feeding_offset:feedingOffset,paths:input.paths??['/'],depth:input.depth??1,cursor,...(composition!==undefined?{composition}:{})},call.principal);
      break;
    } catch(error) {
      if(error instanceof IntegrityError) {
        note(`knowledge original integrity failed: ${describeError(error)}`);
        return {answer:errorAnswer('get_nodes',[{code:'SOURCE_INTEGRITY_UNPROVEN',message:'缺少经摘要核验的知识原件；请管理员从备份恢复后重读',fix:PROTOCOL_CODES.SOURCE_INTEGRITY_UNPROVEN.fix}])};
      }
      if(error instanceof KnowledgeError && error.code!==null) {
        return {answer:errorAnswer('get_nodes',[{code:error.code,message:error.message,fix:error.fix!,...(typeof error.detail.path==='string'?{path:error.detail.path}:cursor?{path:'/cursor'}:{})}])};
      }
      note(`knowledge reader attempt ${attempt+1} failed: ${describeError(error)}`);
      if(attempt===2) {
        const next=new Date((deps.now?.()??new Date()).getTime()+1000).toISOString();
        return {answer:errorAnswer('get_nodes',[{code:'SOURCE_RETRYABLE',message:`缺少这次知识页的读取结果；下一次重读时间 ${next}，保持原查询重读`,fix:PROTOCOL_CODES.SOURCE_RETRYABLE.fix}])};
      }
      await new Promise(resolve=>setTimeout(resolve,10*(attempt+1)));
    }
  }
  if (page === null) {
    note(`knowledge root ${root} (paths ${clipNote(JSON.stringify(input.paths ?? ['/']), 300)}) is absent or not readable by ${call.principal.id}`);
    return { answer: errorAnswer('get_nodes', [unavailable()]) };
  }
  return { answer: { call_result: 'ok', errors: [], root, nodes: page.nodes, coverage: page.coverage, next: page.next } };
};

/**
 * get_nodes with a reference: the content by read tier (D06 F[3]); the reader's permission is checked again on every read.
 * The text shows one page of it, from the cursor when one is given: a cursor is bound to the reference it was made for
 * (the canonical form the content names), so one of another reference is refused at /cursor once the reference resolves.
 */
async function readReference(deps: ServerDeps, call: ToolCall, reference: string, run: string | undefined, cursor: string | null): Promise<Reply> {
  const note = call.context.adminNote;
  let parsed: Reference;
  try {
    parsed = parseReference(reference);
  } catch (error) {
    if (!(error instanceof ReferenceSyntaxError)) throw error;
    return { answer: errorAnswer('get_nodes', [{ code: 'REFERENCE_UNRESOLVED', message: `引用格式不对：${error.message}`, fix: PROTOCOL_CODES.REFERENCE_UNRESOLVED.fix }]) };
  }
  let contributionNote:string|null=null;
  if(parsed.scheme==='rec'){
    const layer=(deps.knowledge as typeof deps.knowledge&{layers?:{contributions:ContributionLayer}}).layers?.contributions;
    const view=await layer?.readView(parsed.record,call.principal);contributionNote=view?.note??null;
    if(view?.status==='credential_unreadable'){
      if(cursor!==null){const problem=pageCursorProblem(reference,cursor);if(problem!==null)return {answer:errorAnswer('get_nodes',[violation('get_nodes','/cursor',problem,CURSOR_FIX)])};}
      // A dynamic access marker is not a rewritten record. Never send a redacted body under the original digest.
      return {answer:{call_result:'ok',errors:[],content:{reference,read_tier:'retain_only',readable:false,sha256:parsed.record,note:view.note,structure:{status:view.status,record:view.record}}}};
    }
  }
  // A withheld source (retain_only) comes back from the reader with null bytes; refs answers it with the note and without
  // evaluating the selector, so absent and withheld follow refs' one rule.
  const sources = sourceReaderFor(deps.records, call.principal, 'function', note);
  const reader: ReaderIdentity = { user: call.principal.id, role: call.principal.role, ...(run === undefined ? {} : { run }) };
  const documents = createDocumentCache();
  let result: Awaited<ReturnType<typeof resolveReference>>;
  try { result = await documents.within!(resolveReference(parsed, {
    retryReads:true,
    now:deps.now?.bind(deps),
    reader,
    parsers: deps.parsers,
    sources,
    trees: deps.knowledge.treeReader(),
    records: recordReaderFor(deps.records, deps.runs, call.principal, note, (deps.knowledge as typeof deps.knowledge & {layers?:{contributions:ContributionLayer}}).layers?.contributions),
    consumer: 'model',
    documents,
    onDiagnostic: (d) => note(`${d.scheme} ${clipNote(d.reference, 300)}: ${d.message}`),
  })); } finally { documents.dispose?.(); }
  if (!result.resolved) {
    if (result.code === 'SOURCE_UNAVAILABLE' && !result.parser_missing) return { answer: errorAnswer('get_nodes', [unavailable()]) };
    return { answer: errorAnswer('get_nodes', [{ code: result.code, message: result.message, fix: result.fix }]) };
  }
  if (cursor !== null) {
    const problem = pageCursorProblem(result.reference, cursor);
    if (problem !== null) return { answer: errorAnswer('get_nodes', [violation('get_nodes', '/cursor', problem, CURSOR_FIX)]) };
  }
  let feedingReceipt:import('../knowledge/feeding.ts').FeedingReceipt|undefined;
  if(parsed.scheme==='src'&&result.readable){const detail=run?await deps.runs.getRun(call.principal,run):null;const captures=detail?.run.sources.filter(binding=>{const ref=parseReference(binding.reference);return ref.scheme==='src'&&ref.sha256===parsed.sha256&&binding.artifact;})??[];for(const capture of captures.length?captures:[undefined]){const meta=capture?.meta_artifact?await deps.records.store.get<any>(capture.meta_artifact):null;feedingReceipt=await deps.knowledge.feeding?.observeSourceBounded(call.principal,parsed.sha256,{sourceRecord:capture?.artifact,readManifest:capture?.read_manifest,metaRecord:capture?.meta_artifact,metaSource:meta?.kind==='source_artifact'?meta.body.sha256:undefined,composition:detail?.run.target_basis.find(claim=>claim.statement.data?.root===detail?.run.root&&typeof claim.statement.data?.composition==='string')?.statement.data?.composition as string|undefined,product:detail?.run.product,root:detail?.run.root,run,line:detail?.run.version});}}
  const feedingState=parsed.scheme==='rec'?await deps.knowledge.feeding?.recordState(parsed.record,call.principal):null;
  const derivedNote=[result.note,contributionNote,feedingState?.validity==='invalid'?'喂入根据已失效；撤回及来源修订记录：'+feedingState.retractions.join('、'):null].filter(Boolean).join('；');
  const content = {
    reference: result.reference,
    read_tier: result.readTier,
    readable: result.readable,
    ...(result.readable && result.text !== null && result.readTier === 'model_readable' ? { text: result.text } : {}),
    ...(parsed.scheme === 'src' ? { sha256: parsed.sha256 } : {}),
    ...(result.summary!==null||feedingState?{structure:{...result.summary,...(feedingState?{feeding_state:feedingState}:{})}}:{}),
    ...(derivedNote?{note:derivedNote}:{}),
  };
  return { answer: { call_result: 'ok', errors: [], content,...(feedingReceipt?{feeding_objects:feedingReceipt.objects,feeding_pending:feedingReceipt.pending}:{}) }, text: { cursor } };
}

const HANDLERS: Record<ToolName, Handler> = {
  list_task_packs: listTaskPacks,
  upload_file: uploadFile,
  start_run: startRun,
  get_nodes: getNodes,
  resolve_reference: resolveTool,
  submit_result: submitResult,
};

function isToolName(name: string): name is ToolName {
  return Object.hasOwn(HANDLERS, name);
}

export interface ToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
  isError: boolean;
}

/** Runs one tool call and returns the MCP result; an answer that violates the output schema throws an internal error instead. */
export async function callTool(deps: ServerDeps, call: ToolCall, name: string, args: Record<string, unknown> | undefined): Promise<ToolResult> {
  if (!DEFINITIONS.has(name) || !isToolName(name)) return callToolWithPermissions(deps,call,name,args);
  try { return await withRequestPermissions(deps.records?.artifacts,call.principal,()=>callToolWithPermissions(deps,call,name,args)); }
  catch (error) {
    if (error instanceof McpError) throw error;
    call.state.callResult = 'error';
    call.context.adminNote(`request permissions: ${describeInternalError(error)}`);
    throw internalError(call.context.traceId);
  }
}

async function callToolWithPermissions(deps: ServerDeps, call: ToolCall, name: string, args: Record<string, unknown> | undefined): Promise<ToolResult> {
  const definition = DEFINITIONS.get(name);
  if (definition === undefined || !isToolName(name)) {
    call.state.callResult = 'error';
    throw new McpError(ErrorCode.InvalidParams, `没有这个工具：${name.slice(0, 100)}`);
  }
  let reply: Reply;
  try {
    reply = await HANDLERS[name](deps, call, args ?? {});
  } catch (error) {
    call.state.callResult = 'error';
    if (error instanceof McpError) throw error;
    reply = { answer: fromThrown(name, error, call) };
  }
  const feedRun=call.state.runId?await deps.runs.getRun(call.principal,call.state.runId):null;
  if(feedRun&&deps.knowledge.feeding)reply.answer={...reply.answer,feeding_objects:await deps.knowledge.feeding.usages(call.principal,feedRun.run.run),feeding_pending:await deps.knowledge.feeding.pending(call.principal,feedRun.run.run),...(feedRun.run.feeding_offset?{feeding_offset:feedRun.run.feeding_offset}:{})};
  const checked = definition.output.safeParse({ ...reply.answer, trace: call.context.traceId });
  if (!checked.success) {
    call.state.callResult = 'error';
    const issues = checked.error.issues.slice(0, 10).map((issue) => `${pointerOfPath(issue.path) || '/'} ${issue.message}`);
    call.context.adminNote(`the answer of ${name} does not conform to its output schema and was not sent: ${issues.join('; ')}`);
    throw internalError(call.context.traceId);
  }
  const value = checked.data as Answer & { call_result: CallResult; errors: ProtocolError[]; acceptance?: Acceptance };
  call.state.callResult = value.call_result;
  call.state.acceptance = value.acceptance ?? null;
  call.state.errorCode = value.call_result === 'error' ? (value.errors[0]?.code ?? null) : null;
  const context: TextContext = { ...reply.text, paging: PAGING };
  let text: string;
  try {
    text = toolText(name, value, context);
  } catch (error) {
    // A valid answer (a run or a result may already be stored) is never lost to its text: a minimal one, the reason noted.
    call.context.adminNote(`the text of the ${name} answer could not be laid out: ${describeError(error)}`);
    text = fallbackText(name, value, context);
  }
  text=feedingText(text,value);
  // D05 R[0], display rule 11: content is plain text, the JSON is structuredContent; no second block repeats it.
  return {
    content: [{ type: 'text', text }],
    structuredContent: value,
    isError: value.call_result === 'error',
  };
}
