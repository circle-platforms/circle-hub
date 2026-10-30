// HTTP plumbing shared by the MCP endpoint, the console and /healthz: the Host and Origin checks against DNS rebinding,
// bounded body reading and response helpers with the security headers. Nothing here knows about tools or pages.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isLoopbackAddress } from '../config/index.ts';

/** Host header values the server answers to: 127.0.0.1:<port> and localhost:<port> (and the listen address when it differs). */
export function allowedHosts(listenHost: string, port: number, declared: readonly string[] = []): Set<string> {
  const hosts = isLoopbackAddress(listenHost) ? new Set([`127.0.0.1:${port}`, `localhost:${port}`]) : new Set<string>();
  if (listenHost === '::1') hosts.add(`[::1]:${port}`);
  else if (listenHost !== '127.0.0.1' && isLoopbackAddress(listenHost)) hosts.add(`${listenHost}:${port}`);
  for (const name of declared) hosts.add(`${name}:${port}`);
  if (port === 80) for (const host of [...hosts]) hosts.add(host.slice(0, host.lastIndexOf(':')));
  return hosts;
}

/** The origins of this server itself, for the console's own forms. */
export function ownOrigins(hosts: ReadonlySet<string>): Set<string> {
  return new Set([...hosts].map((host) => `http://${host}`));
}

export function hostAllowed(request: IncomingMessage, hosts: ReadonlySet<string>): boolean {
  const host = request.headers.host;
  return typeof host === 'string' && hosts.has(host.toLowerCase());
}

/** A loopback origin: http or https on 127.0.0.0/8, ::1 or localhost, in its canonical serialization; `null` is not one. */
export function isLoopbackOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.origin !== origin) return false;
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  return host === 'localhost' || isLoopbackAddress(host);
}

/** Origin, if present, must be a loopback origin (MCP clients in a browser on another local port included). */
export function originAllowed(request: IncomingMessage, own?: ReadonlySet<string>): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  return typeof origin === 'string' && (own ? own.has(origin) : isLoopbackOrigin(origin));
}

/**
 * `same-origin`, not `no-referrer`: under no-referrer a browser sends `Origin: null` with every form POST (Fetch, "append a
 * request Origin header"), and the console's own sign-in and sign-out forms would be refused as foreign. Same-origin
 * requests carry the real Origin; requests to other origins still get no referrer.
 */
export const REFERRER_POLICY = 'same-origin';

const COMMON_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
  'referrer-policy': REFERRER_POLICY,
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin',
};

export function setCommonHeaders(response: ServerResponse): void {
  for (const [name, value] of Object.entries(COMMON_HEADERS)) response.setHeader(name, value);
}

export function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  setCommonHeaders(response);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)), ...headers });
  response.end(text);
}

/** A JSON-RPC error outside any request (refused before the body is read, or not parseable): id null. */
export function sendRpcError(response: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}, id: string | number | null = null): void {
  sendJson(response, status, { jsonrpc: '2.0', error: { code, message }, id }, headers);
}

export function sendText(response: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  setCommonHeaders(response);
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(Buffer.byteLength(text)), ...headers });
  response.end(text);
}

/** The share of the body budget one request holds: take() reserves bytes, release() gives back everything it took. */
export interface BodyHold {
  take(bytes: number): boolean;
  release(): void;
}

/**
 * Request body bytes the process holds at once, over all requests: read, parsed and being handled. Each request may be
 * as large as the request cap; without a common bound, many large bodies at once would exhaust the heap for everyone.
 * A request that does not fit is answered 503 with Retry-After before (or instead of) reading the rest of its body.
 */
export class BodyBudget {
  readonly capacity: number;
  #used = 0;
  constructor(capacity: number) {
    this.capacity = capacity;
  }
  get used(): number {
    return this.#used;
  }
  hold(): BodyHold {
    let held = 0;
    return {
      take: (bytes: number) => {
        if (this.#used + bytes > this.capacity) return false;
        this.#used += bytes;
        held += bytes;
        return true;
      },
      release: () => {
        this.#used -= held;
        held = 0;
      },
    };
  }
}

export type BodyResult = { ok: true; bytes: Buffer } | { ok: false; reason: 'too_large' | 'aborted' | 'busy' };

/**
 * Reads the request body up to `limit` bytes. A declared or observed size over the limit stops reading at once: the rest is
 * discarded and the caller answers 413 with `connection: close`. Never buffers more than the limit. With a hold, the
 * declared size (or each chunk of a body without one) is taken from the body budget first; when it does not fit, reading
 * stops the same way and the result is `busy`.
 */
export function readBody(request: IncomingMessage, limit: number, hold?: BodyHold): Promise<BodyResult> {
  const declared = request.headers['content-length'];
  if (declared !== undefined && (!/^[0-9]{1,15}$/.test(declared) || Number(declared) > limit)) {
    request.resume();
    return Promise.resolve({ ok: false, reason: 'too_large' });
  }
  if (declared !== undefined && hold !== undefined && !hold.take(Number(declared))) {
    request.resume();
    return Promise.resolve({ ok: false, reason: 'busy' });
  }
  const perChunk = declared === undefined ? hold : undefined;
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (result: BodyResult) => {
      if (done) return;
      done = true;
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onAborted);
      if (!result.ok) request.resume();
      resolve(result);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) finish({ ok: false, reason: 'too_large' });
      else if (perChunk !== undefined && !perChunk.take(chunk.length)) finish({ ok: false, reason: 'busy' });
      else chunks.push(chunk);
    };
    const onEnd = () => finish({ ok: true, bytes: Buffer.concat(chunks, size) });
    const onError = () => finish({ ok: false, reason: 'aborted' });
    const onAborted = () => finish({ ok: false, reason: 'aborted' });
    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', onError);
    request.on('aborted', onAborted);
  });
}

/** The essence of a Content-Type header, lowercase, without parameters. */
export function mediaTypeOf(request: IncomingMessage): string {
  const value = request.headers['content-type'];
  return typeof value === 'string' ? value.split(';')[0].trim().toLowerCase() : '';
}

/** Cookies of the request by name; the first occurrence of a name wins. */
export function cookiesOf(request: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>();
  const header = request.headers.cookie;
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at <= 0) continue;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (!out.has(name)) out.set(name, value);
  }
  return out;
}
