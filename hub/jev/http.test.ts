import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { inspect } from 'node:util';
import { HttpJev, JevError } from './api.ts';
import type { JevChoiceAnswer, JevErrorCode, JevJson, JevRequest, JevScoreAnswer } from './api.ts';
import { MODEL, loopbackFetch, sampleRequest, startStub, stubAnswer, stubClient, syntheticKey, vendorReply } from './test-support.ts';
import type { Stub, StubReply } from './test-support.ts';

const KEY = syntheticKey();
let stub: Stub;

before(async () => {
  stub = await startStub((call, index) => vendorReply(call, KEY, index));
});

after(async () => {
  await stub.close();
});

beforeEach(() => {
  stub.calls.length = 0;
  stub.handler = (call, index) => vendorReply(call, KEY, index);
});

async function rejection(promise: Promise<unknown>): Promise<JevError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof JevError, `expected a JevError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected a rejection');
}

function always(reply: StubReply): void {
  stub.handler = () => reply;
}

/** Fails the test instead of hanging when `promise` does not settle in time. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new assert.AssertionError({ message: `did not settle within ${ms} ms` })), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** Everything an error exposes when it is logged, printed or serialized. */
function exposed(error: Error): string {
  return [error.message, String(error.stack), inspect(error, { depth: 5 }), JSON.stringify(error), String(error)].join('\n');
}

function validBody(): Record<string, unknown> {
  const request = sampleRequest();
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(request.questions)) answers[id] = stubAnswer(question as unknown as Record<string, unknown>);
  return { model: MODEL, answers, usage: { input_tokens: 10, output_tokens: 3 } };
}

function withAnswer(id: string, change: (answer: Record<string, unknown>) => void): Record<string, unknown> {
  const body = validBody();
  const answers = body.answers as Record<string, Record<string, unknown>>;
  change(answers[id] as Record<string, unknown>);
  return body;
}

describe('HttpJev success', () => {
  it('answers each question type and returns the model unchanged', async () => {
    const client = stubClient(stub, KEY);
    const response = await client.ask(sampleRequest());
    assert.equal(response.model, MODEL);
    assert.equal(response.requestId, 'req_stub_1');
    assert.deepEqual(Object.keys(response.answers), ['q1', 'q2', 'q3']);
    assert.deepEqual(response.answers.q1, { type: 'noul', noul: 0.8 });
    const choice = response.answers.q2 as JevChoiceAnswer;
    assert.equal(choice.type, 'choice');
    assert.equal(choice.choice, 'sectionA');
    assert.deepEqual(Object.keys(choice.probabilities), ['sectionA', 'sectionB', 'none']);
    assert.ok(Math.abs((choice.probabilities.sectionA as number) - 0.6) < 1e-12);
    const score = response.answers.q3 as JevScoreAnswer;
    assert.equal(score.type, 'score');
    assert.deepEqual(score.legend, { 0: 'vague', 1: 'somewhat', 2: 'exact' });
    assert.ok(Math.abs(score.score - 1.55) < 1e-9);
    assert.equal(response.usage.outputTokens, 3);
    assert.ok(response.usage.inputTokens > 0);
    assert.equal(stub.calls.length, 1);
  });

  for (const id of ['q1', 'q2', 'q3']) {
    it(`answers a request holding only question ${id}`, async () => {
      const full = sampleRequest();
      const request: JevRequest = { ...full, questions: { [id]: full.questions[id]! } };
      const response = await stubClient(stub, KEY).ask(request);
      assert.deepEqual(Object.keys(response.answers), [id]);
      assert.equal(response.answers[id]!.type, full.questions[id]!.type);
    });
  }

  it('sends POST /v1/systemone with Bearer auth and JSON, and the key nowhere but the Authorization header', async () => {
    await stubClient(stub, KEY).ask(sampleRequest());
    const call = stub.calls[0]!;
    assert.equal(call.method, 'POST');
    assert.equal(call.url, '/v1/systemone');
    assert.equal(call.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(call.body), sampleRequest());
    assert.ok(!call.url.includes(KEY));
    assert.ok(!call.body.includes(KEY));
    let authorizations = 0;
    for (let index = 0; index < call.rawHeaders.length; index += 2) {
      const name = call.rawHeaders[index]!;
      const value = call.rawHeaders[index + 1]!;
      if (name.toLowerCase() === 'authorization') {
        authorizations++;
        assert.equal(value, `Bearer ${KEY}`);
      } else {
        assert.ok(!name.includes(KEY) && !value.includes(KEY), `key leaked into header ${name}`);
      }
    }
    assert.equal(authorizations, 1);
  });

  it('calls apiKey once per attempt and accepts an async key source', async () => {
    let calls = 0;
    stub.handler = (call, index) => (index === 0 ? { status: 503, body: { detail: 'busy' } } : vendorReply(call, KEY, index));
    const client = stubClient(stub, KEY, {
      apiKey: async () => {
        calls++;
        return KEY;
      },
    });
    await client.ask(sampleRequest());
    assert.equal(calls, 2);
    assert.equal(stub.calls.length, 2);
  });

  it('joins a base URL that carries a path prefix', async () => {
    stub.handler = (call, index) => (call.url === '/proxy/v1/systemone' ? vendorReply({ ...call, url: '/v1/systemone' }, KEY, index) : { status: 404 });
    const response = await stubClient(stub, KEY, { baseUrl: `${stub.baseUrl}/proxy` }).ask(sampleRequest());
    assert.equal(response.model, MODEL);
  });

  it('accepts probabilities that sum to 1 within 1e-3', async () => {
    always({ status: 200, body: withAnswer('q2', (answer) => (answer.probabilities = { sectionA: 0.6005, sectionB: 0.2, none: 0.2 })) });
    const response = await stubClient(stub, KEY).ask(sampleRequest());
    assert.equal((response.answers.q2 as JevChoiceAnswer).probabilities.sectionA, 0.6005);
  });
});

describe('HttpJev error mapping', () => {
  const cases: Array<{ name: string; reply: StubReply; code: JevErrorCode; calls: number }> = [
    { name: '400', reply: { status: 400, body: { detail: 'Invalid JSON body' } }, code: 'JEV_BAD_REQUEST', calls: 1 },
    { name: '400 max_tokens_exceeded (detail type)', reply: { status: 400, body: { detail: [{ loc: ['body'], msg: 'Context too long', type: 'max_tokens_exceeded' }] } }, code: 'JEV_TOO_LARGE', calls: 1 },
    { name: '400 max_tokens_exceeded (error object)', reply: { status: 400, body: { error: { type: 'max_tokens_exceeded', message: 'too many tokens' } } }, code: 'JEV_TOO_LARGE', calls: 1 },
    { name: '400 max_tokens_exceeded (plain text)', reply: { status: 400, raw: 'max_tokens_exceeded: request too long' }, code: 'JEV_TOO_LARGE', calls: 1 },
    { name: '400 max_tokens_exceeded (detail string)', reply: { status: 400, body: { detail: 'max_tokens_exceeded' } }, code: 'JEV_TOO_LARGE', calls: 1 },
    { name: '400 max_tokens_exceeded (detail object)', reply: { status: 400, body: { detail: { type: 'max_tokens_exceeded', msg: 'too long' } } }, code: 'JEV_TOO_LARGE', calls: 1 },
    { name: '400 max_tokens_exceeded (error message)', reply: { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens_exceeded: 70000 > 64000' } } }, code: 'JEV_TOO_LARGE', calls: 1 },
    { name: '401', reply: { status: 401, body: { detail: 'Invalid or missing API key' } }, code: 'JEV_UNAUTHORIZED', calls: 1 },
    { name: '403', reply: { status: 403, body: { detail: 'Forbidden' } }, code: 'JEV_UNAUTHORIZED', calls: 1 },
    { name: '404', reply: { status: 404, body: { detail: 'Not Found' } }, code: 'JEV_BAD_REQUEST', calls: 1 },
    { name: '413', reply: { status: 413, body: { detail: 'Request Entity Too Large' } }, code: 'JEV_TOO_LARGE', calls: 1 },
    { name: '415', reply: { status: 415, body: { detail: 'Unsupported Media Type' } }, code: 'JEV_BAD_REQUEST', calls: 1 },
    { name: '422', reply: { status: 422, body: { detail: [{ loc: ['body', 'questions'], msg: 'Field required', type: 'missing' }] } }, code: 'JEV_BAD_REQUEST', calls: 1 },
    {
      name: '422 whose echoed input mentions max_tokens_exceeded',
      reply: { status: 422, body: { detail: [{ loc: ['body', 'state'], msg: 'bad', type: 'value_error', input: 'max_tokens_exceeded' }] } },
      code: 'JEV_BAD_REQUEST',
      calls: 1,
    },
    { name: '429 every time', reply: { status: 429, body: { detail: 'Rate limited' } }, code: 'JEV_RATE_LIMITED', calls: 3 },
    { name: '529 every time', reply: { status: 529, body: { detail: 'Overloaded' } }, code: 'JEV_RATE_LIMITED', calls: 3 },
    { name: '500 every time', reply: { status: 500, body: { detail: 'Internal error' } }, code: 'JEV_UNAVAILABLE', calls: 3 },
    { name: '502 every time', reply: { status: 502, raw: 'Bad Gateway' }, code: 'JEV_UNAVAILABLE', calls: 3 },
    { name: '503 every time', reply: { status: 503, raw: '' }, code: 'JEV_UNAVAILABLE', calls: 3 },
    { name: '408 every time', reply: { status: 408, raw: '' }, code: 'JEV_UNAVAILABLE', calls: 3 },
    { name: '201', reply: { status: 201, body: {} }, code: 'JEV_BAD_RESPONSE', calls: 1 },
  ];
  for (const { name, reply, code, calls } of cases) {
    it(`maps ${name} to ${code} after ${calls} call(s)`, async () => {
      always(reply);
      const error = await rejection(stubClient(stub, KEY).ask(sampleRequest()));
      assert.equal(error.code, code);
      assert.equal(error.status, reply.status);
      assert.equal(error.attempts, calls);
      assert.equal(stub.calls.length, calls);
      if (calls > 1) assert.match(error.message, new RegExp(`已尝试 ${calls} 次`));
    });
  }

  it('keeps machine-readable reasons of a 422 but not its text', async () => {
    always({ status: 422, body: { detail: [{ loc: ['body', 'questions'], msg: 'Field required here', type: 'missing' }] } });
    const error = await rejection(stubClient(stub, KEY).ask(sampleRequest()));
    assert.deepEqual(error.reasons, ['missing']);
    assert.ok(!exposed(error).includes('Field required here'));
  });

  it('does not follow a redirect', async () => {
    stub.handler = (call, index) => (index === 0 ? { status: 302, headers: { location: `${stub.baseUrl}/elsewhere` } } : vendorReply(call, KEY, index));
    const error = await rejection(stubClient(stub, KEY).ask(sampleRequest()));
    assert.equal(error.code, 'JEV_UNAVAILABLE');
    assert.equal(error.status, 302);
    assert.equal(stub.calls.length, 1);
  });

  it('retries a dropped connection and then succeeds', async () => {
    stub.handler = (call, index) => (index === 0 ? { destroy: true } : vendorReply(call, KEY, index));
    const response = await stubClient(stub, KEY).ask(sampleRequest());
    assert.equal(response.model, MODEL);
    assert.equal(stub.calls.length, 2);
  });

  it('reports a network failure as JEV_UNAVAILABLE once the retries are used up', async () => {
    always({ destroy: true });
    const error = await rejection(stubClient(stub, KEY).ask(sampleRequest()));
    assert.equal(error.code, 'JEV_UNAVAILABLE');
    assert.equal(error.status, null);
    assert.equal(stub.calls.length, 3);
    assert.match(error.message, /连不上 Jev 服务/);
  });

  it('times out an attempt that gets no answer, and retries it', async () => {
    always({ hang: true });
    const started = Date.now();
    const error = await rejection(stubClient(stub, KEY, { timeoutMs: 150, retries: 1 }).ask(sampleRequest()));
    assert.equal(error.code, 'JEV_UNAVAILABLE');
    assert.match(error.message, /超时/);
    assert.equal(error.attempts, 2);
    assert.equal(stub.calls.length, 2);
    assert.ok(Date.now() - started >= 280);
  });

  it('times out an attempt whose body stalls half way', async () => {
    always({ status: 200, stall: '{"model":"jev-1.13.0","answ' });
    const error = await rejection(stubClient(stub, KEY, { timeoutMs: 150, retries: 0 }).ask(sampleRequest()));
    assert.equal(error.code, 'JEV_UNAVAILABLE');
    assert.match(error.message, /超时/);
    assert.equal(stub.calls.length, 1);
  });
});

describe('HttpJev retry timing', () => {
  async function delaysFor(first: StubReply, options: { random?: () => number; now?: () => number; retries?: number } = {}): Promise<number[]> {
    const delays: number[] = [];
    stub.calls.length = 0;
    stub.handler = (call, index) => (index === 0 ? first : vendorReply(call, KEY, index));
    await stubClient(stub, KEY, { ...options, sleep: async (ms) => void delays.push(ms) }).ask(sampleRequest());
    return delays;
  }

  it('waits for Retry-After after a 429 and then succeeds', async () => {
    assert.deepEqual(await delaysFor({ status: 429, headers: { 'retry-after': '2' }, body: { detail: 'Rate limited' } }), [2000]);
    assert.equal(stub.calls.length, 2);
  });

  it('prefers retry-after-ms over Retry-After', async () => {
    assert.deepEqual(await delaysFor({ status: 429, headers: { 'retry-after-ms': '1500', 'retry-after': '9' } }), [1500]);
  });

  it('waits up to 60 s when asked, and fails at once when the service asks for a longer pause', async () => {
    assert.deepEqual(await delaysFor({ status: 429, headers: { 'retry-after': '60' } }), [60_000]);
    const longer: Array<[number, Record<string, string>, JevErrorCode]> = [
      [429, { 'retry-after': '120' }, 'JEV_RATE_LIMITED'],
      [429, { 'retry-after': '3600' }, 'JEV_RATE_LIMITED'],
      [529, { 'retry-after-ms': '90000' }, 'JEV_RATE_LIMITED'],
      [503, { 'retry-after': '3600' }, 'JEV_UNAVAILABLE'],
    ];
    for (const [status, headers, code] of longer) {
      stub.calls.length = 0;
      const delays: number[] = [];
      always({ status, headers, body: { detail: 'later' } });
      const error = await rejection(stubClient(stub, KEY, { sleep: async (ms) => void delays.push(ms) }).ask(sampleRequest()));
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      assert.equal(error.attempts, 1);
      assert.match(error.message, /要求等待/);
      assert.deepEqual(delays, []);
      assert.equal(stub.calls.length, 1);
    }
  });

  it('reads the three HTTP-date forms of RFC 9110, always as GMT, against the injected clock', async () => {
    const now = Date.UTC(2026, 9, 22, 8, 0, 0);
    assert.equal(new Date(now + 7000).toUTCString(), 'Thu, 22 Oct 2026 08:00:07 GMT');
    for (const date of ['Thu, 22 Oct 2026 08:00:07 GMT', 'Thursday, 22-Oct-26 08:00:07 GMT', 'Thu Oct 22 08:00:07 2026']) {
      assert.deepEqual(await delaysFor({ status: 503, headers: { 'retry-after': date } }, { now: () => now }), [7000], date);
    }
    const second = Date.UTC(2026, 9, 2, 8, 0, 0);
    assert.deepEqual(await delaysFor({ status: 503, headers: { 'retry-after': 'Fri Oct  2 08:00:07 2026' } }, { now: () => second }), [7000]);
    // A date already past asks for no wait; a two-digit year more than 50 years ahead is read as the past one.
    assert.deepEqual(await delaysFor({ status: 503, headers: { 'retry-after': 'Sun, 06 Nov 1994 08:49:37 GMT' } }, { now: () => now }), [0]);
    assert.deepEqual(await delaysFor({ status: 503, headers: { 'retry-after': 'Sunday, 06-Nov-94 08:49:37 GMT' } }, { now: () => now }), [0]);
  });

  it('falls back to exponential backoff for an unreadable Retry-After instead of retrying at once', async () => {
    const unreadable = [
      'soon',
      '-1',
      '-5',
      '+5',
      '5, 10',
      '5 5',
      '1 2',
      'Retry 10',
      'later 2030',
      'Thu, 22 Oct 2026 08:00:07 UTC',
      'Thu, 32 Oct 2026 08:00:07 GMT',
      'Thu, 22 Oct 2026 24:00:07 GMT',
      'Thu, 22 oct 2026 08:00:07 GMT',
      'Thu Oct 22 08:00:07 2026 GMT',
    ];
    for (const value of unreadable) {
      assert.deepEqual(await delaysFor({ status: 429, headers: { 'retry-after': value } }), [500], value);
    }
  });

  it('backs off 0.5 s doubling to 5 s, with jitter from the injected random', async () => {
    const run = async (random: () => number, retries: number): Promise<number[]> => {
      const delays: number[] = [];
      stub.calls.length = 0;
      stub.handler = (call, index) => (index < retries ? { status: 500 } : vendorReply(call, KEY, index));
      await stubClient(stub, KEY, { retries, random, sleep: async (ms) => void delays.push(ms) }).ask(sampleRequest());
      return delays;
    };
    assert.deepEqual(await run(() => 0, 2), [500, 1000]);
    assert.deepEqual(await run(() => 1, 2), [375, 750]);
    assert.deepEqual(await run(() => 0, 5), [500, 1000, 2000, 4000, 5000]);
  });

  it('makes exactly one attempt with retries 0', async () => {
    always({ status: 429 });
    const error = await rejection(stubClient(stub, KEY, { retries: 0 }).ask(sampleRequest()));
    assert.equal(error.code, 'JEV_RATE_LIMITED');
    assert.equal(stub.calls.length, 1);
    assert.doesNotMatch(error.message, /已尝试/);
  });
});

describe('HttpJev response validation', () => {
  const body = validBody;
  const without = (id: string): Record<string, unknown> => {
    const value = validBody();
    delete (value.answers as Record<string, unknown>)[id];
    return value;
  };
  const plus = (id: string, answer: unknown): Record<string, unknown> => {
    const value = validBody();
    (value.answers as Record<string, unknown>)[id] = answer;
    return value;
  };
  const malformed: Array<{ name: string; reply: StubReply; why: RegExp }> = [
    { name: 'text that is not JSON', reply: { raw: 'not json' }, why: /不是合法的 JSON/ },
    { name: 'a JSON array', reply: { raw: '[]' }, why: /不是 JSON 对象/ },
    { name: 'a NaN literal', reply: { raw: JSON.stringify(body()).replace('"noul":0.8', '"noul":NaN') }, why: /不是合法的 JSON/ },
    { name: 'an overflowing number (Infinity)', reply: { raw: JSON.stringify(body()).replace('"noul":0.8', '"noul":1e999') }, why: /q1 的 noul 不是/ },
    { name: 'invalid UTF-8', reply: { bytes: Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]) }, why: /UTF-8/ },
    { name: 'a missing model', reply: { body: { ...body(), model: undefined } }, why: /缺少模型名/ },
    { name: 'a different versioned model', reply: { body: { ...body(), model: 'jev-1.14.0' } }, why: /不是固定的 jev-1\.13\.0/ },
    { name: 'an alias instead of the pinned model', reply: { body: { ...body(), model: 'jev-latest' } }, why: /不是固定的 jev-1\.13\.0/ },
    { name: 'missing answers', reply: { body: { ...body(), answers: undefined } }, why: /缺少 answers/ },
    { name: 'answers that are null', reply: { body: { ...body(), answers: null } }, why: /缺少 answers/ },
    { name: 'a missing answer', reply: { body: without('q3') }, why: /问题 q3 没有回答/ },
    { name: 'an extra answer', reply: { body: plus('q4', { type: 'noul', noul: 0.5 }) }, why: /1 个回答不对应所问的问题/ },
    {
      name: 'the same answer key twice',
      reply: { raw: JSON.stringify(body()).replace('"answers":{', '"answers":{"q1":{"type":"noul","noul":0.1},') },
      why: /重复的键/,
    },
    { name: 'a wrong answer type', reply: { body: withAnswer('q1', (answer) => Object.assign(answer, { type: 'score' })) }, why: /q1 的回答类型不是 noul/ },
    { name: 'a choice outside the options', reply: { body: withAnswer('q2', (answer) => (answer.choice = 'sectionC')) }, why: /q2 选的项不在所给的选项里/ },
    { name: 'a choice that is not the most probable', reply: { body: withAnswer('q2', (answer) => (answer.choice = 'none')) }, why: /q2 选的项不是概率最高的项/ },
    {
      name: 'probabilities missing an option',
      reply: { body: withAnswer('q2', (answer) => (answer.probabilities = { sectionA: 0.8, sectionB: 0.2 })) },
      why: /q2 的 probabilities 与问题的候选项不是同一组/,
    },
    {
      name: 'probabilities with an extra option',
      reply: { body: withAnswer('q2', (answer) => (answer.probabilities = { sectionA: 0.6, sectionB: 0.2, none: 0.2, other: 0 })) },
      why: /q2 的 probabilities 与问题的候选项不是同一组/,
    },
    {
      name: 'a probability given as a string',
      reply: { body: withAnswer('q2', (answer) => (answer.probabilities = { sectionA: '0.6', sectionB: 0.2, none: 0.2 })) },
      why: /q2 有不是 0 到 1 之间有限数的概率/,
    },
    {
      name: 'a probability above 1',
      reply: { body: withAnswer('q2', (answer) => (answer.probabilities = { sectionA: 1.2, sectionB: -0.1, none: -0.1 })) },
      why: /q2 有不是 0 到 1 之间有限数的概率/,
    },
    {
      name: 'a negative probability',
      reply: { body: withAnswer('q2', (answer) => (answer.probabilities = { sectionA: 0.7, sectionB: 0.4, none: -0.1 })) },
      why: /q2 有不是 0 到 1 之间有限数的概率/,
    },
    {
      name: 'probabilities summing to 2',
      reply: { body: withAnswer('q2', (answer) => (answer.probabilities = { sectionA: 1, sectionB: 0.5, none: 0.5 })) },
      why: /q2 的概率之和是 2，/,
    },
    {
      name: 'probabilities summing to 0.998',
      reply: { body: withAnswer('q2', (answer) => (answer.probabilities = { sectionA: 0.598, sectionB: 0.2, none: 0.2 })) },
      why: /q2 的概率之和是 0\.998，/,
    },
    { name: 'a confidence above 1', reply: { body: withAnswer('q2', (answer) => (answer.confidence = 1.5)) }, why: /q2 的 confidence 不是/ },
    { name: 'a missing confidence', reply: { body: withAnswer('q3', (answer) => delete answer.confidence) }, why: /q3 的 confidence 不是/ },
    { name: 'a noul above 1', reply: { body: withAnswer('q1', (answer) => (answer.noul = 1.01)) }, why: /q1 的 noul 不是/ },
    { name: 'a missing noul', reply: { body: withAnswer('q1', (answer) => delete answer.noul) }, why: /q1 的 noul 不是/ },
    { name: 'a score above the top level', reply: { body: withAnswer('q3', (answer) => (answer.score = 3)) }, why: /q3 的 score 不在 0 到 2 之间/ },
    { name: 'a score that contradicts its probabilities', reply: { body: withAnswer('q3', (answer) => (answer.score = 0.2)) }, why: /q3 的 score 与各等级的概率不符/ },
    {
      name: 'legend keys that are not 0..n-1',
      reply: { body: withAnswer('q3', (answer) => (answer.legend = { 1: 'vague', 2: 'somewhat', 3: 'exact' })) },
      why: /q3 的 legend 的键不是 0 到 2/,
    },
    { name: 'a missing legend', reply: { body: withAnswer('q3', (answer) => delete answer.legend) }, why: /q3 的 legend 的键不是 0 到 2/ },
    { name: 'a null legend value', reply: { body: withAnswer('q3', (answer) => (answer.legend = { 0: 'vague', 1: null, 2: 'exact' })) }, why: /q3 的 legend 取值不合格/ },
    {
      name: 'score probabilities keyed by level names',
      reply: { body: withAnswer('q3', (answer) => (answer.probabilities = { vague: 0.15, somewhat: 0.15, exact: 0.7 })) },
      why: /q3 的 probabilities 与问题的候选项不是同一组/,
    },
    { name: 'missing usage', reply: { body: { ...body(), usage: undefined } }, why: /usage/ },
    { name: 'a negative token count', reply: { body: { ...body(), usage: { input_tokens: -1, output_tokens: 3 } } }, why: /usage/ },
    { name: 'a fractional token count', reply: { body: { ...body(), usage: { input_tokens: 1.5, output_tokens: 3 } } }, why: /usage/ },
  ];
  for (const { name, reply, why } of malformed) {
    it(`rejects ${name} as JEV_BAD_RESPONSE without retrying`, async () => {
      always({ status: 200, ...reply });
      const error = await rejection(stubClient(stub, KEY).ask(sampleRequest()));
      assert.equal(error.code, 'JEV_BAD_RESPONSE');
      assert.match(error.message, why);
      assert.equal(stub.calls.length, 1);
    });
  }

  it('names the question whose answer failed', async () => {
    always({ status: 200, body: withAnswer('q2', (answer) => (answer.choice = 'sectionC')) });
    const error = await rejection(stubClient(stub, KEY).ask(sampleRequest()));
    assert.equal(error.questionId, 'q2');
    assert.equal(error.requestId, null);
  });

  it('refuses a response larger than maxResponseBytes', async () => {
    const error = await rejection(stubClient(stub, KEY, { maxResponseBytes: 64 }).ask(sampleRequest()));
    assert.equal(error.code, 'JEV_BAD_RESPONSE');
    assert.match(error.message, /超过 64 字节/);
  });
});

describe('HttpJev secrecy', () => {
  const SENTINEL = '回显的用例原文-SENTINEL-7f3a';

  it('never puts a 422 body, its echoed request content or the key into the error', async () => {
    always({
      status: 422,
      body: { detail: [{ loc: ['body', 'state'], msg: `bad value ${SENTINEL}`, type: 'value_error', input: `${SENTINEL} ${KEY}` }] },
    });
    const error = await rejection(stubClient(stub, KEY).ask(sampleRequest()));
    assert.equal(error.code, 'JEV_BAD_REQUEST');
    assert.deepEqual(error.reasons, ['value_error']);
    assert.ok(!exposed(error).includes(SENTINEL));
    assert.ok(!exposed(error).includes(KEY));
  });

  it('never puts the body of a 400, 401 or 5xx into the error', async () => {
    for (const status of [400, 401, 500]) {
      stub.calls.length = 0;
      always({ status, raw: `${SENTINEL} key=${KEY}` });
      const error = await rejection(stubClient(stub, KEY).ask(sampleRequest()));
      assert.ok(!exposed(error).includes(SENTINEL), `status ${status}`);
      assert.ok(!exposed(error).includes(KEY), `status ${status}`);
    }
  });

  it('never puts the content of a malformed response into the error', async () => {
    always({ status: 200, body: withAnswer('q2', (answer) => (answer.choice = SENTINEL)) });
    const error = await rejection(stubClient(stub, KEY).ask(sampleRequest()));
    assert.equal(error.code, 'JEV_BAD_RESPONSE');
    assert.ok(!exposed(error).includes(SENTINEL));
  });

  it('reports a failing key source without its message and sends nothing', async () => {
    const client = stubClient(stub, KEY, {
      apiKey: () => {
        throw new Error(`vault said ${KEY}`);
      },
    });
    const error = await rejection(client.ask(sampleRequest()));
    assert.equal(error.code, 'JEV_UNAUTHORIZED');
    assert.ok(!exposed(error).includes(KEY));
    assert.equal(error.attempts, 0);
    assert.equal(stub.calls.length, 0);
  });

  it('refuses a key that is not a Bearer token, without quoting it', async () => {
    for (const bad of ['', `${KEY}\r\nX-Injected: 1`, `${KEY} extra`, `${KEY}"`, `${KEY}\\`, `${KEY}é`, 'x'.repeat(4097)]) {
      const error = await rejection(stubClient(stub, KEY, { apiKey: () => bad }).ask(sampleRequest()));
      assert.equal(error.code, 'JEV_UNAUTHORIZED');
      assert.ok(!exposed(error).includes(KEY));
      assert.equal(error.attempts, 0);
    }
    assert.equal(stub.calls.length, 0);
  });

  it('bounds a key source that never settles by the attempt timeout, and sends nothing', async () => {
    let calls = 0;
    const client = stubClient(stub, KEY, {
      timeoutMs: 100,
      apiKey: () => {
        calls++;
        return new Promise<string>(() => undefined);
      },
    });
    const started = Date.now();
    const error = await rejection(within(client.ask(sampleRequest()), 2000));
    assert.equal(error.code, 'JEV_UNAUTHORIZED');
    assert.match(error.message, /密钥超时/);
    assert.equal(error.attempts, 0);
    assert.equal(calls, 1);
    assert.equal(stub.calls.length, 0);
    assert.ok(Date.now() - started >= 90);
  });

  it('keeps the failure of the request before when the key source fails on a retry', async () => {
    always({ status: 503, headers: { 'x-typesafe-request-id': 'req_busy_1' }, body: { detail: 'busy' } });
    let calls = 0;
    const client = stubClient(stub, KEY, {
      apiKey: () => {
        if (calls++ === 0) return KEY;
        throw new Error(`vault said ${KEY}`);
      },
    });
    const error = await rejection(client.ask(sampleRequest()));
    assert.equal(error.code, 'JEV_UNAVAILABLE');
    assert.equal(error.status, 503);
    assert.equal(error.requestId, 'req_busy_1');
    assert.equal(error.attempts, 1);
    assert.match(error.message, /HTTP 503/);
    assert.match(error.message, /取 Jev API 密钥失败/);
    assert.doesNotMatch(error.message, /已尝试/);
    assert.ok(!exposed(error).includes(KEY));
    assert.equal(stub.calls.length, 1);
  });

  it('counts only the requests that were sent', async () => {
    always({ status: 503, body: { detail: 'busy' } });
    let calls = 0;
    const client = stubClient(stub, KEY, {
      apiKey: () => {
        if (calls++ < 2) return KEY;
        throw new Error('vault locked');
      },
    });
    const error = await rejection(client.ask(sampleRequest()));
    assert.equal(error.attempts, 2);
    assert.match(error.message, /已尝试 2 次/);
    assert.equal(stub.calls.length, 2);
  });

  it('accepts the Bearer token alphabet, padding included', async () => {
    const token = 'AZaz09-._~+/abc==';
    stub.handler = (call, index) => vendorReply(call, token, index);
    await stubClient(stub, token).ask(sampleRequest());
    assert.equal(stub.calls[0]!.headers.authorization, `Bearer ${token}`);
  });

  // inspect and JSON.stringify never show private fields, so only the call count can show that no key is cached.
  it('asks the key source on every attempt, so the client keeps no key between attempts or calls', async () => {
    let calls = 0;
    stub.handler = (call, index) => (index % 2 === 0 ? { status: 503, body: { detail: 'busy' } } : vendorReply(call, KEY, index));
    const client = stubClient(stub, KEY, {
      apiKey: () => {
        calls++;
        return KEY;
      },
    });
    await client.ask(sampleRequest());
    await client.ask(sampleRequest());
    assert.equal(stub.calls.length, 4);
    assert.equal(calls, 4);
    assert.ok(!inspect(client, { depth: 5, showHidden: true }).includes(KEY));
    assert.ok(!JSON.stringify(client).includes(KEY));
  });

  it('refuses a valid-looking response that echoes the key, literally or escaped', async () => {
    const escaped = `\\u${KEY.charCodeAt(0).toString(16).padStart(4, '0')}${KEY.slice(1)}`;
    for (const echo of [KEY, escaped]) {
      stub.calls.length = 0;
      const echoing = withAnswer('q3', (answer) => (answer.legend = { 0: 'vague', 1: 'somewhat', 2: 'ECHO' }));
      always({ status: 200, raw: JSON.stringify(echoing).replace('ECHO', echo) });
      const error = await rejection(stubClient(stub, KEY).ask(sampleRequest()));
      assert.equal(error.code, 'JEV_BAD_RESPONSE');
      assert.match(error.message, /API 密钥/);
      assert.ok(!exposed(error).includes(KEY));
      assert.equal(stub.calls.length, 1);
    }
  });

  it('does not let an escaped echo of the key into a validation message', async () => {
    const escaped = `\\u${KEY.charCodeAt(0).toString(16).padStart(4, '0')}${KEY.slice(1)}`;
    always({ status: 200, raw: JSON.stringify({ ...validBody(), model: 'ECHO' }).replace('ECHO', escaped) });
    const error = await rejection(stubClient(stub, KEY).ask(sampleRequest()));
    assert.equal(error.code, 'JEV_BAD_RESPONSE');
    assert.ok(!exposed(error).includes(KEY));
  });

  it('drops a request id that echoes the key', async () => {
    stub.handler = (call, index) => {
      const reply = vendorReply(call, KEY, index);
      return { ...reply, headers: { 'x-typesafe-request-id': `req-${KEY}` } };
    };
    const response = await stubClient(stub, KEY).ask(sampleRequest());
    assert.equal(response.requestId, undefined);
    always({ status: 400, headers: { 'x-typesafe-request-id': KEY }, body: { detail: 'bad' } });
    const error = await rejection(stubClient(stub, KEY).ask(sampleRequest()));
    assert.equal(error.requestId, null);
    assert.ok(!exposed(error).includes(KEY));
  });

  it('drops an error reason that echoes the key', async () => {
    const token = `tskey_${'0123456789abcdef'.repeat(2)}`;
    always({ status: 422, body: { detail: [{ loc: ['body'], msg: 'bad', type: token }, { loc: ['body'], msg: 'bad', type: 'missing' }] } });
    const error = await rejection(stubClient(stub, token).ask(sampleRequest()));
    assert.deepEqual(error.reasons, ['missing']);
    assert.ok(!exposed(error).includes(token));
  });

  it('treats a run of 12 key characters as an echo of the key', async () => {
    const nearly = KEY.slice(0, -3);
    const run = KEY.slice(10, 22);
    always({ status: 200, body: { ...validBody(), model: nearly } });
    const drifted = await rejection(stubClient(stub, KEY).ask(sampleRequest()));
    assert.equal(drifted.code, 'JEV_BAD_RESPONSE');
    assert.ok(!exposed(drifted).includes(run));
    for (const echo of [nearly, run, `x${run}y`]) {
      stub.calls.length = 0;
      always({ status: 200, body: withAnswer('q3', (answer) => (answer.legend = { 0: 'vague', 1: 'somewhat', 2: echo })) });
      const error = await rejection(stubClient(stub, KEY).ask(sampleRequest()));
      assert.equal(error.code, 'JEV_BAD_RESPONSE');
      assert.match(error.message, /API 密钥/);
      assert.ok(!exposed(error).includes(run));
      assert.equal(stub.calls.length, 1);
    }
    stub.handler = (call, index) => ({ ...vendorReply(call, KEY, index), headers: { 'x-typesafe-request-id': `req-${run}` } });
    assert.equal((await stubClient(stub, KEY).ask(sampleRequest())).requestId, undefined);
    always({ status: 400, headers: { 'x-typesafe-request-id': `req-${run}` }, body: { detail: 'bad' } });
    const refused = await rejection(stubClient(stub, KEY).ask(sampleRequest()));
    assert.equal(refused.requestId, null);
    assert.ok(!exposed(refused).includes(run));
    const token = `tskey_${'abcdefghijklmnop'.repeat(2)}`;
    always({ status: 422, body: { detail: [{ loc: ['body'], msg: 'bad', type: `x${token.slice(3, 20)}y` }, { loc: ['body'], msg: 'bad', type: 'missing' }] } });
    const reasons = await rejection(stubClient(stub, token).ask(sampleRequest()));
    assert.deepEqual(reasons.reasons, ['missing']);
  });

  it('keeps a request id of the safe alphabet and drops any other', async () => {
    for (const [id, kept] of [
      ['req_01HXYZ-abc.9:2', true],
      ['req"x', false],
      ['req<x>', false],
      ['req/x+y=', false],
      ['r'.repeat(129), false],
    ] as const) {
      stub.handler = (call, index) => ({ ...vendorReply(call, KEY, index), headers: { 'x-typesafe-request-id': id } });
      assert.equal((await stubClient(stub, KEY).ask(sampleRequest())).requestId, kept ? id : undefined, id);
    }
  });

  it('does not quote the model the service returned in a mismatch', async () => {
    always({ status: 200, body: { ...validBody(), model: 'jev-9.9.9' } });
    const error = await rejection(stubClient(stub, KEY).ask(sampleRequest()));
    assert.equal(error.code, 'JEV_BAD_RESPONSE');
    assert.match(error.message, /不是固定的 jev-1\.13\.0/);
    assert.ok(!error.message.includes('jev-9.9.9'));
  });

  it('takes reasons only from where an error body names its cause, never from a copy of the request', async () => {
    stub.handler = (call) => ({
      status: 400,
      body: { error: { message: 'bad' }, original: { ...JSON.parse(call.body), state: { item: { code: 'case_secret_42', type: 'internal_route_x' } } } },
    });
    const error = await rejection(stubClient(stub, KEY).ask(sampleRequest()));
    assert.equal(error.code, 'JEV_BAD_REQUEST');
    assert.deepEqual(error.reasons, []);
  });

  it('does not read the context-limit marker out of the echoed input of a body cut at 64 KiB', async () => {
    always({ status: 422, body: { detail: [{ loc: ['body', 'state'], msg: 'bad', type: 'value_error', input: `max_tokens_exceeded ${'示例'.repeat(40_000)}` }] } });
    const error = await rejection(stubClient(stub, KEY).ask(sampleRequest()));
    assert.equal(error.code, 'JEV_BAD_REQUEST');
    assert.deepEqual(error.reasons, []);
  });

  it('still finds the marker before the echoed input of a body cut at 64 KiB', async () => {
    always({ status: 400, body: { detail: [{ type: 'max_tokens_exceeded', loc: ['body'], msg: 'too long', input: '示例'.repeat(40_000) }] } });
    const error = await rejection(stubClient(stub, KEY).ask(sampleRequest()));
    assert.equal(error.code, 'JEV_TOO_LARGE');
  });
});

