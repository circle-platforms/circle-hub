import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as jev from './index.ts';
import { KEY, noulRequest } from '../../../testing/synthetic.ts';

// The interface the workflow side codes against, copied as it was handed over. The type checks below fail the type check of the
// repository when this module stops matching it; nothing here is read at run time except the proofs and the exported names.
type ContractQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };
interface ContractRequest {
  state: unknown;
  questions: Record<string, ContractQuestion>;
  model?: string;
}
type ContractAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number };
interface ContractResponse {
  model: string;
  model_version: string;
  status: '未确认';
  decided_by: '模型';
  answers: Record<string, ContractAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}
type ContractCategory = '参数无效' | '无权限' | '暂时不可用';
interface ContractError extends Error {
  readonly category: ContractCategory;
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
}
interface ContractTransportRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}
interface ContractTransportReply {
  status: number;
  headers: Record<string, string>;
  body: string;
}
type ContractTransport = (request: ContractTransportRequest) => Promise<ContractTransportReply>;
interface ContractConfig {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  auditPath?: string;
  transport?: ContractTransport;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}
interface ContractClient {
  ask(request: ContractRequest): Promise<ContractResponse>;
}

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// Each field is the proof that two types are the same type; a field that is not true makes the object below a type error.
const proofs: {
  question: Equal<jev.JevQuestion, ContractQuestion>;
  request: Equal<jev.JevRequest, ContractRequest>;
  answer: Equal<jev.JevAnswer, ContractAnswer>;
  response: Equal<jev.JevResponse, ContractResponse>;
  category: Equal<jev.JevErrorCategory, ContractCategory>;
  transportRequest: Equal<jev.JevTransportRequest, ContractTransportRequest>;
  transportReply: Equal<jev.JevTransportReply, ContractTransportReply>;
  transport: Equal<jev.JevTransport, ContractTransport>;
  config: Equal<jev.JevClientConfig, ContractConfig>;
  clientConfig: Equal<ConstructorParameters<typeof jev.JevClient>[0], ContractConfig>;
  askParameter: Equal<Parameters<jev.JevClient['ask']>[0], ContractRequest>;
  askResult: Equal<ReturnType<jev.JevClient['ask']>, Promise<ContractResponse>>;
  endpoint: Equal<typeof jev.JEV_ENDPOINT, 'https://api.typesafe.ai/v1/systemone'>;
  model: Equal<typeof jev.JEV_DEFAULT_MODEL, 'jev-latest'>;
} = {
  question: true,
  request: true,
  answer: true,
  response: true,
  category: true,
  transportRequest: true,
  transportReply: true,
  transport: true,
  config: true,
  clientConfig: true,
  askParameter: true,
  askResult: true,
  endpoint: true,
  model: true,
};

// The classes are used through the contract's shapes; the error may be narrower (its code is a closed set of texts).
const asContractError = (error: jev.JevCallError): ContractError => error;
const asContractClient = (client: jev.JevClient): ContractClient => client;

describe('the module matches the interface the workflow side codes against', () => {
  it('has the types of the contract', () => {
    assert.equal(Object.values(proofs).length, 14);
    assert.ok(Object.values(proofs).every((proof) => proof === true));
  });

  it('has the constants of the contract', () => {
    assert.equal(jev.JEV_ENDPOINT, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(jev.JEV_DEFAULT_MODEL, 'jev-latest');
  });

  it('has a client with ask(request) and an error with the contract fields', () => {
    const client = asContractClient(new jev.JevClient({ apiKey: KEY }));
    assert.equal(typeof client.ask, 'function');
    assert.equal(client.ask.length, 1);
    const error = asContractError(new jev.JevCallError({ category: '暂时不可用', code: 'timeout', fact: '一件事实', nextAction: '一个下一步' }));
    assert.ok(error instanceof Error);
    assert.deepEqual([error.category, error.status, error.code, error.retryable, error.name], ['暂时不可用', 0, 'timeout', false, 'JevCallError']);
    assert.equal(error.message, '暂时不可用：一件事实。一个下一步。');
  });

  it('exports exactly these values, so that a change of the interface is a change of this list', () => {
    assert.deepEqual(Object.keys(jev).sort(), [
      'JEV_DEFAULT_MODEL',
      'JEV_DEFAULT_TIMEOUT_MS',
      'JEV_ENDPOINT',
      'JEV_ERROR_CODES',
      'JEV_MAX_TIMEOUT_MS',
      'JevCallError',
      'JevClient',
      'JevTransportError',
      'createHttpsTransport',
      'formatJevCallError',
      'httpsTransport',
      'jevRetryAfterMilliseconds',
      'parseJevJson',
      'validateJevRequest',
      'validateJevResponse',
    ]);
  });

  it('reads the closed words of the call-error form and the one set of codes', () => {
    assert.deepEqual([...jev.JEV_ERROR_CODES], [
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
    ]);
    assert.equal(jev.formatJevCallError('参数无效', '请求不合格', '请改正后重试'), '参数无效：请求不合格。请改正后重试。');
    assert.equal(jev.formatJevCallError('无权限', '密钥无效。', '请换一把！'), '无权限：密钥无效。请换一把。');
  });

  it('keeps the defaults of the client in numbers', () => {
    assert.equal(jev.JEV_DEFAULT_TIMEOUT_MS, 30_000);
    assert.equal(jev.JEV_MAX_TIMEOUT_MS, 600_000);
  });

  it('is usable with nothing but the contract: a request in the contract type is accepted as it is', () => {
    const request: ContractRequest = noulRequest;
    assert.equal(jev.validateJevRequest(request).types[0], 'noul');
  });
});
