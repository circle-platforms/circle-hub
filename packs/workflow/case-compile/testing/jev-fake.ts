// Scripted stand-ins for Jev in tests: a client that records every request and answers as the script says, and a transport that
// speaks the wire protocol so that the real embedded client (jev-judge skill) runs against it. Nothing here touches the network.
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { JevAnswer, JevQuestion, JevRequest, JevResponse, JevTransport, JevTransportRequest } from '../functions/generated/skills/jev-judge/jev-client/index.ts';
import type { JevAsker } from '../functions/jev-judge.ts';

export const JEV_TEST_VERSION = 'jev-1.13.0';

/** What the client of the skill throws: a category word, the HTTP status and a code. */
export class FakeCallError extends Error {
  readonly category: string; readonly status: number; readonly code: string; readonly retryable: boolean;
  constructor(category: string, status: number, code: string, message = '合成的失败') { super(message); this.category = category; this.status = status; this.code = code; this.retryable = false; }
}

export type JevScript = (request: JevRequest, n: number) => JevAnswer | Error;

export function jevFake(answer: JevScript, version = JEV_TEST_VERSION) {
  const requests: JevRequest[] = [];
  let open = 0, widest = 0;
  const asker: JevAsker = {
    async ask(request) {
      requests.push(JSON.parse(JSON.stringify(request)) as JevRequest);
      open += 1; widest = Math.max(widest, open);
      await new Promise((done) => setTimeout(done, 1));
      open -= 1;
      const made = answer(request, requests.length);
      if (made instanceof Error) throw made;
      const response: JevResponse = { model: request.model ?? '', model_version: version, status: '未确认', decided_by: '模型', answers: { q1: made }, usage: { input_tokens: 1, output_tokens: 1 } };
      return response;
    },
  };
  const configs: Array<{ apiKey: string; auditPath?: string }> = [];
  return { asker, requests, configs, widest: () => widest, factory: (config: { apiKey: string; auditPath?: string }) => { configs.push(config); return asker; } };
}

/** The exact model the fake service names in every answer, whatever name the request asked for. */
export const JEV_WIRE_VERSION = 'jev-1.14.0';

export interface WireCall {
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  timeoutMs: number;
  /** The body as it left the client, parsed. */
  sent: { state: unknown; model: string; questions: Record<string, JevQuestion> };
  /** The body as it left the client, as text. */
  text: string;
}

/** What the fake service answers for one question: an answer of the question's type, a reply to give instead, or an error of the connection. */
export type WireScript = (question: JevQuestion, call: WireCall, n: number) => JevAnswer | { status: number; body: string; headers?: Record<string, string> } | Error;

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** A valid answer to a question: the first option most probable (0.7), the second next (0.3), the rest 0. */
export function validAnswer(question: JevQuestion, yes = 0.8): JevAnswer {
  if (question.type === 'noul') return { type: 'noul', noul: yes };
  if (question.type === 'choice') {
    const options = Object.keys(question.criteria);
    const probabilities: Record<string, number> = {};
    options.forEach((option, index) => { probabilities[option] = options.length === 1 ? 1 : index === 0 ? 0.7 : index === 1 ? 0.3 : 0; });
    const n = options.length;
    return { type: 'choice', choice: options[0]!, probabilities, confidence: n === 1 ? 1 : round2((probabilities[options[0]!]! - 1 / n) / (1 - 1 / n)) };
  }
  throw new Error('the workflow asks no score question');
}

/** The transport the real client is given instead of the network: it parses what was sent, answers as the script says, and keeps every call. */
export function jevWire(script: WireScript = (question) => validAnswer(question)): { transport: JevTransport; calls: WireCall[] } {
  const calls: WireCall[] = [];
  const transport: JevTransport = async (request: JevTransportRequest) => {
    const sent = JSON.parse(request.body) as WireCall['sent'];
    const call: WireCall = { url: request.url, authorization: request.headers.Authorization, contentType: request.headers['Content-Type'], timeoutMs: request.timeoutMs, sent, text: request.body };
    calls.push(call);
    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(sent.questions)) {
      const made = script(question, call, calls.length);
      if (made instanceof Error) throw made;
      if ('body' in made) return { status: made.status, headers: made.headers ?? {}, body: made.body };
      answers[id] = made;
    }
    return { status: 200, headers: {}, body: JSON.stringify({ model: JEV_WIRE_VERSION, answers, usage: { input_tokens: 120, output_tokens: 30 } }) };
  };
  return { transport, calls };
}

/** A key of the alphabet the client accepts, long enough that no ordinary text holds it. */
export const JEV_WIRE_KEY = 'jev_sk_synthetic_wire_1a2b3c4d5e';
export const sha256Text = (text: string): string => createHash('sha256').update(text).digest('hex');
/** Every file under a directory, as full paths, sorted. */
export const filesBelow = async (dir: string): Promise<string[]> => (await readdir(dir, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).sort();
/** A text in the two forms that a file could hold it: as it is and as the inside of a JSON string. */
export const textForms = (text: string): string[] => [text, JSON.stringify(text).slice(1, -1)];