describe('HttpJev model pinning', () => {
  for (const model of ['jev-latest', 'jev-preview', 'jev', 'latest', 'jev-1.13', 'jev-1.13.0-rc1', 'JEV-1.13.0']) {
    it(`refuses ${model} without allowAlias`, () => {
      assert.throws(
        () => new HttpJev({ apiKey: () => KEY, model, baseUrl: stub.baseUrl, fetch: loopbackFetch }),
        (error: unknown) => error instanceof JevError && error.code === 'JEV_BAD_REQUEST' && /确切版本/.test(error.message),
      );
    });
  }

  it('accepts versioned ids', () => {
    for (const model of ['jev-1.13.0', 'jev-1.14.0', 'jev-10.0.12']) {
      assert.equal(new HttpJev({ apiKey: () => KEY, model, baseUrl: stub.baseUrl, fetch: loopbackFetch }).pinnedModel, model);
    }
  });

  it('allows an alias with allowAlias and keeps whatever model the service names', async () => {
    const client = stubClient(stub, KEY, { model: 'jev-latest', allowAlias: true });
    assert.equal((await client.ask(sampleRequest('jev-latest'))).model, 'jev-latest');
    stub.handler = (call, index) => {
      const reply = vendorReply(call, KEY, index);
      return { ...reply, body: { ...(reply.body as object), model: 'jev-1.13.0' } };
    };
    assert.equal((await client.ask(sampleRequest('jev-latest'))).model, 'jev-1.13.0');
  });

  it('refuses a request that names another model than the pinned one, before sending', async () => {
    const error = await rejection(stubClient(stub, KEY).ask(sampleRequest('jev-1.14.0')));
    assert.equal(error.code, 'JEV_BAD_REQUEST');
    assert.equal(stub.calls.length, 0);
  });
});

