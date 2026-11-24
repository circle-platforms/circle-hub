// The production transport of the Jev client: one HTTPS POST to the fixed endpoint through node:https. It follows no redirect, reads no
// environment and gives a request that is not for the endpoint no connection. It sets exactly one certificate option,
// rejectUnauthorized: true, so that the certificate chain and the host name of the server are always checked, whatever
// NODE_TLS_REJECT_UNAUTHORIZED says in the environment (an explicit option beats it). Every other certificate option (ca, cert, key,
// checkServerIdentity, servername, a secure context, a pin) stays absent: the roots that count are the ones bundled with Node, not the
// operating system's store. Node's own start-up settings such as NODE_EXTRA_CA_CERTS can still add roots; they are outside this
// module. The request function is a parameter only so that a test can stand in for the network.
import { request as httpsRequest } from 'node:https';
import type { RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { JEV_ENDPOINT } from './types.ts';
import type { JevTransport, JevTransportReply, JevTransportRequest } from './types.ts';

/** What a reply may hold; a Jev answer is a few kilobytes. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export type JevTransportFailure = 'timeout' | 'connection' | 'response_too_large' | 'response_encoding';

// What a tag may be: a short upper-case system code such as ECONNRESET. Nothing else can travel from a transport into an error text.
const TAG_SHAPE = /^[A-Z][A-Z0-9_]{1,40}$/;

/** How a transport fails: the client turns it into the call error and never resends the request. */
export class JevTransportError extends Error {
  readonly reason: JevTransportFailure;
  /** The short upper-case system code (ECONNRESET), or an empty text: any other text is dropped. */
  readonly tag: string;

  constructor(reason: JevTransportFailure, tag = '') {
    super(`Jev transport: ${reason}`);
    this.name = 'JevTransportError';
    this.reason = reason;
    this.tag = TAG_SHAPE.test(tag) ? tag : '';
  }
}

/** The system error code of a failure when it has the shape of one (ECONNRESET), else an empty text; never a message. */
export function transportTag(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && TAG_SHAPE.test(code) ? code : '';
}

type RequestFunction = (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;

function flattenHeaders(headers: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

export function createHttpsTransport(deps: { request?: RequestFunction } = {}): JevTransport {
  const send: RequestFunction = deps.request ?? httpsRequest;
  return (request: JevTransportRequest): Promise<JevTransportReply> =>
    new Promise<JevTransportReply>((resolve, reject) => {
      if (request.url !== JEV_ENDPOINT) {
        reject(new JevTransportError('connection', 'URL_REFUSED'));
        return;
      }
      const target = new URL(JEV_ENDPOINT);
      let settled = false;
      let outgoing: ClientRequest | undefined;
      let incoming: IncomingMessage | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: JevTransportReply | JevTransportError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (outcome instanceof JevTransportError) {
          incoming?.destroy();
          outgoing?.destroy();
          reject(outcome);
        } else {
          resolve(outcome);
        }
      };
      timer = setTimeout(() => finish(new JevTransportError('timeout')), request.timeoutMs);
      const payload = Buffer.from(request.body, 'utf8');
      const options: RequestOptions = {
        method: 'POST',
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port === '' ? 443 : Number(target.port),
        path: target.pathname,
        headers: { ...request.headers, 'Content-Length': String(payload.byteLength) },
        agent: false,
        // The one certificate option: verification is never off, whatever the environment says (see the head of this file).
        rejectUnauthorized: true,
      };
      try {
        outgoing = send(options, (response) => {
          incoming = response;
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer | string) => {
            const piece = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
            size += piece.byteLength;
            if (size > MAX_RESPONSE_BYTES) {
              finish(new JevTransportError('response_too_large'));
              return;
            }
            chunks.push(piece);
          });
          response.on('error', (error: unknown) => finish(new JevTransportError('connection', transportTag(error))));
          response.on('aborted', () => finish(new JevTransportError('connection', 'ECONNRESET')));
          response.on('close', () => {
            if (!response.complete) finish(new JevTransportError('connection', 'ECONNRESET'));
          });
          response.on('end', () => {
            let body: string;
            try {
              body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
            } catch {
              finish(new JevTransportError('response_encoding'));
              return;
            }
            finish({ status: response.statusCode ?? 0, headers: flattenHeaders(response.headers), body });
          });
        });
      } catch (error) {
        finish(new JevTransportError('connection', transportTag(error)));
        return;
      }
      outgoing.on('error', (error: unknown) => finish(new JevTransportError('connection', transportTag(error))));
      outgoing.end(payload);
    });
}

/** The transport of production: node:https to the fixed endpoint. */
export const httpsTransport: JevTransport = createHttpsTransport();
