// Decision 104: a client generates its artifacts from its own run without an administrator export, independently authorized on
// every request with the same token as MCP. GET /run-export/<run>/run answers the run alone. GET /run-export/<run> answers the run, its latest accepted result and that result's
// submission as stored (runner and administrators only); GET /run-export/<run>/sources/<sha256> answers the original bytes of one
// source bound to that run, at the reader's readable tier. Decision 160 (relay): GET /run-export/<run>/jobs answers the jobs the
// run was dispatched in with each item's verdict, and the sources route also answers what those jobs returned (the result
// projection, the device return, each failed item's log and sessions), at the reader's readable tier. Decision 162: GET
// /run-export/<run>/successors answers the runs started with that run as predecessor that the reader may export, reduced to
// pack, start, parameters and bound references, so a client tool walks a lineage instead of trusting a list of runs.
// Decision 179 (W06 R[7]): GET /run-export/<run>/late answers run-late@1, the inputs the run binds after the start resolved now
// for the runner and the overlay of each item the workflow's refresh function computed from them, as an evaluation now would;
// nothing is stored and no submission lock is taken. A run that binds nothing after the start answers 404 and says so.
// Decision 182 (W06 R[8]): GET /run-export/<run>/history answers run-history@1, the earlier runs that verified the same subject
// on a target and that the reader may export (the rule of every route here, asked of each run listed), newest first, at most
// eight; `?limit=<1-8>` lowers that and is the only query any route here takes. Recorded facts only: the run, its locked build,
// and for each job that took effect the plan run, when its journal ended and each report row's item and verdict. A run nothing
// earlier verified answers an empty list.
// K05 and D06 R[2] (lock the root, fetch the subtree, verify the references at delivery): GET /run-export/<run>/knowledge answers
// the product root the run locked as one batch, every node to the leaves as a subtree read shows it to this reader, one JSON
// line each after a head line. The client keeps it by its digest and reads it locally; in run 21 a model read the same
// immutable root through 126 paged calls, 97 of them command-tree subtrees. Each entry also carries its source `fragments` (what a
// reference read gives as `grounds`): the tree records no document order, so that is where a client finds an entry's place in its source.
import { performance } from 'node:perf_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RunId } from '../../contracts/src/common.ts';
import { RUN_HISTORY_MAX_RUNS } from '../../contracts/src/run.ts';
import { canonicalBytes, sha256Hex, type CallLogInput, type Principal } from '../records/api.ts';
import type { ServerDeps } from './api.ts';
import { authenticateAccessOnly, CONSOLE_SESSION_REFUSED } from './access-auth.ts';
import { setCommonHeaders } from './http.ts';
import { digestHeader } from './local-tools.ts';
import { newTraceId } from './trace.ts';

const PREFIX = '/run-export/';
const ABSENT = Buffer.from('没有这个运行或原件，或它不是你的运行\n');
const UNAUTHENTICATED = Buffer.from('需要有效的 Bearer 令牌\n');
const CONSOLE_REFUSED = Buffer.from(CONSOLE_SESSION_REFUSED + '\n');
export function runExportTarget(target: string | undefined): boolean { return /^(?:http:\/\/[^/]+)?\/run-export(?:[\/\\%]|$)/i.test(target ?? ''); }

/** Runs whose produced digests one process keeps. */
const PRODUCED_RUNS = 64;
/** The digests each run's jobs returned, by the runs service that listed them. What a job returned is only appended, so a
 * digest found once stays found: a client that downloads every log and session of a run lists its jobs once, not once per
 * file (run 16 downloaded 80 files of one run, each reading every dispatch reservation of the Hub again). A digest not found
 * lists the jobs again, since a job may have ended since. */
const producedBy = new WeakMap<object, Map<string, Set<string>>>();
/** What one of the run's jobs returned, when sha names it: read at the reader's own tier, as any source of theirs. The caller
 * has already checked that the reader may export the run. */
