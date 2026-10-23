// Read-only distribution of author-published bytes, independently authorized on every request.
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PackManifest, packPathProblem } from '../../contracts/src/pack.ts';
import { canonicalBytes, sha256Hex, type CallLogInput, type Principal } from '../records/api.ts';
import { parsePackRef } from '../runs/packs/versions.ts';
import type { ServerDeps } from './api.ts';
import { setCommonHeaders } from './http.ts';
import { newTraceId } from './trace.ts';
const PREFIX = '/local-tools/';
const ABSENT = Buffer.from('没有这个本地工具版本或文件\n');
const UNAUTHENTICATED = Buffer.from('需要有效的 Bearer 令牌\n');
/** One verified open per user and version. Later requests in this window re-check assignment without extracting again. */
const DISTRIBUTION_REUSE_MS = 60_000;
const DISTRIBUTION_CACHE_MAX = 32;
type LoadedForDownload = NonNullable<Awaited<ReturnType<ServerDeps['workflows']['forUser']>>>;
const distributionCache = new Map<string, { at: number; loaded: LoadedForDownload }>();
const ABSENCE_NOTE = {
  unknown: '版本不存在',
  unassigned: '版本没有分配给这个用户',
  withdrawn: '版本已下架',
  disabled: '账号已停用',
} as const;

export function clearDistributionCache(): void {
  distributionCache.clear();
}

function rememberDistribution(key: string, loaded: LoadedForDownload): void {
  distributionCache.delete(key);
  distributionCache.set(key, { at: Date.now(), loaded });
  while (distributionCache.size > DISTRIBUTION_CACHE_MAX) {
    const oldest = distributionCache.keys().next().value;
    if (oldest === undefined) break;
    distributionCache.delete(oldest);
  }
}

async function openForDownload(deps: ServerDeps, principal: Principal, ref: string): Promise<LoadedForDownload | null> {
  const key = `${principal.id}\0${ref}`;
  const hit = distributionCache.get(key);
  const ask = deps.workflows.absence;
  if (hit !== undefined && ask !== undefined && Date.now() - hit.at < DISTRIBUTION_REUSE_MS) {
    const why = await ask(principal, ref);
    if (why === null) {
      hit.at = Date.now();
      return hit.loaded;
    }
    distributionCache.delete(key);
    return null;
  }
  const loaded = await deps.workflows.forUser(principal, ref);
  if (loaded !== null && ask !== undefined) rememberDistribution(key, loaded);
  return loaded;
}

