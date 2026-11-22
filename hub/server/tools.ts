import type {ClientDeclaration} from '../../contracts/src/spaces.ts';
import {knowledgeMessage} from './capacity.ts';
import {join} from 'node:path';
import { KnowledgeError } from '../knowledge/api.ts';
import type { ContributionLayer } from '../knowledge/api.ts';
import { readFileSync } from 'node:fs';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import { PROTOCOL_CODES, type ProtocolCode } from '../../contracts/generated/protocol.ts';
import { SyncModeSchema, labelOf, type Acceptance, type CallResult } from '../../contracts/generated/vocabulary.ts';
import { annotationsFor, type ToolAnnotations } from '../../contracts/src/annotations.ts';
import { RunId, type ProtocolError } from '../../contracts/src/common.ts';
import type { PackSummary } from '../../contracts/src/run.ts';
import { ExternalObjectId } from '../../contracts/src/reference.ts';
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
import type { CallContext, WorkflowStore } from '../ports.ts';
import { findSubschema, renderExpected } from '../runs/api.ts';
import { localToolsOf } from '../runs/packs/ports.ts';
import { IntegrityError, RecordsError, recordExistence, isSha256, decodeCursor, withReadScope, withRequestPermissions, type Principal } from '../records/api.ts';
import { ParseLimitError, ParseSyntaxError, ParseEncodingError, ReferenceSyntaxError, UNAVAILABLE_MESSAGE, createDocumentCache, parseReference, resolveReference, sandboxReadDiagnostic, type ReaderIdentity, type Reference } from '../refs/api.ts';
import { SandboxError } from '../rules/api.ts';
import { step, type TraceReader } from '../telemetry/api.ts';
import type { ServerDeps } from './api.ts';
import { clipNote, describeError, describeInternalError } from './notes.ts';
import { recordReaderFor, sourceReaderFor } from './readers.ts';
import { fixByRole, type CallerRole } from './fix-by-role.ts';
import { modelReferencesText, fallbackText, pageCursorProblem, toolText, type TextContext } from './text.ts';
import { callStatus } from './call-status.ts';
import { observabilitySkill, observabilitySkillFile, observedCall, observedStep } from './observability.ts';
import { cachedReadReply } from './read-replies.ts';
import { recoverRead } from './recover-read.ts';
import { escalateProtocolErrors } from './refusal-escalate.ts';
import { absentPackFact, absentPackNext, unassignedPackFact, unassignedPackNext, uninstalledPackFact, uninstalledPackNext, withdrawnPackFact } from './pack-words.ts';
import { base64Size, decodeBase64Strict, isMediaType, mediaTypeFor, mediaTypeIsAuthoritative, structureOfAsync as structureOf } from './upload.ts';

export { describeError, describeInternalError } from './notes.ts';