describe('HttpJev request limits', () => {
  function choiceRequest(options: number): JevRequest {
    const criteria: Record<string, string | null> = {};
    for (let index = 0; index < options; index++) criteria[`opt${index}`] = index % 2 === 0 ? `说明 ${index}` : null;
    return { model: MODEL, state: '示例片段', questions: { q: { type: 'choice', instructions: 'Which option fits the state?', criteria } } };
  }

  function scoreRequest(levels: number): JevRequest {
    return { model: MODEL, state: '示例片段', questions: { q: { type: 'score', instructions: 'Rate the state.', criteria: Array.from({ length: levels }, (_, i) => `level ${i}`) } } };
  }

  function nested(levels: number): { [key: string]: JevJson } {
    let value: { [key: string]: JevJson } = {};
    for (let index = 1; index < levels; index++) value = { a: value };
    return value;
  }

  it('sends 255 options and refuses 256 before sending', async () => {
    const response = await stubClient(stub, KEY).ask(choiceRequest(255));
    assert.equal(Object.keys((response.answers.q as JevChoiceAnswer).probabilities).length, 255);
    stub.calls.length = 0;
    const error = await rejection(stubClient(stub, KEY).ask(choiceRequest(256)));
    assert.equal(error.code, 'JEV_BAD_REQUEST');
    assert.match(error.message, /256 个选项/);
    assert.equal(error.attempts, 0);
    assert.equal(stub.calls.length, 0);
  });

  it('sends 2 and 10 score levels and refuses 1 and 11', async () => {
    await stubClient(stub, KEY).ask(scoreRequest(2));
    await stubClient(stub, KEY).ask(scoreRequest(10));
    assert.equal(stub.calls.length, 2);
    for (const levels of [1, 11]) {
      const error = await rejection(stubClient(stub, KEY).ask(scoreRequest(levels)));
      assert.equal(error.code, 'JEV_BAD_REQUEST');
    }
    assert.equal(stub.calls.length, 2);
  });

  it('refuses a body above maxRequestBytes as JEV_TOO_LARGE before sending', async () => {
    const request: JevRequest = { ...sampleRequest(), state: { item: { text: '示'.repeat(1000) } } };
    const error = await rejection(stubClient(stub, KEY, { maxRequestBytes: 2048 }).ask(request));
    assert.equal(error.code, 'JEV_TOO_LARGE');
    assert.equal(error.attempts, 0);
    assert.equal(stub.calls.length, 0);
    await stubClient(stub, KEY, { maxRequestBytes: 8192 }).ask(request);
    assert.equal(stub.calls.length, 1);
  });

  it('allows nesting up to 64 levels and refuses 65, before sending', async () => {
    await stubClient(stub, KEY).ask({ ...sampleRequest(), state: nested(63) });
    assert.equal(stub.calls.length, 1);
    const error = await rejection(stubClient(stub, KEY).ask({ ...sampleRequest(), state: nested(64) }));
    assert.equal(error.code, 'JEV_BAD_REQUEST');
    assert.match(error.message, /64 层/);
    assert.equal(stub.calls.length, 1);
  });

  it('refuses non-JSON state values before sending', async () => {
    const sparse: unknown[] = [];
    sparse[2] = 'x';
    const bad: unknown[] = [Number.NaN, Number.POSITIVE_INFINITY, '\ud800', new Date(0), 1n, () => 1, [undefined], sparse, new Map()];
    for (const value of bad) {
      const request = { ...sampleRequest(), state: { item: { value } } } as unknown as JevRequest;
      const error = await rejection(stubClient(stub, KEY).ask(request));
      assert.equal(error.code, 'JEV_BAD_REQUEST', `value ${String(value)}`);
    }
    assert.equal(stub.calls.length, 0);
  });

  it('refuses a request without questions and a box question', async () => {
    for (const questions of [{}, { q: { type: 'box', instructions: 'Locate it.' } }]) {
      const error = await rejection(stubClient(stub, KEY).ask({ ...sampleRequest(), questions } as unknown as JevRequest));
      assert.equal(error.code, 'JEV_BAD_REQUEST');
    }
    assert.equal(stub.calls.length, 0);
  });
});

