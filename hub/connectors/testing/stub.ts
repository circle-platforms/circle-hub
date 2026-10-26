// A configurable loopback HTTP stub for connector tests: listens on 127.0.0.1 with an ephemeral port, records every request
// exactly as received (method, raw path, query, headers, body) and counts requests in flight, so tests can assert what was
// sent, and that nothing was sent. Content is invented; nothing outside the test process is reached.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  /** The path exactly as received, percent escapes kept, without the query. */
  path: string;
  query: Record<string, string>;
  /** Header names in lower case. */
  headers: Record<string, string>;
  body: string;
  /** The body parsed, when it is JSON. */
  json?: unknown;
  at: number;
}

export interface StubReply {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Wait this long before the status line. */
  delayMs?: number;
  /** Send the body in these pieces, pausing `chunkDelayMs` between them (Content-Length is then not sent). */
  chunks?: (string | Uint8Array)[];
  chunkDelayMs?: number;
  /** Close the connection without answering. */
  hangUp?: boolean;
}

export type StubHandler = (request: RecordedRequest) => StubReply | Promise<StubReply>;

export interface StubServer {
  /** `http://127.0.0.1:<port>` */
  origin: string;
  requests: RecordedRequest[];
  /** Requests being answered right now, and the most seen at once. */
  readonly inFlight: number;
  readonly maxInFlight: number;
  /** Forgets the recorded requests and the in-flight maximum. */
  reset(): void;
  close(): Promise<void>;
}

export function json(value: unknown, status = 200, headers: Record<string, string> = {}): StubReply {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers }, body: JSON.stringify(value) };
}

export function text(body: string | Uint8Array, contentType: string, status = 200, headers: Record<string, string> = {}): StubReply {
  return { status, headers: { 'content-type': contentType, ...headers }, body };
}

export const notFound = (): StubReply => text('<html><body>404 Not Found</body></html>', 'text/html', 404);

/** Adds members to a stub keeping getters and setters live (Object.assign would copy their current values). */
export function extend<T extends object, U extends object>(base: T, extra: U): T & U {
  Object.defineProperties(base, Object.getOwnPropertyDescriptors(extra));
  return base as T & U;
}

function header(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(', ') : (value ?? '');
}

export async function startStub(handler: StubHandler): Promise<StubServer> {
  const requests: RecordedRequest[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const sockets = new Set<import('node:net').Socket>();

  const serve = async (incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(chunk as Buffer);
      const raw = incoming.url ?? '/';
      const question = raw.indexOf('?');
      const path = question < 0 ? raw : raw.slice(0, question);
      const query: Record<string, string> = {};
      if (question >= 0) for (const [k, v] of new URLSearchParams(raw.slice(question + 1))) query[k] = v;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(incoming.headers)) headers[k.toLowerCase()] = header(v);
      const body = Buffer.concat(chunks).toString('utf8');
      const recorded: RecordedRequest = { method: incoming.method ?? 'GET', path, query, headers, body, at: Date.now() };
      if (body !== '') {
        try {
          recorded.json = JSON.parse(body);
        } catch {
          // not JSON
        }
      }
      requests.push(recorded);
      const reply = await handler(recorded);
      if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
      if (reply.hangUp) {
        incoming.socket.destroy();
        return;
      }
      const status = reply.status ?? 200;
      if (reply.chunks !== undefined) {
        outgoing.writeHead(status, reply.headers ?? {});
        for (const piece of reply.chunks) {
          if (outgoing.destroyed) break;
          outgoing.write(piece);
          if (reply.chunkDelayMs) await new Promise((resolve) => setTimeout(resolve, reply.chunkDelayMs));
        }
        outgoing.end();
        return;
      }
      const bytes = typeof reply.body === 'string' ? Buffer.from(reply.body, 'utf8') : Buffer.from(reply.body ?? new Uint8Array());
      outgoing.writeHead(status, { 'content-length': String(bytes.byteLength), ...(reply.headers ?? {}) });
      outgoing.end(bytes);
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.end();
    } finally {
      inFlight -= 1;
    }
  };

  const server = createServer((incoming, outgoing) => void serve(incoming, outgoing));
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    get inFlight() {
      return inFlight;
    },
    get maxInFlight() {
      return maxInFlight;
    },
    reset() {
      requests.length = 0;
      maxInFlight = inFlight;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