/** The call context handed to the services: CallContext plus a way to put the real reason of a neutral answer in the admin note. */
export interface ServerCallContext extends CallContext {
  signal?: AbortSignal;
  /** The real reason behind a neutral answer (absent, forbidden, failed): admins see it in the call log, the caller never does. */
  adminNote(reason: string): void;
  traces?: Pick<TraceReader, 'show'>;
  /** What this session's client reported in MCP initialize (clientInfo), read only by writers; null when nothing was reported. */
  client?: () => Promise<ClientDeclaration | null>;
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
  /** initialize only: the clientInfo the client reported (a declaration). */
  client?: ClientDeclaration;
  /** initialize only: the platform in that clientInfo; diagnostic data, for the traces and never in `client`. */
  clientPlatform?: string;
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

/** The neutral answer, for the credential and login classes only (D05 R[3]); the real reason goes to the admin note only. */
export function unavailable(): ProtocolError {
  return { code: 'SOURCE_UNAVAILABLE', message: UNAVAILABLE_MESSAGE, fix: PROTOCOL_CODES.SOURCE_UNAVAILABLE.fix };
}

/** The fixes for a knowledge root a caller cannot read, the same in get_nodes and resolve_reference. */
export const ROOT_ABSENT_FIX = '核对知识根；知识根来自运行或 get_nodes';
export const ROOT_FORBIDDEN_FIX = '请联系管理员为该账户分配绑定这条产品线的工作流；或改读这次运行锁定的构建的手册和命令树';

/** Not found or no permission (D05 R[3], decision 112): `what` as the caller wrote it, e.g. "运行 run_…". */
export function missingObject(exists: boolean, what: string, fix?: string): ProtocolError {
  const gap = /[\x21-\x7e]$/.test(what) ? ' ' : '';
  return exists
    ? { code: 'SOURCE_NOT_PERMITTED', message: `${what}${gap}存在，你没有读取权限`, fix: fix ?? PROTOCOL_CODES.SOURCE_NOT_PERMITTED.fix }
    : { code: 'SOURCE_ABSENT', message: `Hub 里没有${what}`, fix: fix ?? '核对写法；运行号来自 start_run，知识根来自运行或 get_nodes' };
}

/** RFC 6901 JSON Pointer of a zod issue path. */
export function pointerOfPath(path: readonly PropertyKey[]): string {
  return path.map((part) => `/${String(part).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}

const ARGUMENT_FIX = '这次按 tools/list 该工具的 inputSchema 改正参数后再调用';

function violation(_tool: ToolName, path: string, message: string, fix = ARGUMENT_FIX): ProtocolError {
  return { code: 'SUBMISSION_SCHEMA_VIOLATION', message: `参数无效：${message}`, fix, path };
}

/** Longest pointer an error carries; a longer one (a huge key) points at the whole call instead, so the answer stays valid. */
const MAX_ERROR_POINTER = 1024;

function leafOf(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return (parts[parts.length - 1] ?? '').replaceAll('~1', '/').replaceAll('~0', '~');
}

function parentPointer(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 1) return '';
  return `/${parts.slice(0, -1).join('/')}`;
}

function pointerTokens(path: string): string[] {
  if (!path || path === '/') return [];
  return path.split('/').slice(1).map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function valueAt(args: unknown, path: string): unknown {
  if (!path) return args;
  let cur: unknown = args;
  for (const token of pointerTokens(path)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[token];
  }
  return cur;
}

function typeWord(type: unknown): string {
  if (type === 'string') return '字符串';
  if (type === 'number') return '数字';
  if (type === 'integer') return '整数';
  if (type === 'boolean') return '布尔值';
  if (type === 'object' || type === 'record') return '对象';
  if (type === 'array') return '数组';
  if (type === 'null') return 'null';
  return '取值';
}

function receivedWord(issue: z.core.$ZodIssue): string | null {
  const raw = (issue as { received?: unknown }).received ?? /received (\w+)/.exec(issue.message)?.[1];
  if (raw === 'undefined' || raw === undefined) return null;
  return typeWord(raw);
}

function shortExpected(schema: Record<string, unknown> | null, issue: z.core.$ZodIssue): string {
  if (schema !== null) {
    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
      return `枚举（${schema.enum.map((v) => JSON.stringify(v)).join('、')}）`;
    }
    if (schema.type === 'integer') {
      return typeof schema.minimum === 'number' ? `整数（≥${schema.minimum}）` : '整数';
    }
    if (typeof schema.type === 'string') return typeWord(schema.type);
    if (schema.type === undefined && schema.properties !== undefined) return '对象';
    if (schema.type === undefined && schema.items !== undefined) return '数组';
  }
  if (issue.code === 'invalid_type') return typeWord((issue as { expected?: unknown }).expected);
  return '取值';
}

function propertyNames(schema: Record<string, unknown> | null): string[] {
  if (schema === null || typeof schema.properties !== 'object' || schema.properties === null) return [];
  return Object.keys(schema.properties as Record<string, unknown>);
}

function isOptionalProperty(root: Record<string, unknown>, path: string): boolean {
  const leaf = leafOf(path);
  if (!leaf) return true;
  const parent = locateSubschema(root, parentPointer(path));
  if (parent === null) return true;
  const required = Array.isArray(parent.required) ? parent.required.map(String) : [];
  return !required.includes(leaf);
}

function ruleRef(tool: ToolName, path: string, _suffix = ''): string {
  const leaf = leafOf(path);
  if (!leaf) return `规则见 ${tool} 输入格式`;
  return `规则见 ${tool} 输入格式的 ${leaf}`;
}

function thisCallFix(writing: string, rule: string): string {
  return `请${writing}。${rule}`;
}

function formatReceivedValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
  if (typeof value === 'object') return '对象';
  return '该值';
}

function writingForField(tool: ToolName, path: string, schema: Record<string, unknown> | null, expected: string): string {
  const leaf = leafOf(path);
  if (tool === 'start_run' && leaf === 'pack') {
    return `在 ${path} 写 list_task_packs 返回的编号`;
  }
  if (tool === 'list_task_packs' && leaf === 'kind') {
    return `在 ${path} 写 "workflow"（或去掉 kind 以列出全部）`;
  }
  if (leaf === 'offset') return `在 ${path} 写数字 0（或上一页续读的整数下标）`;
  if (leaf === 'inputs') return `在 ${path} 给出对象，键为输入槽名，值为引用或外部对象`;
  if (leaf === 'reference' && typeof schema?.description === 'string' && /reference/i.test(schema.description)) {
    return `在 ${path} 写符合 REFERENCE_FORMS 的引用字符串（如 upload_file 返回的 src:…）`;
  }
  return `在 ${path} 写${expected}`;
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function locateSubschema(root: Record<string, unknown>, path: string): Record<string, unknown> | null {
  const direct = findSubschema(root, path);
  if (direct !== null) return direct;
  const tokens = pointerTokens(path);
  if (tokens.length === 0) return root;
  let curr: Record<string, unknown> | null = root;
  for (const token of tokens) {
    if (curr === null) return null;
    const next = stepSchema(curr, token, root);
    curr = next;
  }
  return curr;
}

function stepSchema(node: Record<string, unknown>, token: string, root: Record<string, unknown>): Record<string, unknown> | null {
  let cur = node;
  if (typeof cur.$ref === 'string') {
    const via = findSubschema(root, cur.$ref.startsWith('#/') ? cur.$ref.slice(1) : '');
    if (via) cur = via;
  }
  if (/^\d+$/.test(token)) {
    if (isSchemaObject(cur.items)) return cur.items;
    return firstBranch(cur, (branch) => (isSchemaObject(branch.items) ? branch.items : null));
  }
  if (isSchemaObject(cur.properties) && token in cur.properties) {
    const prop = (cur.properties as Record<string, unknown>)[token];
    return isSchemaObject(prop) ? prop : null;
  }
  const fromBranch = firstBranch(cur, (branch) => {
    if (isSchemaObject(branch.properties) && token in (branch.properties as Record<string, unknown>)) {
      const prop = (branch.properties as Record<string, unknown>)[token];
      return isSchemaObject(prop) ? prop : null;
    }
    return null;
  });
  if (fromBranch) return fromBranch;
  if (isSchemaObject(cur.additionalProperties)) return cur.additionalProperties;
  return firstBranch(cur, (branch) => stepSchema(branch, token, root));
}

function firstBranch(node: Record<string, unknown>, pick: (branch: Record<string, unknown>) => Record<string, unknown> | null): Record<string, unknown> | null {
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (!Array.isArray(node[key])) continue;
    for (const branch of node[key] as unknown[]) {
      if (!isSchemaObject(branch)) continue;
      const hit = pick(branch);
      if (hit) return hit;
    }
  }
  return null;
}

export function pathInInputSchema(schema: Record<string, unknown>, path: string): boolean {
  if (path === '') return true;
  if (locateSubschema(schema, path) !== null) return true;
  const parentPath = parentPointer(path);
  const parent = locateSubschema(schema, parentPath);
  if (parent === null || parent.additionalProperties !== false) return false;
  const leaf = leafOf(path);
  return leaf.length > 0 && !propertyNames(parent).includes(leaf);
}

function argumentShape(tool: ToolName, path: string, issue: z.core.$ZodIssue, root: Record<string, unknown>, args: unknown): { message: string; fix: string } {
  const target = locateSubschema(root, path);
  const parent = locateSubschema(root, parentPointer(path));

  if (issue.code === 'unrecognized_keys' || (target === null && parent?.additionalProperties === false && leafOf(path) && !propertyNames(parent).includes(leafOf(path)))) {
    const key = leafOf(path);
    const shown = key.length > 100 ? `${key.slice(0, 100)}…` : key;
    const legal = propertyNames(parent);
    const legalText = legal.length > 0 ? `合法字段见 inputSchema（${legal.join('、')}）` : '合法字段见 inputSchema';
    return {
      message: `不认识的参数 ${shown}`,
      fix: thisCallFix(`去掉 ${path}；${legalText}`, ruleRef(tool, '')),
    };
  }

  if (issue.code === 'invalid_value' || (target !== null && Array.isArray(target.enum))) {
    const allowed = (issue.code === 'invalid_value' ? (issue as { values?: unknown[] }).values : undefined) ?? (target?.enum as unknown[] | undefined) ?? [];
    const labels = allowed.map((v) => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v)));
    const got = valueAt(args, path);
    const seen = got === undefined ? '未给出合法枚举值' : formatReceivedValue(got);
    const optional = isOptionalProperty(root, path);
    const preferred = labels.includes('workflow') ? 'workflow' : labels[0];
    const sample = preferred !== undefined ? JSON.stringify(preferred) : expectedSample(target);
    const omit = optional ? `（或去掉 ${leafOf(path)} 以列出全部）` : '';
    const writing = tool === 'list_task_packs' && leafOf(path) === 'kind'
      ? writingForField(tool, path, target, sample)
      : `在 ${path} 写 ${sample}${omit}`;
    return {
      message: `${path} 收到的是 ${seen}；允许的取值只有 ${labels.join('、')}`,
      fix: thisCallFix(writing, ruleRef(tool, path, '.enum')),
    };
  }

  const missing = issue.code === 'invalid_type' && receivedWord(issue) === null;
  if (missing) {
    const expected = shortExpected(target, issue);
    return {
      message: `${path} 是必填的${expected}，这次没有给出`,
      fix: thisCallFix(writingForField(tool, path, target, expected), ruleRef(tool, path)),
    };
  }

  if (target !== null) {
    const expected = shortExpected(target, issue);
    const typeMismatch = issue.code === 'invalid_type';
    const shownExpected =
      !typeMismatch && typeof target.pattern === 'string' && expected === '字符串'
        ? '符合模式的字符串'
        : expected === '对象' || expected === '数组'
          ? renderExpected(target)
          : expected;
    const received = receivedWord(issue) ?? formatReceivedValue(valueAt(args, path));
    const got = valueAt(args, path);
    const seenText =
      typeMismatch || typeof got !== 'string' || got.length === 0 || got.length > 80
        ? `收到的是${received}`
        : `收到的是 ${JSON.stringify(got)}`;
    return {
      message: `${path} 要的是${shownExpected}，${seenText}`,
      fix: thisCallFix(writingForField(tool, path, target, expected), ruleRef(tool, path)),
    };
  }

  if (issue.code === 'invalid_type') {
    const expected = typeWord((issue as { expected?: unknown }).expected);
    const received = receivedWord(issue) ?? '其他类型';
    return {
      message: `${path} 要的是${expected}，收到的是${received}`,
      fix: thisCallFix(writingForField(tool, path, null, expected), ruleRef(tool, path)),
    };
  }

  const detail = issue.message.slice(0, 500);
  return {
    message: detail,
    fix: thisCallFix(`按 ${tool} 的 inputSchema 改正 ${path || '参数'}`, ruleRef(tool, path)),
  };
}

function expectedSample(schema: Record<string, unknown> | null): string {
  if (schema === null) return '"…"';
  if (Array.isArray(schema.enum) && schema.enum[0] !== undefined) return JSON.stringify(schema.enum[0]);
  if (schema.type === 'string') return '"…"';
  if (schema.type === 'integer' || schema.type === 'number') return '0';
  if (schema.type === 'boolean') return 'true';
  return '符合模式的值';
}

/** One protocol error per zod issue (at most 20); an unknown key points at the key itself. */
export function schemaErrors(tool: ToolName, error: z.ZodError, args: unknown = undefined): ProtocolError[] {
  const root = (PUBLISHED.get(tool)?.inputSchema ?? { type: 'object', additionalProperties: false }) as Record<string, unknown>;
  const out: ProtocolError[] = [];
  const at = (path: readonly PropertyKey[]): string => {
    const pointer = pointerOfPath(path);
    return pointer.length <= MAX_ERROR_POINTER ? pointer : '';
  };
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        const path = at([...issue.path, key]);
        const shaped = argumentShape(tool, path, issue, root, args);
        out.push(violation(tool, path, shaped.message, shaped.fix));
        if (out.length >= 20) break;
      }
    } else {
      const path = at(issue.path);
      const shaped = argumentShape(tool, path, issue, root, args);
      out.push(violation(tool, path, shaped.message, shaped.fix));
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

/**
 * The answer to a skill parser's sandbox failure. A document that its parse cannot hold, by the document cache's budget, the
 * sandbox's memory or its output limit, fails again on every reread, so the fix is a smaller original or a parser that keeps
 * less (hub/refs/README.md, Skill parser limits). Any other failure is the administrator's to look into.
 */
export function sandboxError(error: SandboxError): ProtocolError {
  const diagnostic = sandboxReadDiagnostic(error);
  return { code: 'SOURCE_RETRYABLE', message: diagnostic.message, fix: diagnostic.fix };
}

/** A thrown error with a registered protocol code becomes that error answer; anything else is an internal error. */
function fromThrown(tool: ToolName, error: unknown, call: ToolCall): Answer {
  if (error instanceof SandboxError) {
    // Pack-controlled diagnostics and stdout may contain source bytes; retain only the code and safe declaration identity.
    call.context.adminNote(sandboxReadDiagnostic(error).admin);
    return errorAnswer(tool, [sandboxError(error)]);
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
export async function startRunReadsExternal(deps: ServerDeps, principal: Principal, note: (reason: string) => void = () => {}, listed?: readonly PackSummary[]): Promise<boolean> {
  const summaries = listed ?? await deps.workflows.summaries(principal);
  if (readsExternalFor(summaries)) return true;
  for (const summary of summaries) {
    let loaded;
    try {
      loaded = await deps.workflows.forUser(principal, summary.pack,summary.space);
    } catch (error) {
      note(`pack ${summary.pack} could not be loaded to derive the start_run annotation: ${describeError(error)}`);
      return true;
    }
    if (loaded === null) continue;
    if (loaded.workflow.expected_sources !== undefined || loaded.workflow.inputs.some((input) => input.accepts.some(readsOutside))) return true;
  }
  return false;
}

/** D06 R[4], decision 105: submit_result makes the Hub dispatch for this caller when one of the caller's packs declares a
 * hub_template effect row; a pack that cannot be loaded counts as dispatching, so the hints stay conservative. */
export async function submitDispatchesJobs(deps: ServerDeps, principal: Principal, note: (reason: string) => void = () => {}, listed?: readonly PackSummary[]): Promise<boolean> {
  for (const summary of listed ?? await deps.workflows.summaries(principal)) {
    let loaded;
    try {
      loaded = await deps.workflows.forUser(principal, summary.pack);
    } catch (error) {
      note(`pack ${summary.pack} could not be loaded to derive the submit_result annotation: ${describeError(error)}`);
      return true;
    }
    if (loaded?.effects?.some((row) => row.trigger === 'hub_template')) return true;
  }
  return false;
}

/** The six tools with the published schemas and the caller's annotations (D06 F[2]: start_run is open-world when it reads outside;
 * D06 R[4]: submit_result carries the widest effect class of the rows it may make the Hub dispatch). */
export function listTools(deps: ServerDeps, principal: Principal, note: (reason: string) => void = () => {}): Promise<PublishedTool[]> {
  return withReadScope(() => publishedTools(deps, principal, note));
}

async function publishedTools(deps: ServerDeps, principal: Principal, note: (reason: string) => void): Promise<PublishedTool[]> {
  const summaries = await deps.workflows.summaries(principal);
  const external = await startRunReadsExternal(deps, principal, note, summaries);
  const dispatches = await submitDispatchesJobs(deps, principal, note, summaries);
  return TOOLS.map((tool) => {
    const published = PUBLISHED.get(tool.name)!;
    return {
      name: tool.name,
      title: published.title,
      description: published.description,
      inputSchema: published.inputSchema,
      outputSchema: published.outputSchema,
      annotations: annotationsFor(tool.name === 'submit_result' && dispatches ? 'job' : tool.effect, tool.writesHubRecords, { readsExternal: tool.readsExternal === true && external, idempotent: tool.idempotent === true }),
    };
  });
}

// ---------------------------------------------------------------- handlers

function checkReadCancellation(call: ToolCall): void {
  if (call.context.signal?.aborted) throw new McpError(ErrorCode.ConnectionClosed, '请求已取消');
}

export function packIdAbsenceError(
  packId: string,
  absence: NonNullable<Awaited<ReturnType<NonNullable<WorkflowStore['absence']>>>>,
  kind?: import('../../contracts/generated/vocabulary.ts').PackKind | null,
): ProtocolError {
  if (absence === 'unassigned') {
    return {
      code: 'SOURCE_NOT_PERMITTED',
      message: unassignedPackFact(packId, kind ?? 'workflow'),
      fix: unassignedPackNext(kind ?? 'workflow'),
      path: '/pack_id',
    };
  }
  if (absence === 'withdrawn') {
    return {
      code: 'SOURCE_ABSENT',
      message: withdrawnPackFact(packId),
      fix: absentPackNext(),
      path: '/pack_id',
    };
  }
  if (absence === 'uninstalled') {
    return {
      code: 'SOURCE_ABSENT',
      message: uninstalledPackFact(packId),
      fix: uninstalledPackNext(),
      path: '/pack_id',
    };
  }
  return {
    code: 'SOURCE_ABSENT',
    message: absentPackFact(packId),
    fix: absentPackNext(),
    path: '/pack_id',
  };
}

const listTaskPacks: Handler = async (deps, call, args) => {
  checkReadCancellation(call);
  const parsed = ListTaskPacksInput.safeParse(args);
  if (!parsed.success) return { answer: errorAnswer('list_task_packs', schemaErrors('list_task_packs', parsed.error, args)) };
  const summaries = await deps.workflows.summaries(call.principal);
  checkReadCancellation(call);
  const capabilities = await deps.memberCapabilities(call.principal, undefined, summaries);
  const available = [...capabilities.workflows, ...capabilities.skills];
  const assigned = [];
  for (const pack of summaries) {
    const personal = pack.space !== undefined && pack.space !== 'team';
    const owner = personal ? await deps.records.principals.get(pack.space!) : null;
    if (available.some(item => item.ref === `${pack.id}@${pack.version}` &&
      (personal ? owner !== null && item.owner === owner.name : item.owner === undefined))) assigned.push(pack);
  }
  checkReadCancellation(call);
  const packs = [...assigned.filter(pack => (pack.space ?? 'team') !== 'team' || pack.pack !== observabilitySkill.pack), observabilitySkill];
  const { kind, pack_id: packId, offset = 0 } = parsed.data;
  const filtered = packs.filter((pack) => (kind === undefined || pack.kind === kind) && (packId === undefined || pack.id === packId));
  if (packId !== undefined && packId !== observabilitySkill.id && filtered.length === 0) {
    const absence = await deps.workflows.absence?.(call.principal, packId) ?? null;
    if (absence !== null) {
      call.context.adminNote(`list_task_packs: pack_id ${packId} is ${absence} for ${call.principal.id}`.slice(0, 1000));
      return { answer: errorAnswer('list_task_packs', [packIdAbsenceError(packId, absence)]) };
    }
  }
  // Every choice is in the answer whatever the offset (A05 R[1]); only the details are paged (decision 113).
  const index = filtered.map((pack) => ({ pack: pack.pack, title: pack.title, kind: pack.kind }));
  let context: Awaited<ReturnType<NonNullable<ServerDeps['runs']['packContext']>>> = null;
  let contextUnread = false;
  if (deps.runs.packContext !== undefined) {
    try {
      context = await deps.runs.packContext(call.principal, filtered.filter(pack => pack !== observabilitySkill));
    } catch (error) {
      contextUnread = true;
      call.context.adminNote(`list_task_packs: the run context of the listed packs was not read: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000));
    }
  }
  checkReadCancellation(call);
  return {
    answer: { call_result: 'ok', errors: [], member_capabilities: capabilities, packs: filtered.slice(offset), index, ...(context !== null ? { context } : {}) },
    text: { packList: { offset, ...(kind === undefined ? {} : { kind }), ...(packId === undefined ? {} : { packId }), ...(contextUnread ? { contextUnread } : {}) } },
  };
};

