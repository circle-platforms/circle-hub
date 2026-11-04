// A request's entry in the in-flight log (hub/health): opened at the HTTP entry, for every request, and completed by MCP
// once it knows the caller and the tool. The name is a route, never a value: a console login link carries its secret in the
// path, so a path is kept only up to its first segment that is not a plain lowercase word, and never its query.
import type { IncomingMessage } from 'node:http';
import type { RequestEnd, RequestInfo, RequestLog } from '../health/api.ts';
import { personalSyncTarget } from './personal-sync.ts';
import { traceIdFrom } from './trace.ts';

/** A stream stays open for as long as a page does and does no work of its own: it is counted as a stream, not a request. */
const STREAM_PATH = '/console/api/stream';
const WORD = /^[a-z][a-z-]{0,31}$/;
const KEPT_SEGMENTS = 3;
const METHOD = /^[A-Z]{1,10}$/;

const entries = new WeakMap<IncomingMessage, RequestEnd>();

/** Where a request enters, as its trace says it (B08): MCP and sync by their paths, everything else the console's web surface. */
function originOf(path: string | null): string {
  if (path === '/mcp') return 'mcp';
  return path !== null && personalSyncTarget(path) ? 'sync' : 'console';
}

function routeOf(path: string | null): string {
  if (path === null) return '';
  const kept: string[] = [];
  for (const segment of path.split('/').slice(1, KEPT_SEGMENTS + 1)) {
    if (!WORD.test(segment)) break;
    kept.push(segment);
  }
  return `/${kept.join('/')}`;
}

function infoOf(request: IncomingMessage, path: string | null): RequestInfo {
  const method = METHOD.test(request.method ?? '') ? request.method : '?';
  return { traceId: traceIdFrom(request.headers.traceparent), origin: originOf(path), name: `${method} ${routeOf(path)}`.trimEnd(), userId: null };
}

/** Opens the request's entry and returns what ends it; `path` is the parsed target's path, null for a target that is neither. */
export function beginRequest(log: RequestLog | undefined, request: IncomingMessage, path: string | null): () => void {
  if (log === undefined || path === STREAM_PATH) return () => {};
  const end = log.begin(infoOf(request, path));
  entries.set(request, end);
  return end;
}

/** Adds what became known after the request began. No request log, no effect. */
export function identifyRequest(request: IncomingMessage, known: Parameters<RequestEnd['identify']>[0]): void {
  entries.get(request)?.identify(known);
}
