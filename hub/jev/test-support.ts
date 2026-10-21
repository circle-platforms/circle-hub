// Test support: a loopback stub of the vendor API (POST /v1/systemone as the published OpenAPI spec describes it), a
// fetch that refuses anything but the loopback stub, and synthetic requests. All content here is invented.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpJev } from './api.ts';
import type { HttpJevOptions, JevRequest } from './api.ts';

export const MODEL = 'jev-1.13.0';

export interface StubCall {
  method: string;
  url: string;
  /** Header pairs exactly as received: [name, value, name, value, ...]. */
  rawHeaders: string[];
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface StubReply {
  status?: number;
  headers?: Record<string, string>;
  /** Sent as JSON unless `raw` or `bytes` is given. */
  body?: unknown;
  raw?: string;
  bytes?: Uint8Array;
  /** Send the status line and this much of the body, then stall. */
  stall?: string;
  /** Never answer. */
  hang?: boolean;
  /** Drop the connection without answering. */
  destroy?: boolean;
}

export type StubHandler = (call: StubCall, index: number) => StubReply | Promise<StubReply>;

export interface Stub {
  baseUrl: string;
  calls: StubCall[];
  handler: StubHandler;
  close(): Promise<void>;
}

/** A random, obviously synthetic API key for one test run. */
export function syntheticKey(): string {
  return `test-only-key-${randomBytes(16).toString('hex')}`;
}

/** fetch for tests: only the loopback stub may be reached. */
export const loopbackFetch: typeof globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== '127.0.0.1') return Promise.reject(new Error('tests may reach only the loopback stub'));
  return globalThis.fetch(input, init);
};

export function sampleRequest(model: string = MODEL): JevRequest {
  return {
    model,
    state: { item: { text: '示例条目：用 demo-cmd 设置示例接口的地址' } },
    questions: {
      q1: { type: 'noul', instructions: 'Does `item.text` describe a command?', criteria: { true: 'It names a command', false: 'It does not' } },
      q2: { type: 'choice', instructions: 'Which section holds `item`?', criteria: { sectionA: 'Network', sectionB: 'System', none: 'No section fits' } },
      q3: { type: 'score', instructions: 'How specific is `item`?', criteria: ['vague', 'somewhat', 'exact'] },
    },
  };
}

/** A client of the stub with instant sleeps and no jitter unless overridden. */
export function stubClient(stub: Stub, key: string, options: Partial<HttpJevOptions> = {}): HttpJev {
  return new HttpJev({
    apiKey: () => key,
    model: MODEL,
    baseUrl: stub.baseUrl,
    fetch: loopbackFetch,
    sleep: async () => undefined,
    random: () => 0,
    ...options,
  });
}

function spread(names: string[], top: number, p: number): Record<string, number> {
  const out: Record<string, number> = {};
  const rest = names.length > 1 ? (1 - p) / (names.length - 1) : 0;
  names.forEach((name, index) => {
    out[name] = names.length === 1 ? 1 : index === top ? p : rest;
  });
  return out;
}

function confidence(pmax: number, n: number): number {
  return n > 1 ? (pmax - 1 / n) / (1 - 1 / n) : 1;
}

// The stub's own judgement: yes 0.8; the first option 0.6; the highest level 0.7; the rest spread evenly.
export function stubAnswer(question: Record<string, unknown>): unknown {
  if (question.type === 'noul') return { type: 'noul', noul: 0.8 };
  if (question.type === 'choice') {
    const names = Object.keys(question.criteria as object);
    const probabilities = spread(names, 0, 0.6);
    return { type: 'choice', choice: names[0], confidence: confidence(probabilities[names[0] as string] as number, names.length), probabilities };
  }
  const levels = (question.criteria as unknown[]).map((_, level) => String(level));
  const probabilities = spread(levels, levels.length - 1, 0.7);
  const score = levels.reduce((sum, level, index) => sum + index * (probabilities[level] as number), 0);
  const legend = Object.fromEntries((question.criteria as unknown[]).map((text, level) => [String(level), text]));
  return { type: 'score', score, confidence: confidence(0.7, levels.length), legend, probabilities };
}