const NAME = /^[^\p{Cc}]{1,300}$/u;

const uploadFile: Handler = async (deps, call, args) => ({ answer: await upload(deps, call, args) });

async function upload(deps: ServerDeps, call: ToolCall, args: Record<string, unknown>): Promise<Answer> {
  const parsed = UploadFileInput.safeParse(args);
  if (!parsed.success) return errorAnswer('upload_file', schemaErrors('upload_file', parsed.error, args));
  if(parsed.data.memory||parsed.data.memory_share){
    const memory=deps.knowledge.memory;if(!memory)return errorAnswer('upload_file',[unavailable()]);
    try{
      if(parsed.data.memory)return {call_result:'ok',errors:[],acceptance:'accepted',memory_write:await memory.write(call.principal,parsed.data.memory)};
      const result=await memory.share(call.principal,parsed.data.memory_share);
      const errors=result.checks.filter(check=>check.state!=='pass'&&check.state!=='unchecked').map(check=>({code:check.code??'SOURCE_UNAVAILABLE',message:check.message,fix:check.fix}));
      const prior=result.share?.code?Object.entries(PROTOCOL_CODES).find(([code])=>code===result.share!.code):undefined;
      if(!errors.length&&prior)errors.push({code:prior[0] as ProtocolCode,message:result.share!.message,fix:prior[1].fix});
      return result.ok?{call_result:'ok',errors:[],acceptance:'accepted',memory_share:result}:{...errorAnswer('upload_file',errors.length?errors:[unavailable()]),memory_share:result};
    }catch(error){if(error instanceof KnowledgeError&&error.code)return errorAnswer('upload_file',[{code:error.code,message:knowledgeMessage(error),fix:error.fix!}]);throw error;}
  }
  if(parsed.data.share_entry||parsed.data.withdraw_entry){
    const spaces=deps.knowledge.spaces;if(!spaces)return errorAnswer('upload_file',[unavailable()]);
    try{
      if(parsed.data.share_entry){const share=await spaces.share(call.principal,parsed.data.share_entry,call.context.sessionId,await call.context.client?.()??null);return share.status==='merged'?{call_result:'ok',errors:[],acceptance:'accepted',share}:{...errorAnswer('upload_file',[{code:share.code!,message:share.message,fix:PROTOCOL_CODES[share.code as ProtocolCode]?.fix}]),share};}
      const input=parsed.data.withdraw_entry!,version=await spaces.version(input.root);if(!version||!(await spaces.mayRead(call.principal,version.body.space,input.path)))return errorAnswer('upload_file',[unavailable()]);
      await spaces.withdraw(call.principal,input.entry,version.body.space);
      return {call_result:'ok',errors:[],acceptance:'accepted',withdrawn_reference:`tree:${input.root}${input.path}@${input.entry}`};
    }catch(error){if(error instanceof KnowledgeError&&error.code)return errorAnswer('upload_file',[{code:error.code,message:knowledgeMessage(error),fix:error.fix!}]);throw error;}
  }
  if(parsed.data.personal_entry){
    if(!deps.knowledge.spaces)return errorAnswer('upload_file',[unavailable()]);
    try{return {call_result:'ok',errors:[],acceptance:'accepted',personal_entry:await deps.knowledge.spaces.write(call.principal,parsed.data.personal_entry,call.context.sessionId,undefined,await call.context.client?.()??null)}}
    catch(error){if(error instanceof KnowledgeError&&error.code)return errorAnswer('upload_file',[{code:error.code,message:knowledgeMessage(error),fix:error.fix!}]);throw error;}
  }
  const { file_path: text, media_type: given, name } = parsed.data;
  if(parsed.data.space==='personal'&&!deps.knowledge.spaces)return errorAnswer('upload_file',[unavailable()]);
  if(text===undefined)return errorAnswer('upload_file',[violation('upload_file','/file_path','缺少文件内容')]);
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
    artifact = parsed.data.space==='personal'&&deps.knowledge.spaces
      ? await deps.knowledge.spaces.importFile(call.principal,bytes,mediaType,name??null,'/',call.context.sessionId)
      : await deps.records.artifacts.ingest({
      bytes,
      mediaType,
      origin: { upload: { session: call.context.sessionId, message: null } },
      author: { user: call.principal.id, declared: null },
      provenanceType: parsed.data.provenance_type ?? 'declared',
      ...(parsed.data.captured_at ? { capturedAt: parsed.data.captured_at } : {}),
      // B02 R[3]: what is uploaded for a run is visible to its uploader and to admins; widening goes through a share.
      visibility: { readers: [call.principal.id], admins: true, packs: [], shareable: true },
      readTier: 'model_readable',
      name: name ?? null,
    });
  } catch (error) {
    if(error instanceof KnowledgeError&&error.code)return errorAnswer('upload_file',[{code:error.code,message:knowledgeMessage(error),fix:error.fix!}]);
    if (error instanceof RecordsError && error.code === 'CREDENTIAL_IN_UPLOAD') {
      const detail = error.detail as { sha256?: unknown };
      return errorAnswer('upload_file', [{ code: 'CREDENTIAL_IN_UPLOAD', message: error.message, fix: error.fix ?? PROTOCOL_CODES.CREDENTIAL_IN_UPLOAD.fix }], {
        ...(typeof detail.sha256 === 'string' ? { sha256: detail.sha256 } : {}),
        size: bytes.length,
      });
    }
    throw error;
  }
  if(parsed.data.space!=='personal')await deps.knowledge.feeding?.upload(call.principal,artifact);
  const sha256 = artifact.body.sha256;
  return {
    call_result: 'ok',
    errors: [],
    acceptance: 'accepted',
    reference: `src:${sha256}`,
    artifact: artifact.digest,
    ...(parsed.data.space==='personal'?{}:{feeding_objects:[sha256]}),
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
  if (!parsed.success) return { answer: errorAnswer('start_run', schemaErrors('start_run', parsed.error, args)) };
  let answer: Answer;
  let text: TextContext = {};
  if (deps.runsDetail !== undefined) {
    const detail = await deps.runsDetail.startRunDetailed(call.principal, parsed.data, call.context);
    const record = recordReference(detail.runRecord);
    answer = { ...detail.answer, ...(record === null ? {} : { record }) } as Answer;
    const named = (answer.result as { reference?: unknown } | undefined)?.reference;
    text = {
      record,
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
  if (answer.call_result === 'ok') {
    try {
      const accepted = await step('list-packs', () => acceptedBy(deps, call.principal, answer));
      if (accepted.length > 0) answer = { ...answer, accepted_by: accepted };
    } catch (error) {
      call.context.adminNote(`start_run: the packs accepting the read sources were not listed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000));
    }
    // The tools/ files of the very version this run froze (script-distribution, step 2), as an answer-level fact: the run
    // record never changes. The frozen pack_digest is the authority; a pack that cannot be loaded again leaves the fact out.
    const summary = answer.run as { pack?: unknown; pack_digest?: unknown } | undefined;
    if (typeof summary?.pack === 'string' && isSha256(summary.pack_digest)) {
      try {
        const loaded = await step('load-workflow', () => deps.workflows.forUser(call.principal, summary.pack as string));
        if (loaded !== null && loaded.pack.digest === summary.pack_digest) {
          const tools = localToolsOf({ id: loaded.pack.id, version: loaded.pack.version, digest: loaded.pack.digest, manifest: loaded.manifest });
          if (tools !== null) answer = { ...answer, local_tools: tools };
        }
      } catch (error) {
        call.context.adminNote(`start_run: the local tools of ${summary.pack} were not listed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000));
      }
    }
  }
  return { answer, text };
};