async function jobOutput(deps: ServerDeps, principal: Principal, run: string, sha: string) {
  let runs = producedBy.get(deps.runs);
  if (!runs) producedBy.set(deps.runs, runs = new Map());
  if (!runs.get(run)?.has(sha)) {
    const listed = await deps.runs.exportJobs?.(principal, run) ?? null;
    if (!listed) return null;
    const digests = new Set<string>();
    for (const job of listed.jobs) for (const reference of [job.result, job.device_return, ...(job.rows ?? []).flatMap((row) => [row.evidence?.log, ...Object.values(row.evidence?.sessions ?? {})])]) {
      const found = typeof reference === 'string' ? /^src:([0-9a-f]{64})$/.exec(reference) : null;
      if (found) digests.add(found[1]);
    }
    runs.delete(run); runs.set(run, digests);
    for (const key of runs.keys()) { if (runs.size <= PRODUCED_RUNS) break; runs.delete(key); }
  }
  return runs.get(run)?.has(sha) ? deps.records.artifacts.source(principal, sha) : null;
}

/** Roots whose batch read one process keeps: under a digest the content does not change (K05 R[0]). */
const KNOWLEDGE_KEPT = 2;
const knowledgeKept = new WeakMap<object, Map<string, { body: Buffer; nodes: number; entries: number }>>();
/** The product root the run locked, as one batch for this reader; null when the run locked none or the reader may not read it. */
async function lockedKnowledge(deps: ServerDeps, principal: Principal, run: { run: string; root?: string | null; target_basis?: ReadonlyArray<{ statement: { data?: Record<string, unknown> | null } }> }): Promise<Buffer | null> {
  const root = run.root;
  if (typeof root !== 'string' || !deps.knowledge?.subtree) return null;
  // The composition the run locked for this root, chosen as a subtree read of the run chooses it.
  const ids = (run.target_basis ?? []).flatMap((claim) => { const data = claim.statement.data; return data && data.root === root && typeof data.composition === 'string' ? [data.composition] : []; });
  const composition = new Set(ids).size === 1 ? ids[0] : null;
  let kept = knowledgeKept.get(deps.knowledge);
  if (!kept) knowledgeKept.set(deps.knowledge, kept = new Map());
  const key = `${root}\u0000${composition ?? ''}`;
  let found = kept.get(key);
  // What is kept is the same for every reader of the root; whether this reader may read the root is asked every time.
  const mayRead = deps.knowledge.treeReader().hasRoot;
  if (found && mayRead) { if (!(await mayRead(root, { user: principal.id, role: principal.role }))) return null; }
  else {
    const nodes = await deps.knowledge.subtree({ root, composition }, principal);
    if (nodes === null) return null;
    const lines: string[] = []; let entries = 0;
    for (const node of nodes) { entries += node.entries.length; lines.push(JSON.stringify(node)); }
    found = { body: Buffer.from(lines.length ? lines.join('\n') + '\n' : ''), nodes: nodes.length, entries };
    kept.delete(key); kept.set(key, found);
    for (const oldest of kept.keys()) { if (kept.size <= KNOWLEDGE_KEPT) break; kept.delete(oldest); }
  }
  return Buffer.concat([Buffer.from(JSON.stringify({ schema: 'run-knowledge@1', run: run.run, root, composition, nodes: found.nodes, entries: found.entries }) + '\n'), found.body]);
}