// Request validation as the spec declares it; 422 details echo the offending input like the real service.
function vendorDetail(request: unknown): unknown[] {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return [{ loc: ['body'], msg: 'Input should be an object', type: 'model_attributes_type', input: request }];
  }
  const body = request as Record<string, unknown>;
  const detail: unknown[] = [];
  if (typeof body.model !== 'string') detail.push({ loc: ['body', 'model'], msg: 'Field required', type: 'missing', input: body });
  const state = body.state;
  if (typeof state !== 'string' && (state === null || typeof state !== 'object')) {
    detail.push({ loc: ['body', 'state'], msg: 'Field required', type: 'missing', input: body });
  }
  const questions = body.questions;
  if (questions === null || typeof questions !== 'object' || Object.keys(questions).length === 0) {
    detail.push({ loc: ['body', 'questions'], msg: 'Dictionary should have at least 1 item', type: 'too_short', input: questions });
    return detail;
  }
  for (const [id, raw] of Object.entries(questions)) {
    const question = raw as Record<string, unknown>;
    if (question.type === 'choice') {
      const count = question.criteria !== null && typeof question.criteria === 'object' ? Object.keys(question.criteria).length : 0;
      if (count < 1 || count > 255) detail.push({ loc: ['body', 'questions', id, 'choice', 'criteria'], msg: 'bad criteria', type: 'too_long', input: question.criteria });
    } else if (question.type === 'score') {
      const count = Array.isArray(question.criteria) ? question.criteria.length : 0;
      if (count < 1 || count > 10) detail.push({ loc: ['body', 'questions', id, 'score', 'criteria'], msg: 'bad criteria', type: 'too_long', input: question.criteria });
    } else if (question.type !== 'noul' && question.type !== 'box') {
      detail.push({ loc: ['body', 'questions', id], msg: 'Input tag does not match', type: 'union_tag_invalid', input: question });
    }
  }
  return detail;
}

/** What the vendor would answer: auth, media type, body validation, then one answer per question. */
export function vendorReply(call: StubCall, key: string, index = 0): StubReply {
  if (call.method !== 'POST' || call.url !== '/v1/systemone') return { status: 404, body: { detail: 'Not Found' } };
  if (call.headers.authorization !== `Bearer ${key}`) return { status: 401, body: { detail: 'Invalid or missing API key' } };
  if (!String(call.headers['content-type'] ?? '').startsWith('application/json')) return { status: 415, body: { detail: 'Unsupported Media Type' } };
  let request: unknown;
  try {
    request = JSON.parse(call.body);
  } catch {
    return { status: 400, body: { detail: 'Invalid JSON body' } };
  }
  const detail = vendorDetail(request);
  if (detail.length > 0) return { status: 422, body: { detail } };
  const body = request as { model: string; questions: Record<string, Record<string, unknown>> };
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(body.questions)) answers[id] = stubAnswer(question);
  return {
    status: 200,
    headers: { 'x-typesafe-request-id': `req_stub_${index + 1}` },
    body: { model: body.model, answers, usage: { input_tokens: Math.ceil(call.body.length / 4), output_tokens: Object.keys(answers).length } },
  };
}

function respond(request: IncomingMessage, response: ServerResponse, reply: StubReply): void {
  if (reply.destroy) {
    request.socket.destroy();
    return;
  }
  if (reply.hang) return;
  const headers = { 'content-type': 'application/json', connection: 'close', ...reply.headers };
  if (reply.stall !== undefined) {
    response.writeHead(reply.status ?? 200, headers);
    response.write(reply.stall);
    return;
  }
  const payload = reply.bytes ?? Buffer.from(reply.raw ?? (reply.body === undefined ? '' : JSON.stringify(reply.body)), 'utf8');
  response.writeHead(reply.status ?? 200, headers);
  response.end(payload);
}

/** Starts the stub on 127.0.0.1 with a free port. */
export async function startStub(handler: StubHandler): Promise<Stub> {
  const calls: StubCall[] = [];
  const stub: Stub = { baseUrl: '', calls, handler, close: async () => undefined };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const call: StubCall = {
        method: request.method ?? '',
        url: request.url ?? '',
        rawHeaders: [...request.rawHeaders],
        headers: { ...request.headers },
        body: Buffer.concat(chunks).toString('utf8'),
      };
      const index = calls.length;
      calls.push(call);
      Promise.resolve()
        .then(() => stub.handler(call, index))
        .then(
          (reply) => respond(request, response, reply),
          () => {
            response.writeHead(500, { connection: 'close' });
            response.end();
          },
        );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  stub.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return stub;
}