/**
 * The inputs of the reader's packs that accept the type of a source the run read (decision 113): the type is `system:kind`
 * of the external object, compared by exact equality with each input's declared accepts; nothing is matched by wording.
 */
export async function acceptedBy(deps: Pick<ServerDeps, 'workflows'>, principal: Principal, answer: Answer): Promise<Array<{ type: string; inputs: Array<{ pack: string; slot: string; role: PackSummary['inputs'][number]['role'] }> }>> {
  const sources = (answer.run as { sources?: ReadonlyArray<{ external?: unknown }> } | undefined)?.sources ?? [];
  const types = [...new Set(sources.flatMap((s) => typeof s.external === 'string' && ExternalObjectId.safeParse(s.external).success ? [s.external.slice(0, s.external.indexOf(':', s.external.indexOf(':') + 1))] : []))];
  if (types.length === 0) return [];
  const packs = await deps.workflows.summaries(principal);
  return types.flatMap((type) => {
    const inputs = packs.flatMap((p) => p.inputs.filter((i) => i.accepts.includes(type)).map((i) => ({ pack: p.pack, slot: i.slot, role: i.role })));
    return inputs.length > 0 ? [{ type, inputs }] : [];
  });
}

const resolveTool: Handler = async (deps, call, args) => {
  checkReadCancellation(call);
  const parsed = ResolveReferenceInput.safeParse(args);
  if (!parsed.success) return { answer: errorAnswer('resolve_reference', schemaErrors('resolve_reference', parsed.error, args)) };
  call.state.runId = parsed.data.run ?? null;
  const answer = await deps.runs.resolveReference(call.principal, parsed.data, call.context);
  checkReadCancellation(call);
  return { answer: answer as Answer };
};

