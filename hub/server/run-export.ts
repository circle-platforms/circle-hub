// Decision 104: a client generates its artifacts from its own run without an administrator export, independently authorized on
// every request with the same token as MCP. GET /run-export/<run> answers the run, its latest accepted result and that result's
// submission as stored (runner and administrators only); GET /run-export/<run>/sources/<sha256> answers the original bytes of one
// source bound to that run, at the reader's readable tier.
import { performance } from 'node:perf_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RunId } from '../../contracts/src/common.ts';
import { canonicalBytes, sha256Hex, type CallLogInput, type Principal } from '../records/api.ts';
import type { ServerDeps } from './api.ts';
import { setCommonHeaders } from './http.ts';
import { digestHeader } from './local-tools.ts';
import { newTraceId } from './trace.ts';

const PREFIX = '/run-export/';
const ABSENT = Buffer.from('没有这个运行或原件，或它不是你的运行\n');
const UNAUTHENTICATED = Buffer.from('需要有效的 Bearer 令牌\n');
export function runExportTarget(target: string | undefined): boolean { return /^(?:http:\/\/[^/]+)?\/run-export(?:[\/\\%]|$)/i.test(target ?? ''); }

export async function handleRunExport(request: IncomingMessage, response: ServerResponse, deps: ServerDeps, log: (line: string) => void): Promise<void> {
  const started = performance.now(); const raw = (request.url ?? '').replace(/^http:\/\/[^/]+/i, '');
  const parts = raw.startsWith(PREFIX) ? raw.slice(PREFIX.length).split('/') : [];
  const run = parts[0] ?? ''; const sha = parts.length === 3 && parts[1] === 'sources' ? parts[2] : null;
  let principal: Principal | null = null; let status = 500; let bytes: Buffer = Buffer.from('Hub 内部错误\n'); let note = '内部错误';
  const headers: Record<string, string> = { 'content-type': 'text/plain; charset=utf-8' };
  request.resume();
  try {
    principal = await deps.records.principals.authenticate(typeof request.headers.authorization === 'string' ? request.headers.authorization : null);
    if (principal === null) { status = 401; bytes = UNAUTHENTICATED; note = '令牌不可用'; headers['www-authenticate'] = 'Bearer realm="circle-hub"'; }
    else if (request.method !== 'GET' && request.method !== 'HEAD') { status = 405; bytes = Buffer.from('只接受 GET 和 HEAD\n'); note = '方法不可用'; headers.allow = 'GET, HEAD'; }
    else if (/[?%#\\]/.test(raw) || !RunId.safeParse(run).success || !(parts.length === 1 || sha !== null && /^[0-9a-f]{64}$/.test(sha))) { status = 404; bytes = ABSENT; note = '路径形状不对'; }
    else {
      status = 404; bytes = ABSENT; note = '运行不可见';
      const exported = await deps.runs.exportRun?.(principal, run) ?? null;
      if (exported && sha === null) {
        if (!exported.result || exported.submission === null) { status = 409; bytes = Buffer.from('这个运行还没有已受理的提交；按回执改正并重交，被受理后再导出\n'); note = '没有已受理结果'; }
        else { status = 200; bytes = Buffer.from(canonicalBytes({ schema: 'run-export@1', run: exported.run, result: exported.result, submission: exported.submission })); note = '运行与已受理结果'; headers['content-type'] = 'application/json'; headers['content-digest'] = digestHeader(bytes); }
      } else if (exported && sha !== null) {
        const source = await deps.records.artifacts.sourceForRun(principal, sha, run);
        if (!source) note = '原件没有绑定在这个运行上';
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