export async function handleRunExport(request: IncomingMessage, response: ServerResponse, deps: ServerDeps, log: (line: string) => void): Promise<void> {
  const started = performance.now(); const raw = (request.url ?? '').replace(/^http:\/\/[^/]+/i, '');
  // The history route alone takes a query, and only `limit`; `limit` is null when the query is anything else.
  const queried = /^([^?#]*\/history)\?(.*)$/.exec(raw);
  const path = queried ? queried[1] : raw;
  const limit = queried ? (/^limit=([1-8])$/.exec(queried[2])?.[1] ?? null) : undefined;
  const parts = path.startsWith(PREFIX) ? path.slice(PREFIX.length).split('/') : [];
  const run = parts[0] ?? ''; const sha = parts.length === 3 && parts[1] === 'sources' ? parts[2] : null;
  const runOnly = parts.length === 2 && parts[1] === 'run';
  const jobsOnly = parts.length === 2 && parts[1] === 'jobs';
  const successorsOnly = parts.length === 2 && parts[1] === 'successors';
  const knowledgeOnly = parts.length === 2 && parts[1] === 'knowledge';
  const lateOnly = parts.length === 2 && parts[1] === 'late';
  const historyOnly = parts.length === 2 && parts[1] === 'history';
  let principal: Principal | null = null; let status = 500; let bytes: Buffer = Buffer.from('Hub 内部错误\n'); let note = '内部错误';
  const headers: Record<string, string> = { 'content-type': 'text/plain; charset=utf-8' };
  request.resume();
  try {
    const access = await authenticateAccessOnly(deps.records.principals, typeof request.headers.authorization === 'string' ? request.headers.authorization : null);
    if (!access.ok) {
      if (access.reason === 'console_session') { status = 403; bytes = CONSOLE_REFUSED; note = '控制台会话令牌'; }
      else { status = 401; bytes = UNAUTHENTICATED; note = '令牌不可用'; headers['www-authenticate'] = 'Bearer realm="circle-hub"'; }
    } else if ((principal = access.principal) && request.method !== 'GET' && request.method !== 'HEAD') { status = 405; bytes = Buffer.from('只接受 GET 和 HEAD\n'); note = '方法不可用'; headers.allow = 'GET, HEAD'; }
    else if (/[?%#\\]/.test(path) || !RunId.safeParse(run).success || !(parts.length === 1 || runOnly || jobsOnly || successorsOnly || knowledgeOnly || lateOnly || historyOnly || sha !== null && /^[0-9a-f]{64}$/.test(sha))) { status = 404; bytes = ABSENT; note = '路径形状不对'; }
    else if (historyOnly && limit === null) { status = 400; bytes = Buffer.from(`这个地址只接受查询参数 limit，取 1 到 ${RUN_HISTORY_MAX_RUNS} 的整数\n`); note = '查询参数不对'; }
    else if (historyOnly) {
      status = 404; bytes = ABSENT; note = '运行不可见';
      const answer = await deps.runs.exportHistory?.(principal, run, limit === undefined ? {} : { limit: Number(limit) }) ?? null;
      if (answer !== null) { status = 200; bytes = Buffer.from(canonicalBytes(answer)); note = `同一判定对象此前的上机验证 ${answer.runs.length} 个运行`; headers['content-type'] = 'application/json'; headers['content-digest'] = digestHeader(bytes); }
    }
    else if (lateOnly) {
      status = 404; bytes = ABSENT; note = '运行不可见';
      const answer = await deps.runs.exportLate?.(principal, run) ?? null;
      if (answer !== null && !answer.ok) { bytes = Buffer.from('运行没有开运行后再绑定的输入（工作流没有声明，或开运行时给的是已受理结果的 rec: 引用，已冻结）；运行和已受理结果用 /run-export/<运行> 导出\n'); note = '运行没有开运行后再绑定的输入'; }
      else if (answer !== null) { status = 200; bytes = Buffer.from(canonicalBytes(answer.body)); note = '开运行后再绑定的输入'; headers['content-type'] = 'application/json'; headers['content-digest'] = digestHeader(bytes); }
    }
    else {
      status = 404; bytes = ABSENT; note = '运行不可见';
      const exported = await deps.runs.exportRun?.(principal, run) ?? null;
      if (exported && jobsOnly) {
        const listed = await deps.runs.exportJobs?.(principal, run) ?? null;
        if (listed) { status = 200; bytes = Buffer.from(canonicalBytes({ schema: 'run-jobs@1', run, jobs: listed.jobs })); note = '运行的作业'; headers['content-type'] = 'application/json'; headers['content-digest'] = digestHeader(bytes); }
        else note = '作业不可读';
      } else if (exported && successorsOnly) {
        const listed = await deps.runs.exportSuccessors?.(principal, run) ?? null;
        if (listed) { status = 200; bytes = Buffer.from(canonicalBytes({ schema: 'run-successors@1', run, successors: listed.successors })); note = '运行的后继'; headers['content-type'] = 'application/json'; headers['content-digest'] = digestHeader(bytes); }
        else note = '后继不可读';
      } else if (exported && knowledgeOnly) {
        const batch = await lockedKnowledge(deps, principal, exported.run);
        if (batch) { status = 200; bytes = batch; note = '运行锁定的知识根'; headers['content-type'] = 'application/x-ndjson; charset=utf-8'; headers['content-digest'] = digestHeader(bytes); headers.etag = `"${sha256Hex(bytes)}"`; }
        else note = '运行没有锁定知识根，或读者读不到它';
      } else if (exported && sha === null) {
        // The run alone, before anything is accepted: a client tool needs the frozen items to prepare the first submission.
        if (runOnly) { status = 200; bytes = Buffer.from(canonicalBytes({ schema: 'run-export@1', run_reference: exported.run_reference, run: exported.run })); note = '运行'; headers['content-type'] = 'application/json'; }
        else if (!exported.result || exported.submission === null) { status = 409; bytes = Buffer.from('这个运行还没有已受理的提交；按回执改正并重交，被受理后再导出\n'); note = '没有已受理结果'; }
        else { status = 200; bytes = Buffer.from(canonicalBytes({ schema: 'run-export@1', run_reference: exported.run_reference, accepted_result_reference: exported.accepted_result_reference, run: exported.run, result: exported.result, submission: exported.submission })); note = '运行与已受理结果'; headers['content-type'] = 'application/json'; headers['content-digest'] = digestHeader(bytes); }
      } else if (exported && sha !== null) {
        const source = await deps.records.artifacts.sourceForRun(principal, sha, run) ?? await jobOutput(deps, principal, run, sha);
        if (!source) note = '原件没有绑定在这个运行上，也不是它的作业产出';
        else if (!source.bytes) { status = 403; bytes = Buffer.from('这份原件在你的读取层级不给字节\n'); note = '读取层级不给字节'; }
        else if (sha256Hex(source.bytes) !== sha) throw new Error('integrity');
        else { status = 200; bytes = Buffer.from(source.bytes); note = '原字节已核对'; headers['content-type'] = 'application/octet-stream'; headers['content-digest'] = digestHeader(bytes); headers.etag = `"${sha}"`; }
      }
    }
  } catch { status = 500; bytes = Buffer.from('Hub 内部错误\n'); note = '存储被改动过或读取失败'; log('运行导出：存储被改动过或读取失败'); }
  const input: CallLogInput = { ...(deps.now ? { at: deps.now() } : {}), traceId: newTraceId(), userId: principal?.id ?? null, sessionId: null, tool: 'run-export', runId: RunId.safeParse(run).success ? run : null, arguments: { run: { sha256: sha256Hex(run), length: Buffer.byteLength(run) }, ...(sha ? { source: { sha256: sha } } : {}) }, callResult: status === 200 ? 'ok' : 'error', acceptance: null, errorCode: null, durationMs: Math.max(0, performance.now() - started), adminNote: note };
  try { await deps.records.callLog.append(input); } catch { log('运行导出：调用日志写入失败'); }
  setCommonHeaders(response); response.statusCode = status;
  response.setHeader('cache-control', 'no-store');
  for (const [key, value] of Object.entries(headers)) response.setHeader(key, value);
  response.setHeader('content-length', bytes.length); response.end(request.method === 'HEAD' ? undefined : bytes);
}