/**
 * submit_result passes the raw arguments: the runs package stores them as received before anything checks them (W07). An
 * answer that carries a result (accepted or not) names its stored record, looked up by the submission digest.
 */
const submitResult: Handler = async (deps, call, args) => {
  const run = args.run;
  if (typeof run === 'string' && RunId.safeParse(run).success) call.state.runId = run;
  const answer = { ...((await deps.runs.submitResult(call.principal, args, call.context)) as Answer) };
  const record = await storedResult(deps, call, answer);
  return { answer: { ...answer, ...(record === null ? {} : { record }) }, text: { record } };
};

/** rec:<digest> of the validation result record an answer carries, or null (no result, or no record of it). */
async function storedResult(deps: ServerDeps, call: ToolCall, answer: Answer): Promise<string | null> {
  const result = answer.result as { run?: unknown; submission?: unknown } | undefined;
  if (deps.runsDetail === undefined || typeof result?.run !== 'string' || typeof result.submission !== 'string') return null;
  for(let attempt=1;attempt<=2;attempt++) {
    try {
      const stored=await deps.runsDetail.getResult(call.principal,result.run,result.submission);
      if(stored!==null){if(stored.grounds_withdrawn?.length)answer.withdrawn_grounds=stored.grounds_withdrawn;if(stored.grounds_withdrawn_hidden_count)answer.withdrawn_grounds_hidden_count=stored.grounds_withdrawn_hidden_count;return recordReference(stored.record);}
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
  if (!parsed.success) return { answer: errorAnswer('get_nodes', schemaErrors('get_nodes', parsed.error, args)) };
  const input = parsed.data;
  if (input.observability !== undefined) {
    const query = input.observability;
    if ('trace' in query) {
      if (!call.context.traces) return { answer: errorAnswer('get_nodes', [unavailable()]) };
      const detail = await call.context.traces.show(call.principal, query.trace, { origin: 'mcp', limit: 200 });
      const trace = detail === null ? null : { trace_id: detail.trace_id, roots: detail.roots.map(observedStep), truncated: detail.truncated };
      return { answer: { call_result: 'ok', errors: [], observability: { trace } } };
    }
    const { user, session, tool, run, trace, from, to, cursor, limit } = query.calls;
    try {
      decodeCursor(cursor);
    } catch (error) {
      if (!(error instanceof RecordsError)) throw error;
      return { answer: errorAnswer('get_nodes', [violation('get_nodes', '/observability/calls/cursor', '继续令牌无效', '从第一页重新读取')]) };
    }
    const page = await deps.records.callLog.query(call.principal, {
      userId: user, sessionId: session, tool, runId: run, traceId: trace, from, to, cursor, limit,
    });
    return { answer: { call_result: 'ok', errors: [], observability: { calls: page.items.map(observedCall), next: page.next } } };
  }
  if(input.memory){
    if(!deps.knowledge.memory)return {answer:errorAnswer('get_nodes',[unavailable()])};
    try{return {answer:{call_result:'ok',errors:[],...await deps.knowledge.memory.query(call.principal,input.memory)}};}
    catch(error){if(error instanceof KnowledgeError&&error.code)return {answer:errorAnswer('get_nodes',[{code:error.code,message:knowledgeMessage(error),fix:error.fix!}])};throw error;}
  }
  const note = call.context.adminNote;
  if(input.call_query!==undefined){
    const mixed=(['pack','pack_space','file','space','search','scope','run','root','paths','depth','reference','cursor'] as const).find(key=>input[key]!==undefined);
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
  if(input.pack!==undefined){
    if(input.run!==undefined||input.search!==undefined||input.reference!==undefined||input.root!==undefined||input.paths!==undefined||input.depth!==undefined||input.space!==undefined||input.scope!==undefined)return {answer:errorAnswer('get_nodes',[violation('get_nodes','/pack','读取工作流或通用技能文件时只给 pack、pack_space、file 与 cursor')])};
    const space=input.pack_space??'team';
    if (space === 'team' && (input.pack === observabilitySkill.id || input.pack === observabilitySkill.pack)) {
      if (input.cursor !== undefined) return { answer: errorAnswer('get_nodes', [violation('get_nodes', '/cursor', '内置技能文件一次读完')]) };
      const skill_file = observabilitySkillFile(input.file);
      return skill_file === null
        ? { answer: errorAnswer('get_nodes', [unavailable()]) }
        : { answer: { call_result: 'ok', errors: [], skill_file } };
    }
    if (!deps.registry) return { answer: errorAnswer('get_nodes', [unavailable()]) };
    const info=space==='team'?await deps.registry.resolve(input.pack):await deps.registry.personal?.resolve(call.principal,space,input.pack);
    const visible=(await deps.packs.list(call.principal)).some(row=>(row.space??'team')===space&&row.id===info?.id&&row.version===info?.version&&!row.withdrawn);
    if(!info||!visible||info.kind!=='workflow'&&info.kind!=='skill')return {answer:errorAnswer('get_nodes',[unavailable()])};
    const file=info.manifest.files.find(row=>row.path===(input.file??'SKILL.md'));if(!file)return {answer:errorAnswer('get_nodes',[unavailable()])};
    if(space==='team'){
      const opened=await deps.registry.open(info.digest);if(!opened)return {answer:errorAnswer('get_nodes',[unavailable()])};
      await deps.records.artifacts.ingest({bytes:readFileSync(join(opened.handle.directory,file.path)),mediaType:mediaTypeFor(readFileSync(join(opened.handle.directory,file.path)),undefined,file.path),origin:{generated:{generator:'pack-file@1',inputs:['rec:'+info.record]}},author:{user:null},provenanceType:'projected',visibility:{readers:[call.principal.id],admins:true,packs:info.kind==='workflow'?[info.id]:[],shareable:false}});
    }
    return readReference(deps,call,'src:'+file.sha256,undefined,input.cursor??null);
  }
  if(input.pack_space!==undefined||input.file!==undefined)return {answer:errorAnswer('get_nodes',[violation('get_nodes','/pack','pack_space 与 file 需要 pack')])};
  if(input.run!==undefined)call.state.runId=input.run;
  if(input.scope!==undefined&&input.search===undefined)return {answer:errorAnswer('get_nodes',[violation('get_nodes','/scope','搜索范围只与 search 一起使用')])};
  if(input.search!==undefined){
    if(input.run!==undefined)return {answer:errorAnswer('get_nodes',[{code:'SPACE_SEARCH_IN_RUN',message:PROTOCOL_CODES.SPACE_SEARCH_IN_RUN.when,fix:PROTOCOL_CODES.SPACE_SEARCH_IN_RUN.fix}])};
    if(input.reference!==undefined||input.root!==undefined||input.paths!==undefined||input.depth!==undefined||input.space!==undefined)return {answer:errorAnswer('get_nodes',[violation('get_nodes','/search','搜索只接受 search、scope 与 cursor')])};
    if(!deps.knowledge.spaces)return {answer:errorAnswer('get_nodes',[unavailable()])};
    try{return {answer:{call_result:'ok',errors:[],...await deps.knowledge.spaces.search(call.principal,input.search,input.scope??'all',input.cursor??null)}}}
    catch(error){if(error instanceof KnowledgeError&&error.code)return {answer:errorAnswer('get_nodes',[{code:error.code,message:knowledgeMessage(error),fix:error.fix!}])};throw error;}
  }
  // An empty cursor is no cursor (a model may fill an optional string with ''), for a reference as for a subtree.
  const cursor = input.cursor === undefined || input.cursor === '' ? null : input.cursor;
  if (input.run !== undefined) call.state.runId = input.run;
  const runDetail = async (run: string) => {
    const detail = await deps.runs.getRun(call.principal, run);
    if (detail === null) note(`run ${run} is absent or not visible to ${call.principal.id}`);
    return detail;
  };
  // A run the caller cannot read: absent, or present and not theirs nor shared with them (D05 R[3]).
  const runMissing = async (run: string): Promise<ProtocolError> => {
    const found = deps.records?.store ? await deps.records.store.find({ key: 'runs.id', value: run, kind: 'run', limit: 1 }).catch(() => null) : null;
    if (found === null) return unavailable();
    // A run of another account's personal workflow stays neutral (D05 R[3]).
    const existence = await recordExistence(deps.records.store, call.principal.id, found.items[0] ?? null);
    if (existence === 'neutral') return unavailable();
    const exists = existence === 'exists';
    return missingObject(exists, `运行 ${run}`, exists ? '读你自己的运行，或请这个运行的运行者分享给你' : '核对运行号；运行号来自 start_run 的回答');
  };
  if (input.reference !== undefined) {
    // A cursor goes with the reference it pages (TextContext.cursor); a subtree read never mixes in.
    const mixed = (['root', 'paths', 'depth', 'space'] as const).filter((key) => input[key] !== undefined);
    if (mixed.length > 0) return { answer: errorAnswer('get_nodes', [violation('get_nodes', `/${mixed[0]}`, '按引用读取时不再给 root、paths 或 depth', READ_FIX)]) };
    if (input.run !== undefined && (await runDetail(input.run)) === null) return { answer: errorAnswer('get_nodes', [await runMissing(input.run)]) };
    return readReference(deps, call, input.reference, input.run, cursor);
  }
  let root = input.root;
  if(root===undefined&&input.run===undefined&&input.reference===undefined&&deps.knowledge.spaces){
    const space=input.space??call.principal.id;
    if(space===call.principal.id&&await deps.records.personalPayloads?.mode(call.principal.id)===SyncModeSchema.enum.local){
      if(cursor)return {answer:errorAnswer('get_nodes',[unavailable()])};
      return {answer:{call_result:'ok',errors:[],nodes:[],coverage:{complete:true,examined:0,total:0},next:null}};
    }
    const visible=await deps.knowledge.spaces.paths(call.principal,space);
    if(!visible.length)return {answer:errorAnswer('get_nodes',[unavailable()])};
    root=(space==='team'||space===call.principal.id?await deps.knowledge.spaces.ensure(call.principal,space):await deps.knowledge.spaces.current(space))?.root;
  }
  let composition: string | null | undefined;
  let feedingOffset:import('../../contracts/src/feeding.ts').FeedingOffset|undefined;
  if (input.run !== undefined) {
    const detail = await runDetail(input.run);
    if (detail === null) return { answer: errorAnswer('get_nodes', [await runMissing(input.run)]) };
    if(input.space!==undefined&&root===undefined&&deps.knowledge.spaces){
      const locks=detail.run.knowledge_spaces;
      if(input.space===call.principal.id&&locks?.owner===call.principal.id&&locks.personal===null&&!cursor)return {answer:{call_result:'ok',errors:[],nodes:[],coverage:{complete:true,examined:0,total:0},next:null}};
      root=input.space==='team'?locks?.team:input.space===locks?.owner?locks.personal??undefined:(await deps.knowledge.spaces.current(input.space))?.root;
      if(!root)return {answer:errorAnswer('get_nodes',[unavailable()])};
    }
    root ??= detail.run.root??detail.run.knowledge_spaces?.team;feedingOffset=detail.run.feeding_offset;
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
  if(input.space!==undefined&&deps.knowledge.spaces&&(await deps.knowledge.spaces.version(root))?.body.space!==input.space)return {answer:errorAnswer('get_nodes',[unavailable()])};
  for(let attempt=0;;attempt++) {
    try {
      page=await step('compute-view',()=>deps.knowledge.getNodes({root,run:input.run,feeding_offset:feedingOffset,paths:input.paths??['/'],depth:input.depth??1,cursor,...(composition!==undefined?{composition}:{})},call.principal),{type:'retriever'});
      break;
    } catch(error) {
      if(error instanceof IntegrityError) {
        note(`knowledge original integrity failed: ${describeError(error)}`);
        return {answer:errorAnswer('get_nodes',[{code:'SOURCE_INTEGRITY_UNPROVEN',message:'缺少经摘要核验的知识原件；请管理员从备份恢复后重读',fix:PROTOCOL_CODES.SOURCE_INTEGRITY_UNPROVEN.fix}])};
      }
      if(error instanceof KnowledgeError && error.code!==null) {
        return {answer:errorAnswer('get_nodes',[{code:error.code,message:knowledgeMessage(error),fix:error.fix!,...(typeof error.detail.path==='string'?{path:error.detail.path}:cursor?{path:'/cursor'}:{})}])};
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
    // Without a tree reader that can tell, the answer stays neutral; a probe is never a reason for an internal error.
    const probe = typeof deps.knowledge.treeReader === 'function' ? deps.knowledge.treeReader().rootExists : undefined;
    const exists = probe ? await Promise.resolve(probe(root)).catch(() => null) : null;
    return { answer: errorAnswer('get_nodes', [exists === null ? unavailable() : missingObject(exists, `知识树根 ${root}`, exists ? ROOT_FORBIDDEN_FIX : ROOT_ABSENT_FIX)]) };
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
    sources:{exists:sources.exists,read:async(hash,identity)=>{const original=deps.knowledge.spaces?await deps.knowledge.spaces.source(call.principal,hash,identity?.run,'function'):await sources.read(hash,identity);return original??await deps.registry?.personal?.source(call.principal,hash,identity?.run)??null;}},
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
  const spaceVersion=parsed.scheme==='tree'&&parsed.entry&&deps.knowledge.spaces?await deps.knowledge.spaces.version(parsed.root):null;
  const spaceEntry=spaceVersion&&parsed.scheme==='tree'&&parsed.entry?await deps.knowledge.spaces!.entry(call.principal,parsed.root,parsed.path,parsed.entry):null;
  if(spaceVersion&&parsed.scheme==='tree'&&!spaceEntry&&!spaceVersion.body.products.some(m=>parsed.path===m.path||parsed.path.startsWith(m.path+'/')))return {answer:errorAnswer('get_nodes',[unavailable()])};
  const spaceNote=spaceEntry?'状态 '+labelOf('knowledge_entry_status',spaceEntry.row.status)+(spaceEntry.grounds_withdrawn.length||spaceEntry.grounds_withdrawn_hidden_count?'；'+labelOf('validity_status','grounds_withdrawn'):'')+(spaceEntry.grounds_withdrawn_hidden_count?`；另有 ${spaceEntry.grounds_withdrawn_hidden_count} 项依据不可读取`:'')+(spaceEntry.body.grounds.length?'；已逐条核对引文与路径':'；未提供依据，内容未核验'):null;
  const recordView=parsed.scheme==='rec'?await deps.records.store.get(parsed.record):null;
  const resultView=recordView?.kind==='validation_result'&&deps.runs.resultState?await deps.runs.resultState(call.principal,recordView.body as import('../../contracts/src/validation.ts').ValidationResult):null;
  const groundsNote=resultView?.grounds_withdrawn?.length||resultView?.grounds_withdrawn_hidden_count?labelOf('validity_status','grounds_withdrawn')+(resultView?.grounds_withdrawn_hidden_count?`；另有 ${resultView.grounds_withdrawn_hidden_count} 项依据不可读取`:''):null;
  const derivedNote=[groundsNote,result.note,contributionNote,spaceNote,feedingState?.validity==='invalid'?'喂入根据已失效；撤回及来源修订记录：'+feedingState.retractions.join('、'):null].filter(Boolean).join('；');
  const content = {
    reference: result.reference,
    read_tier: result.readTier,
    readable: result.readable,
    ...(result.readable && result.text !== null && result.readTier === 'model_readable' ? { text: result.text } : {}),
    ...(parsed.scheme === 'src' ? { sha256: parsed.sha256 } : {}),
    ...(result.summary!==null||feedingState||spaceEntry||groundsNote?{structure:{...result.summary,...(groundsNote?{grounds_withdrawn:resultView?.grounds_withdrawn,...(resultView?.grounds_withdrawn_hidden_count?{grounds_withdrawn_hidden_count:resultView.grounds_withdrawn_hidden_count}:{})}:{}),...(feedingState?{feeding_state:feedingState}:{}),...(spaceEntry?{entry_status:spaceEntry.row.status,grounds:spaceEntry.body.grounds,grounds_withdrawn:spaceEntry.grounds_withdrawn,...(spaceEntry.grounds_withdrawn_hidden_count?{grounds_withdrawn_hidden_count:spaceEntry.grounds_withdrawn_hidden_count}:{}),data:spaceEntry.body.content.data,applicability:spaceEntry.body.content.applicability,...(spaceEntry.cited_count!==null?{cited_count:spaceEntry.cited_count}:{})}:{})}}:{}),
    ...(derivedNote?{note:derivedNote}:{}),
  };
  return { answer: { call_result: 'ok', errors: [], content,...(feedingReceipt?{feeding_objects:feedingReceipt.objects,feeding_pending:feedingReceipt.pending}:{}) }, text: { cursor } };
}

const HANDLERS: Record<ToolName, { run: Handler; cancellableRead: boolean }> = {
  list_task_packs: { run: listTaskPacks, cancellableRead: true },
  upload_file: { run: uploadFile, cancellableRead: false },
  start_run: { run: startRun, cancellableRead: false },
  get_nodes: { run: getNodes, cancellableRead: false },
  resolve_reference: { run: resolveTool, cancellableRead: true },
  submit_result: { run: submitResult, cancellableRead: false },
};

export function supportsReadCancellation(name: string): boolean {
  return isToolName(name) && HANDLERS[name].cancellableRead;
}

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
    reply = await HANDLERS[name].run(deps, call, args ?? {});
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
  let value = checked.data as Answer & { call_result: CallResult; errors: ProtocolError[]; acceptance?: Acceptance };
  call.state.callResult = value.call_result;
  call.state.acceptance = value.acceptance ?? null;
  call.state.errorCode = value.call_result === 'error' ? (value.errors[0]?.code ?? null) : null;
  const role: CallerRole = call.principal.role === 'admin' ? 'admin' : 'user';
  const accountName = call.principal.name;
  if (role === 'admin' && Array.isArray(value.errors) && value.errors.length > 0) {
    value = {
      ...value,
      errors: value.errors.map((error) => {
        const fix = fixByRole(error.code, 'admin', error.fix, accountName);
        return fix === undefined ? error : { ...error, fix };
      }),
    };
  }
  if (value.call_result === 'error' && Array.isArray(value.errors) && value.errors.length > 0) {
    const published = PUBLISHED.get(name);
    if (published !== undefined) {
      try {
        value = {
          ...value,
          errors: await escalateProtocolErrors({
            callLog: deps.records.callLog,
            userId: call.principal.id,
            tool: name,
            errors: value.errors,
            input: definition.input,
            inputSchema: published.inputSchema,
            runId: call.state.runId,
            visibleValues: args && Object.keys(args).length > 0 ? new Map(Object.entries(args)) : undefined,
          }),
        };
      } catch (error) {
        call.context.adminNote(`refusal escalation skipped: ${describeError(error)}`);
      }
    }
  }
  const context: TextContext = { ...reply.text, paging: PAGING, items: feedRun?.run.items, caller: { role, name: accountName } };
  let text: string;
  try {
    text = toolText(name, value, context);
  } catch (error) {
    // A valid answer (a run or a result may already be stored) is never lost to its text: a minimal one, the reason noted.
    call.context.adminNote(`the text of the ${name} answer could not be laid out: ${describeError(error)}`);
    text = fallbackText(name, value, context);
  }
  return {
    content: [
      { type: 'text', text },
      { type: 'text', text: modelReferencesText(value, context) },
    ],
    structuredContent: value,
    isError: value.call_result === 'error',
  };
}
