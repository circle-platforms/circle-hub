// Shapes of the Jev client module: System One questions and answers as the service defines them, the seam that tests use
// instead of the network, and the one error a call ends with. The module imports only node:* and files of this directory, so that
// a workflow pack can carry it as it is.

/** One question: yes/no (noul), one of several options (choice) or a level on an ordered scale (score). */
export type JevQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

export interface JevRequest {
  /** What every question is judged against: text, an array or a plain JSON object. */
  state: unknown;
  /** Question id (1 to 128 of A-Z a-z 0-9 _ -) to question. The ids are never shown to the model. */
  questions: Record<string, JevQuestion>;
  /** The model to ask; the client's model, else JEV_DEFAULT_MODEL. */
  model?: string;
}

export type JevAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number };

/** The protocol fields of a valid answer, with the disclosure that every judgment of a model carries. */
export interface JevResponse {
  /** The model exactly as the service named it. */
  model: string;
  /** The same text again, under the name the disclosure of this repository uses. */
  model_version: string;
  status: '未确认';
  decided_by: '模型';
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

/** The call-error words of this repository that a Jev call can end with. */
export type JevErrorCategory = '参数无效' | '无权限' | '暂时不可用';

/** What the call ended with, in a short closed set; the status says the rest. */
export const JEV_ERROR_CODES = [
  'invalid_request',
  'request_too_large',
  'context_too_long',
  'request_rejected',
  'invalid_key',
  'unauthorized',
  'forbidden',
  'rate_limited',
  'overloaded',
  'service_error',
  'unexpected_status',
  'timeout',
  'connection_lost',
  'invalid_response',
  'audit_failed',
] as const;
export type JevErrorCode = (typeof JEV_ERROR_CODES)[number];

const sentence = (text: string): string => `${text.trim().replace(/[。.!！?？]+$/u, '')}。`;

/** The call-error form of this repository: category word, the fact, the next step, each sentence closed with a full stop. */
export function formatJevCallError(category: JevErrorCategory, fact: string, nextAction: string): string {
  return `${category}：${sentence(fact)}${sentence(nextAction)}`;
}

export interface JevCallErrorInit {
  category: JevErrorCategory;
  code: JevErrorCode;
  fact: string;
  nextAction: string;
  /** HTTP status of the answer that ended the call; 0 when there was none. */
  status?: number;
  /** True only where the service itself asked to wait and try again (429, 529). */
  retryable?: boolean;
  /** Requests sent before the call ended. */
  attempts?: number;
}

/**
 * The one error a Jev call ends with. The message is Chinese in the call-error form; it never holds the key, a request or a
 * piece of what the service answered (the answer to a refused request can echo the request).
 */
export class JevCallError extends Error {
  readonly category: JevErrorCategory;
  readonly status: number;
  readonly code: JevErrorCode;
  readonly retryable: boolean;
  readonly attempts: number;
  readonly #init: JevCallErrorInit;

  constructor(init: JevCallErrorInit) {
    super(formatJevCallError(init.category, init.fact, init.nextAction));
    this.name = 'JevCallError';
    this.#init = init;
    this.category = init.category;
    this.code = init.code;
    this.status = init.status ?? 0;
    this.retryable = init.retryable ?? false;
    this.attempts = init.attempts ?? 0;
  }

  /** The same error, told how many requests were sent before it. */
  withAttempts(attempts: number): JevCallError {
    return new JevCallError({ ...this.#init, attempts });
  }
}

export interface JevTransportRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export interface JevTransportReply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Sends one request and returns the reply; a timeout or a broken connection is a rejection. Tests inject it; production uses node:https. */
export type JevTransport = (request: JevTransportRequest) => Promise<JevTransportReply>;

export interface JevClientConfig {
  /** The API key. Only the constructor takes it; it is never read from the environment or a file. */
  apiKey: string;
  model?: string;
  /** Per request, from the start to the whole answer. Default 30000, at most 600000. */
  timeoutMs?: number;
  /** A JSONL file that gets one line per request sent: sizes, digests, status and usage, never content. */
  auditPath?: string;
  transport?: JevTransport;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/** The only address a request goes to. No option, flag or environment variable changes it. */
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_DEFAULT_MODEL = 'jev-latest';