async function absenceNote(deps: ServerDeps, principal: Principal, ref: string): Promise<string> {
  const ask = deps.workflows.absence;
  if (ask === undefined) return '版本不存在、未分配或已下架';
  const why = await ask(principal, ref);
  if (why === null) return '版本已发布并分配，但不能作为本地工具下发';
  return ABSENCE_NOTE[why];
}
export const digestHeader = (bytes: Uint8Array): string => `sha-256=:${Buffer.from(sha256Hex(bytes), 'hex').toString('base64')}:`;
export function localToolsTarget(target: string | undefined): boolean { return /^(?:http:\/\/[^/]+)?\/local-tools(?:[\/\\%]|$)/i.test(target ?? ''); }
function rawPath(target: string): string { return target.replace(/^http:\/\/[^/]+/i, ''); }
export async function readPublishedFile(directory: string, path: string): Promise<Buffer> {
  let current = directory;
  const root = await lstat(current); if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('integrity');
  const parts = path.split('/');
  for (const [i, part] of parts.entries()) {
    current = join(current, part); const info = await lstat(current);
    if (info.isSymbolicLink() || (i === parts.length - 1 ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())) throw new Error('integrity');
  }
  return readFile(current);
}
export async function handleLocalTools(request: IncomingMessage, response: ServerResponse, deps: ServerDeps, log: (line: string) => void): Promise<void> {
  const started = performance.now(); const raw = rawPath(request.url ?? ''); const rest = raw.slice(PREFIX.length); const slash = rest.indexOf('/');
  const ref = slash < 0 ? rest : rest.slice(0, slash); const path = slash < 0 ? '' : rest.slice(slash + 1);
  let principal: Principal | null = null; let status = 500; let bytes: Buffer = Buffer.from('Hub 内部错误\n'); let note = '内部错误'; let digest: string | null = null;
  const headers: Record<string, string> = {};
  request.resume();
  try {
    principal = await deps.records.principals.authenticate(typeof request.headers.authorization === 'string' ? request.headers.authorization : null);
    if (principal === null) { status = 401; bytes = UNAUTHENTICATED; note = '令牌不可用'; headers['www-authenticate'] = 'Bearer realm="circle-hub"'; }
    else if (request.method !== 'GET' && request.method !== 'HEAD') { status = 405; bytes = Buffer.from('只接受 GET 和 HEAD\n'); note = '方法不可用'; headers.allow = 'GET, HEAD'; }
    else {
      status = 404; bytes = ABSENT;
      const parsed = parsePackRef(ref);
      const pathShape = path === '' && slash < 0 || (path !== '' && packPathProblem(path) === null);
      if (!raw.startsWith(PREFIX)) note = '版本引用格式不对';
      else if (/[?%#\\]/.test(raw)) note = '路径含编码分隔符或保留字符';
      else if (!parsed?.version) note = '版本引用格式不对';
      else if (path.split('/').includes('..')) note = '路径含 ..';
      else if (!pathShape) note = '路径不在包内文件的形状里';
      else {
        const loaded = await openForDownload(deps, principal, ref);
        if (loaded && loaded.manifest.files.some((file) => file.path.startsWith('tools/'))) {
          digest = loaded.pack.digest;
          const manifest = PackManifest.parse(loaded.manifest); const canonical = Buffer.from(canonicalBytes(manifest));
          if (sha256Hex(canonical) !== digest) throw new Error('integrity');
          const entry = path === '' ? null : manifest.files.find((file) => file.path === path);
          if (path === '' || entry) {
            const original = await readPublishedFile(loaded.pack.directory, path || 'pack.json');
            if (entry ? original.length !== entry.size || sha256Hex(original) !== entry.sha256 : !original.equals(canonical)) throw new Error('integrity');
            status = 200; bytes = original; note = '原字节已核对';
            headers['content-digest'] = digestHeader(bytes); headers.etag = `"${sha256Hex(bytes)}"`;
            headers['content-type'] = path === '' ? 'application/json' : 'application/octet-stream';
          } else note = '清单外路径';
        } else if (loaded) note = '这个版本没有本地工具';
        else note = await absenceNote(deps, principal, ref);
      }
    }
  } catch { status = 500; bytes = Buffer.from('Hub 内部错误\n'); note = '存储被改动过或读取失败'; log('本地工具出口：存储被改动过或读取失败'); }
  const input: CallLogInput = { ...(deps.now ? { at: deps.now() } : {}), traceId: newTraceId(), userId: principal?.id ?? null, sessionId: null, tool: 'local-tools', runId: null, arguments: { pack: { digest, sha256: sha256Hex(ref), length: Buffer.byteLength(ref) }, path: { sha256: sha256Hex(path), length: Buffer.byteLength(path) } }, callResult: status === 200 ? 'ok' : 'error', acceptance: null, errorCode: null, durationMs: Math.max(0, performance.now() - started), adminNote: note };
  try { await deps.records.callLog.append(input); } catch { log('本地工具出口：调用日志写入失败'); }
  setCommonHeaders(response); response.statusCode = status;
  response.setHeader('cache-control', 'no-store'); response.setHeader('content-type', 'text/plain; charset=utf-8');
  for (const [key, value] of Object.entries(headers)) response.setHeader(key, value);
  response.setHeader('content-length', bytes.length); response.end(request.method === 'HEAD' ? undefined : bytes);
}