describe('HttpJev configuration', () => {
  const base = { apiKey: () => KEY, model: MODEL, fetch: loopbackFetch };

  it('defaults to the vendor base URL without contacting it', () => {
    assert.equal(new HttpJev(base).pinnedModel, MODEL);
  });

  it('refuses plain http except to loopback hosts', () => {
    assert.throws(() => new HttpJev({ ...base, baseUrl: 'http://192.0.2.10' }), (error: unknown) => error instanceof JevError && error.code === 'JEV_BAD_REQUEST');
    for (const baseUrl of ['http://127.0.0.1:9', 'http://localhost:9', 'http://[::1]:9', 'https://192.0.2.10']) new HttpJev({ ...base, baseUrl });
  });

  it('refuses credentials, queries and other schemes in the base URL', () => {
    assert.throws(() => new HttpJev({ ...base, baseUrl: 'https://user:pass@192.0.2.10' }), JevError);
    assert.throws(() => new HttpJev({ ...base, baseUrl: 'https://192.0.2.10/?a=1' }), TypeError);
    assert.throws(() => new HttpJev({ ...base, baseUrl: 'ftp://192.0.2.10' }), TypeError);
    assert.throws(() => new HttpJev({ ...base, baseUrl: 'not a url' }), TypeError);
  });

  it('refuses out-of-range numeric options', () => {
    assert.throws(() => new HttpJev({ ...base, maxRequestBytes: 33 * 1024 * 1024 }), TypeError);
    assert.throws(() => new HttpJev({ ...base, timeoutMs: 0 }), TypeError);
    assert.throws(() => new HttpJev({ ...base, retries: 11 }), TypeError);
    assert.throws(() => new HttpJev({ ...base, retries: 1.5 }), TypeError);
    assert.throws(() => new HttpJev({ ...base, apiKey: KEY as unknown as () => string }), TypeError);
  });

  it('refuses injected helpers that are not functions', () => {
    for (const name of ['fetch', 'random', 'sleep', 'now']) {
      assert.throws(() => new HttpJev({ ...base, [name]: 42 } as unknown as ConstructorParameters<typeof HttpJev>[0]), TypeError, name);
    }
  });
});
