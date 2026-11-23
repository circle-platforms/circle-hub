import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { after, describe, it } from 'node:test';
import { JEV_DEFAULT_MODEL, JEV_ENDPOINT, JevCallError, JevClient, JevTransportError, jevRetryAfterMilliseconds } from './index.ts';
import type { JevClientConfig, JevRequest, JevTransportRequest } from './index.ts';
import { KEY, MARKERS, answerBody, choiceRequest, clock, json, markerRequest, mixedRequest, noulRequest, okStep, recordingSleep, scoreRequest, scripted, text } from '../../../testing/synthetic.ts';
import type { Step } from '../../../testing/synthetic.ts';

const FORM = /^(参数无效|无权限|暂时不可用)：[^。]+。[^。]+。$/u;
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function make(steps: readonly Step[], config: Partial<JevClientConfig> = {}): { client: JevClient; calls: JevTransportRequest[]; waits: number[] } {
  const { transport, calls } = scripted(steps);
  const { sleep, waits } = recordingSleep();
  return { client: new JevClient({ apiKey: KEY, transport, sleep, ...config }), calls, waits };
}

async function failed(promise: Promise<unknown>): Promise<JevCallError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof JevCallError, String(error));
    assert.match(error.message, FORM);
    return error;
  }
  return assert.fail('the call succeeded');
}

/** Everything a thrown error shows must be free of the key and of every marker. */
function assertClean(error: JevCallError, markers: readonly string[] = Object.values(MARKERS)): void {
  const shown = [error.message, error.stack ?? '', String(error), inspect(error, { depth: 4 }), JSON.stringify({ ...error }), error.name];
  for (const marker of markers) for (const text of shown) assert.ok(!text.includes(marker), `${marker} in ${text.slice(0, 200)}`);
}

const dirs: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jev-judge-test-'));
  dirs.push(dir);
  return dir;
}
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const readLines = async (path: string): Promise<Array<Record<string, unknown>>> =>
  (await readFile(path, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);

describe('the request', () => {
  it('goes to the fixed endpoint with the key in the Authorization header and {state, model, questions} as the body', async () => {
    const { client, calls } = make([okStep]);
    await client.ask(noulRequest);
    assert.equal(calls.length, 1);
    const sent = calls[0]!;
    assert.equal(JEV_ENDPOINT, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(sent.url, JEV_ENDPOINT);
    assert.equal(sent.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(sent.headers['Content-Type'], 'application/json');
    assert.equal(sent.timeoutMs, 30_000);
    assert.deepEqual(Object.keys(JSON.parse(sent.body)), ['state', 'model', 'questions']);
    assert.deepEqual(JSON.parse(sent.body), { state: noulRequest.state, model: JEV_DEFAULT_MODEL, questions: noulRequest.questions });
    assert.equal(JEV_DEFAULT_MODEL, 'jev-latest');
  });

  it('asks the model of the request, else of the client, else jev-latest', async () => {
    const asked = async (config: Partial<JevClientConfig>, request: JevRequest): Promise<string> => {
      const { client, calls } = make([okStep], config);
      await client.ask(request);
      return JSON.parse(calls[0]!.body).model as string;
    };
    assert.equal(await asked({}, noulRequest), 'jev-latest');
    assert.equal(await asked({ model: 'jev-1.14.0' }, noulRequest), 'jev-1.14.0');
    assert.equal(await asked({ model: 'jev-1.14.0' }, { ...noulRequest, model: 'jev-2.0.0' }), 'jev-2.0.0');
  });

  it('hands the timeout of the configuration to the transport', async () => {
    const { client, calls } = make([okStep], { timeoutMs: 12_345 });
    await client.ask(noulRequest);
    assert.equal(calls[0]!.timeoutMs, 12_345);
  });

  it('keeps the options of a single-choice question in the order written', async () => {
    const { client, calls } = make([okStep]);
    await client.ask(choiceRequest);
    assert.deepEqual(Object.keys(JSON.parse(calls[0]!.body).questions.pick.criteria), ['b', 'a', 'none']);
  });

  it('sends nothing and throws 参数无效 when the request is not valid', async () => {
    const { client, calls } = make([okStep]);
    for (const request of [{ state: 'x', questions: {} }, { questions: noulRequest.questions }, { ...noulRequest, apiKey: KEY }, null]) {
      const error = await failed(client.ask(request as unknown as JevRequest));
      assert.equal(error.category, '参数无效');
      assert.equal(error.code, 'invalid_request');
      assert.equal(error.status, 0);
      assert.equal(error.attempts, 0);
      assertClean(error);
    }
    assert.equal(calls.length, 0);
  });

  it('does not change the request it was given and takes a frozen one', async () => {
    const request = structuredClone(mixedRequest);
    const frozen = Object.freeze({ ...request, questions: Object.freeze(request.questions) });
    const { client } = make([okStep]);
    await client.ask(frozen);
    assert.deepEqual(request, mixedRequest);
  });

  it('can be pointed nowhere else: the configuration has no option for an address', async () => {
    for (const name of ['endpoint', 'baseUrl', 'url', 'host', 'proxy', 'agent']) {
      assert.throws(() => new JevClient({ apiKey: KEY, [name]: 'https://example.invalid/' } as unknown as JevClientConfig), (error: unknown) => {
        assert.ok(error instanceof JevCallError);
        assert.equal(error.category, '参数无效');
        assert.equal(error.code, 'invalid_request');
        return true;
      }, name);
    }
    const { client, calls } = make([okStep]);
    await client.ask(noulRequest);
    await client.ask(choiceRequest);
    assert.deepEqual(calls.map((call) => call.url), [JEV_ENDPOINT, JEV_ENDPOINT]);
  });
});

describe('the answer', () => {
  it('has the protocol fields and the disclosure of a model judgment, and nothing else', async () => {
    const { client } = make([okStep]);
    const response = await client.ask(mixedRequest);
    assert.deepEqual(Object.keys(response), ['model', 'model_version', 'status', 'decided_by', 'answers', 'usage']);
    assert.equal(response.model, 'jev-1.14.0');
    assert.equal(response.model_version, 'jev-1.14.0');
    assert.equal(response.status, '未确认');
    assert.equal(response.decided_by, '模型');
    assert.deepEqual(response.usage, { input_tokens: 120, output_tokens: 30 });
    assert.deepEqual(Object.keys(response.answers), ['zeta', 'alpha', 'mid']);
    assert.deepEqual(response.answers.zeta, { type: 'noul', noul: 0.75 });
    assert.deepEqual(response.answers.alpha, { type: 'choice', choice: 'b', probabilities: { b: 0.7, a: 0.3, none: 0 }, confidence: 0.55 });
    assert.deepEqual(response.answers.mid, {
      type: 'score',
      score: 1.6,
      legend: { '0': 'wrong command', '1': 'a command is missing', '2': 'complete and correct' },
      probabilities: { '0': 0, '1': 0.4, '2': 0.6 },
      confidence: 0.5,
    });
  });

  it('answers questions whose ids are the names of object members', async () => {
    const names = ['constructor', 'toString', 'valueOf'];
    const request: JevRequest = { state: 'a state', questions: Object.fromEntries(names.map((name) => [name, { type: 'noul', instructions: 'Is it?' } as const])) };
    const { client } = make([okStep]);
    const response = await client.ask(request);
    assert.deepEqual(Object.keys(response.answers), names);
    for (const name of names) assert.deepEqual(Object.getOwnPropertyDescriptor(response.answers, name)?.value, { type: 'noul', noul: 0.75 }, name);
  });

  it('names the model that answered, not the alias that was asked for', async () => {
    const { client, calls } = make([(request) => json(200, answerBody(request, 'jev-1.14.0'))]);
    const response = await client.ask(noulRequest);
    assert.equal(JSON.parse(calls[0]!.body).model, 'jev-latest');
    assert.equal(response.model_version, 'jev-1.14.0');
  });

  it('drops what the service sent beyond the protocol', async () => {
    const { client } = make([
      (request) => {
        const body = answerBody(request);
        return json(200, { ...body, debug: 'extra', usage: { ...body.usage, billing: 'extra' }, answers: { matches: { ...body.answers.matches, note: 'extra' } } });
      },
    ]);
    const response = await client.ask(noulRequest);
    assert.deepEqual(response, { model: 'jev-1.14.0', model_version: 'jev-1.14.0', status: '未确认', decided_by: '模型', answers: { matches: { type: 'noul', noul: 0.75 } }, usage: { input_tokens: 120, output_tokens: 30 } });
  });

  it('answers a score question with an echo of its levels', async () => {
    const { client } = make([okStep]);
    const response = await client.ask(scoreRequest);
    assert.equal(response.answers.quality!.type, 'score');
  });
});

describe('an answer that is not valid', () => {
  const badAnswers: ReadonlyArray<[string, Step]> = [
    ['text that is not JSON', text(200, 'not json')],
    ['an empty body', text(200, '')],
    ['a JSON array', json(200, [])],
    ['no answers', json(200, { model: 'jev-1.14.0', answers: {}, usage: { input_tokens: 1, output_tokens: 1 } })],
    ['a member named twice', text(200, '{"model":"jev-1.14.0","answers":{"matches":{"type":"noul","noul":0.5},"matches":{"type":"noul","noul":0.6}},"usage":{"input_tokens":1,"output_tokens":1}}')],
    ['a probability above 1', (request) => json(200, { ...answerBody(request), answers: { matches: { type: 'noul', noul: 1.5 } } })],
    ['a status that is not a number', { status: '200' as unknown as number, headers: {}, body: '{}' }],
    ['a status that is not an HTTP status', { status: 99, headers: {}, body: '{}' }],
    ['a body that is not text', { status: 200, headers: {}, body: { model: 'x' } as unknown as string }],
  ];
  for (const [name, step] of badAnswers) {
    it(`is not repaired, guessed or sent again: ${name}`, async () => {
      const { client, calls, waits } = make([step]);
      const error = await failed(client.ask(noulRequest));
      assert.equal(error.category, '暂时不可用');
      assert.equal(error.code, 'invalid_response');
      assert.equal(error.retryable, false);
      assert.equal(calls.length, 1);
      assert.deepEqual(waits, []);
      assertClean(error);
    });
  }

  it('reports the HTTP status and the number of requests with the error', async () => {
    const { client } = make([text(200, 'nope')]);
    const error = await failed(client.ask(noulRequest));
    assert.equal(error.status, 200);
    assert.equal(error.attempts, 1);
  });
});

describe('what the HTTP status says', () => {
  const table: ReadonlyArray<[number, string, string, boolean]> = [
    [401, '无权限', 'unauthorized', false],
    [403, '无权限', 'forbidden', false],
    [400, '参数无效', 'request_rejected', false],
    [422, '参数无效', 'request_rejected', false],
    [413, '参数无效', 'request_too_large', false],
    [429, '暂时不可用', 'rate_limited', true],
    [529, '暂时不可用', 'overloaded', true],
    [500, '暂时不可用', 'service_error', false],
    [502, '暂时不可用', 'service_error', false],
    [503, '暂时不可用', 'service_error', false],
    [504, '暂时不可用', 'service_error', false],
    [408, '暂时不可用', 'unexpected_status', false],
    [404, '暂时不可用', 'unexpected_status', false],
    [409, '暂时不可用', 'unexpected_status', false],
    [418, '暂时不可用', 'unexpected_status', false],
    [301, '暂时不可用', 'unexpected_status', false],
    [302, '暂时不可用', 'unexpected_status', false],
    [201, '暂时不可用', 'unexpected_status', false],
    [204, '暂时不可用', 'unexpected_status', false],
    [100, '暂时不可用', 'unexpected_status', false],
  ];
  for (const [status, category, code, retryable] of table) {
    it(`${status} is ${category} (${code})`, async () => {
      const { client, calls } = make([text(status, JSON.stringify({ detail: [{ type: 'value_error', input: MARKERS.state }] }))]);
      const error = await failed(client.ask(markerRequest()));
      assert.equal(error.category, category);
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      assert.equal(error.retryable, retryable);
      assert.ok(error.message.includes(`HTTP ${status}`), error.message);
      assert.equal(calls.length, retryable ? 2 : 1, 'only a 429 and a 529 are sent again');
      assertClean(error);
    });
  }

  it('keeps 400 and 422 that name the token limit apart, and never shows the body', async () => {
    for (const status of [400, 422]) {
      for (const body of [{ detail: [{ type: 'max_tokens_exceeded', msg: MARKERS.state }] }, { error: { code: 'max_tokens_exceeded', message: MARKERS.state } }, { type: 'max_tokens_exceeded' }]) {
        const { client } = make([json(status, body)]);
        const error = await failed(client.ask(noulRequest));
        assert.equal(error.code, 'context_too_long');
        assert.equal(error.category, '参数无效');
        assert.equal(error.status, status);
        assertClean(error);
      }
    }
    for (const body of ['not json', JSON.stringify({ detail: 'max_tokens_exceeded' }), JSON.stringify({ detail: [{ msg: 'max_tokens_exceeded' }] }), 'x'.repeat(70_000)]) {
      const { client } = make([text(422, body)]);
      assert.equal((await failed(client.ask(noulRequest))).code, 'request_rejected');
    }
  });

  it('turns a request refused with its own content echoed into an error without that content', async () => {
    const request = markerRequest();
    const { client } = make([(sent) => text(422, sent.body)]);
    const error = await failed(client.ask(request));
    assert.equal(error.code, 'request_rejected');
    assertClean(error);
  });
});

describe('sending again', () => {
  it('sends a request again once, after the Retry-After the service gave, when it answers 429 or 529', async () => {
    for (const status of [429, 529]) {
      const { client, calls, waits } = make([text(status, '', { 'retry-after': '1' }), okStep]);
      const response = await client.ask(mixedRequest);
      assert.equal(response.status, '未确认');
      assert.equal(calls.length, 2);
      assert.deepEqual(waits, [1000]);
      assert.equal(calls[1]!.body, calls[0]!.body);
      assert.deepEqual(calls[1]!.headers, calls[0]!.headers);
    }
  });

  it('reads the header whatever its case', async () => {
    for (const name of ['Retry-After', 'RETRY-AFTER', 'retry-after']) {
      const { client, waits } = make([text(429, '', { [name]: '3' }), okStep]);
      await client.ask(noulRequest);
      assert.deepEqual(waits, [3000], name);
    }
  });

  const cases: ReadonlyArray<[string | undefined, number]> = [
    ['1', 1000], ['0', 500], ['0.2', 500], ['0.5', 500], ['2.5', 2500], ['30', 30_000], ['90', 30_000], [' 3 ', 3000], ['1e1', 10_000], ['-5', 500], ['+4', 4000], ['.75', 750],
    ['nan', 2000], ['inf', 2000], ['-inf', 2000], ['Infinity', 2000], ['invalid', 2000], ['', 2000], [' ', 2000], ['1e999', 2000], ['1,2', 2000], ['Wed, 21 Oct 2026 07:28:00 GMT', 2000], [undefined, 2000],
  ];
  for (const [header, expected] of cases) {
    it(`waits ${expected} ms for a Retry-After of ${JSON.stringify(header)}`, async () => {
      assert.equal(jevRetryAfterMilliseconds(header), expected);
      const { client, waits } = make([text(429, '', header === undefined ? {} : { 'retry-after': header }), okStep]);
      await client.ask(noulRequest);
      assert.deepEqual(waits, [expected]);
    });
  }

  it('gives up after the one retry and says the service kept refusing', async () => {
    for (const [status, code] of [[429, 'rate_limited'], [529, 'overloaded']] as const) {
      const { client, calls, waits } = make([text(status, '', { 'retry-after': '2' })]);
      const error = await failed(client.ask(noulRequest));
      assert.equal(error.code, code);
      assert.equal(error.retryable, true);
      assert.equal(error.status, status);
      assert.equal(error.attempts, 2);
      assert.ok(error.message.includes('重试了一次'), error.message);
      assert.equal(calls.length, 2);
      assert.deepEqual(waits, [2000]);
    }
  });

  it('never sends a third time and sends a second time only after a 429 or 529', async () => {
    const third = make([text(429), text(429), okStep]);
    await failed(third.client.ask(noulRequest));
    assert.equal(third.calls.length, 2);
    const other = make([text(429), text(500), okStep]);
    const error = await failed(other.client.ask(noulRequest));
    assert.equal(error.code, 'service_error');
    assert.equal(error.attempts, 2);
    assert.equal(other.calls.length, 2);
    const invalid = make([text(529), text(200, 'nope'), okStep]);
    assert.equal((await failed(invalid.client.ask(noulRequest))).code, 'invalid_response');
    assert.equal(invalid.calls.length, 2);
  });

  it('does not send again after any other failure', async () => {
    for (const status of [400, 401, 403, 408, 413, 422, 500, 502, 503, 504, 301]) {
      const { client, calls, waits } = make([text(status, '', { 'retry-after': '1' }), okStep]);
      await failed(client.ask(noulRequest));
      assert.equal(calls.length, 1, String(status));
      assert.deepEqual(waits, []);
    }
  });

  it('uses the sleep it was given, and by default a real one that returns', async () => {
    const { transport } = scripted([text(429, '', { 'retry-after': '0' }), okStep]);
    const slept: number[] = [];
    const client = new JevClient({ apiKey: KEY, transport, sleep: async (ms) => void slept.push(ms) });
    await client.ask(noulRequest);
    assert.deepEqual(slept, [500]);
  });
});

describe('a timeout and a broken connection', () => {
  it('are not sent again, and the error says the service may have processed and billed the request', async () => {
    const failures: Array<[Error, string]> = [
      [new JevTransportError('timeout'), 'timeout'],
      [new JevTransportError('connection', 'ECONNRESET'), 'connection_lost'],
      [Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), 'connection_lost'],
      [new Error('plain failure'), 'connection_lost'],
      [new TypeError('not even an error of the transport'), 'connection_lost'],
    ];
    for (const [cause, code] of failures) {
      const { client, calls, waits } = make([cause, okStep], { timeoutMs: 4321 });
      const error = await failed(client.ask(noulRequest));
      assert.equal(error.category, '暂时不可用');
      assert.equal(error.code, code);
      assert.equal(error.status, 0);
      assert.equal(error.retryable, false);
      assert.equal(error.attempts, 1);
      assert.equal(calls.length, 1);
      assert.deepEqual(waits, []);
      assert.ok(error.message.includes('没有重发'), error.message);
      assert.ok(error.message.includes('可能已经'), error.message);
      assert.ok(!error.message.includes('socket hang up') && !error.message.includes('plain failure'), error.message);
      if (code === 'timeout') assert.ok(error.message.includes('4321'), error.message);
    }
  });

  it('names the system code of a broken connection, and only when it has the shape of one', async () => {
    const coded = await failed(make([Object.assign(new Error('x'), { code: 'ECONNRESET' })]).client.ask(noulRequest));
    assert.ok(coded.message.includes('ECONNRESET'));
    const odd = await failed(make([Object.assign(new Error('x'), { code: 'not a code ' + MARKERS.state })]).client.ask(noulRequest));
    assert.ok(!odd.message.includes(MARKERS.state));
  });

  it('is caught when the transport throws at once', async () => {
    const client = new JevClient({ apiKey: KEY, transport: () => { throw new Error('thrown at once'); } });
    const error = await failed(client.ask(noulRequest));
    assert.equal(error.code, 'connection_lost');
  });

  it('is caught when the transport never answers within the limit', { timeout: 20_000 }, async () => {
    let calls = 0;
    const client = new JevClient({ apiKey: KEY, timeoutMs: 25, transport: () => { calls += 1; return new Promise(() => {}); } });
    const error = await failed(client.ask(noulRequest));
    assert.equal(error.code, 'timeout');
    assert.equal(error.retryable, false);
    assert.equal(calls, 1);
  });

  it('after a retry counts two requests and is still not sent a third time', async () => {
    const { client, calls } = make([text(429), new JevTransportError('timeout'), okStep]);
    const error = await failed(client.ask(noulRequest));
    assert.equal(error.code, 'timeout');
    assert.equal(error.attempts, 2);
    assert.equal(calls.length, 2);
  });

  it('turns an answer that is too large or not UTF-8 into an invalid answer, not into a retry', async () => {
    for (const reason of ['response_too_large', 'response_encoding'] as const) {
      const { client, calls } = make([new JevTransportError(reason), okStep]);
      const error = await failed(client.ask(noulRequest));
      assert.equal(error.code, 'invalid_response');
      assert.equal(calls.length, 1);
    }
  });
});

describe('the audit file', () => {
  it('gets one line per request sent, with sizes, digests, status, model, usage and duration, and no content', async () => {
    const dir = await scratch();
    const auditPath = join(dir, 'nested', 'audit.jsonl');
    const { client, calls } = make([okStep], { auditPath, now: clock() });
    await client.ask(mixedRequest);
    const lines = await readLines(auditPath);
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0], {
      ts: '2026-11-23T00:00:00.000Z',
      endpoint_host: 'api.typesafe.ai',
      questions: 3,
      question_types: ['noul', 'choice', 'score'],
      body_bytes: Buffer.byteLength(calls[0]!.body, 'utf8'),
      body_sha256: sha256(calls[0]!.body),
      attempt: 1,
      http_status: 200,
      model: 'jev-1.14.0',
      usage: { input_tokens: 120, output_tokens: 30 },
      duration_ms: 250,
      error_code: null,
    });
    assert.deepEqual(Object.keys(lines[0]!), ['ts', 'endpoint_host', 'questions', 'question_types', 'body_bytes', 'body_sha256', 'attempt', 'http_status', 'model', 'usage', 'duration_ms', 'error_code']);
    assert.equal((await stat(auditPath)).mode & 0o777, 0o600);
  });

  it('gets a line for each attempt of a retry and for each kind of failure', async () => {
    const dir = await scratch();
    const auditPath = join(dir, 'audit.jsonl');
    const run = async (steps: readonly Step[]): Promise<Array<Record<string, unknown>>> => {
      await rm(auditPath, { force: true });
      const { client } = make(steps, { auditPath, now: clock() });
      await client.ask(noulRequest).catch(() => undefined);
      return await readLines(auditPath);
    };
    const retried = await run([text(429), okStep]);
    assert.deepEqual(retried.map((line) => [line.attempt, line.http_status, line.error_code, line.model]), [[1, 429, 'rate_limited', null], [2, 200, null, 'jev-1.14.0']]);
    const timedOut = await run([new JevTransportError('timeout')]);
    assert.deepEqual(timedOut.map((line) => [line.attempt, line.http_status, line.error_code, line.model, line.usage]), [[1, null, 'timeout', null, null]]);
    const refused = await run([text(401, 'no')]);
    assert.deepEqual(refused.map((line) => [line.http_status, line.error_code]), [[401, 'unauthorized']]);
    const invalid = await run([text(200, 'nope')]);
    assert.deepEqual(invalid.map((line) => [line.http_status, line.error_code, line.model, line.usage]), [[200, 'invalid_response', null, null]]);
    const twice = await run([text(529), text(529)]);
    assert.deepEqual(twice.map((line) => [line.attempt, line.error_code]), [[1, 'overloaded'], [2, 'overloaded']]);
  });

  it('adds to what is there, also from calls that run at the same time', async () => {
    const dir = await scratch();
    const auditPath = join(dir, 'audit.jsonl');
    const { client } = make([okStep], { auditPath });
    await Promise.all([client.ask(noulRequest), client.ask(choiceRequest), client.ask(scoreRequest), client.ask(mixedRequest)]);
    await make([okStep], { auditPath }).client.ask(noulRequest);
    const lines = await readLines(auditPath);
    assert.equal(lines.length, 5);
    assert.deepEqual(lines.map((line) => line.questions).sort(), [1, 1, 1, 1, 3]);
  });

  it('holds no state, instruction, option, description, level or key, and neither does any error', async () => {
    const scenarios: ReadonlyArray<[string, Step | readonly Step[]]> = [
      ['an answer', okStep],
      ['an answer that echoes the request', (request) => json(200, { ...answerBody(request), echo: request.body })],
      ['a refusal that echoes the request', (request) => text(422, request.body)],
      ['a refusal that echoes the key', text(401, `denied ${KEY}`)],
      ['a server error', text(500, `boom ${MARKERS.state} ${KEY}`)],
      ['rate limits', [text(429, MARKERS.state), text(429, MARKERS.state)]],
      ['a timeout whose message holds the markers', new JevTransportError('timeout', Object.values(MARKERS).join(''))],
      ['a connection error whose message holds the markers', new Error(Object.values(MARKERS).join(' '))],
      ['a connection error whose code holds the key', Object.assign(new Error('x'), { code: KEY.toUpperCase().replaceAll(/[^A-Z0-9_]/g, '_') })],
      ['a bad answer', text(200, `{"model":"${MARKERS.state}","answers":${MARKERS.state}}`)],
    ];
    for (const [name, step] of scenarios) {
      const dir = await scratch();
      const auditPath = join(dir, 'audit.jsonl');
      const steps = Array.isArray(step) ? (step as readonly Step[]) : [step as Step];
      const { client } = make(steps, { auditPath });
      let shown = '';
      try {
        const response = await client.ask(markerRequest());
        shown = JSON.stringify(response);
        assert.ok(!shown.includes(KEY), name);
      } catch (error) {
        assert.ok(error instanceof JevCallError, name);
        assertClean(error);
      }
      const audit = await readFile(auditPath, 'utf8');
      assert.ok(audit.length > 0, name);
      for (const marker of Object.values(MARKERS)) assert.ok(!audit.includes(marker), `${name}: ${marker} in the audit file`);
      assert.ok(!/authorization|bearer/i.test(audit), name);
    }
  });

  it('is checked before anything is sent: a directory, a link or a file in a place that cannot be made is refused', async () => {
    const dir = await scratch();
    await mkdir(join(dir, 'a-directory'));
    await writeFile(join(dir, 'real'), '');
    await symlink(join(dir, 'real'), join(dir, 'a-link'));
    await writeFile(join(dir, 'a-file'), '');
    for (const auditPath of [join(dir, 'a-directory'), join(dir, 'a-link'), join(dir, 'a-file', 'inside.jsonl')]) {
      const { client, calls } = make([okStep], { auditPath });
      const error = await failed(client.ask(noulRequest));
      assert.equal(error.category, '参数无效');
      assert.equal(error.code, 'audit_failed');
      assert.ok(error.message.includes('没有发出任何请求'), error.message);
      assert.equal(calls.length, 0);
    }
  });

  it('that cannot be written after the answer came withholds the answer and says the service may have billed', async () => {
    const dir = await scratch();
    const auditPath = join(dir, 'audit.jsonl');
    const { client, calls } = make([
      async (request) => {
        await rm(auditPath, { force: true });
        await mkdir(auditPath);
        return json(200, answerBody(request));
      },
    ], { auditPath });
    const error = await failed(client.ask(noulRequest));
    assert.equal(error.category, '暂时不可用');
    assert.equal(error.code, 'audit_failed');
    assert.equal(error.status, 200);
    assert.ok(error.message.includes('可能已经计费'), error.message);
    assert.equal(calls.length, 1);
  });
});

describe('the key', () => {
  it('is refused when it is empty, has a character outside the key alphabet or is too long, and the message says nothing was sent', async () => {
    const secret = 'a key with spaces ' + MARKERS.state;
    const placeholders = ['%JEV_API_KEY%', '%PLUMB_API_KEY%', '%HUB_TOKEN%', '%X%', '%', '%%', '100%', 'abc%DEF%ghi', 'prefix%JEV_API_KEY%', '%JEV_API_KEY%suffix', '%JEV_API_KEY%\n', ' %JEV_API_KEY%'];
    for (const apiKey of ['', ' ', 'a b', 'a\nb', 'a\r\nHost: x', 'ключ', 'a'.repeat(4097), 'abc:def', 'a;b', secret, 5, null, undefined, {}, ...placeholders]) {
      const { transport, calls } = scripted([okStep]);
      assert.throws(() => new JevClient({ apiKey, transport } as unknown as JevClientConfig), (error: unknown) => {
        assert.ok(error instanceof JevCallError);
        assert.equal(error.category, '无权限');
        assert.equal(error.code, 'invalid_key');
        assert.equal(error.status, 0);
        assert.equal(error.attempts, 0);
        assert.equal(error.retryable, false);
        assert.match(error.message, FORM);
        assert.ok(error.message.includes('没有通过本地检查') && error.message.includes('没有发出任何请求') && error.message.includes('不是服务拒绝'), error.message);
        assert.ok(!error.message.includes(MARKERS.state));
        return true;
      }, String(apiKey).slice(0, 20));
      assert.equal(calls.length, 0);
    }
    for (const apiKey of ['k', 'abcdefgh', 'a.b_c-d~e+f/g', 'abc==', KEY, 'a'.repeat(4096)]) assert.doesNotThrow(() => new JevClient({ apiKey }));
  });

  it('is never let through by a character that a placeholder is made of: a percent sign is not in the alphabet', async () => {
    for (const apiKey of ['%', 'a%', '%a', 'a%b', '%25', 'abc%20def']) {
      assert.throws(() => new JevClient({ apiKey }), (error: unknown) => error instanceof JevCallError && error.code === 'invalid_key', apiKey);
    }
  });

  it('is not shown by the client, however it is printed', async () => {
    const { client } = make([okStep]);
    assert.equal(JSON.stringify(client), '{}');
    assert.ok(!inspect(client, { depth: 6, showHidden: true }).includes(KEY));
    assert.deepEqual(Object.getOwnPropertyNames(client), []);
    const response = await client.ask(noulRequest);
    assert.ok(!JSON.stringify(response).includes(KEY));
  });

  it('is the one thing in the Authorization header and in no other part of what the transport gets', async () => {
    const { client, calls } = make([okStep]);
    await client.ask(markerRequest());
    const sent = calls[0]!;
    assert.ok(!sent.body.includes(KEY));
    assert.ok(!sent.url.includes(KEY));
    assert.deepEqual(Object.entries(sent.headers).filter(([, value]) => value.includes(KEY)).map(([name]) => name), ['Authorization']);
  });

  it('is never in what the service sent back: an answer that echoes it is thrown away whole', async () => {
    const run = async (step: Step): Promise<JevCallError> => {
      const { client, calls } = make([step, okStep]);
      const error = await failed(client.ask(noulRequest));
      assert.equal(error.category, '暂时不可用');
      assert.equal(error.code, 'invalid_response');
      assert.equal(calls.length, 1);
      assertClean(error, [KEY]);
      return error;
    };
    await run((request) => json(200, { ...answerBody(request), model: KEY }));
    await run((request) => json(200, { ...answerBody(request), debug: KEY }));
    await run((request) => json(200, { ...answerBody(request), debug: KEY.slice(5, 20) }));
    await run((request) => json(200, answerBody(request), { 'x-debug': KEY }));
    await run((request) => json(200, answerBody(request), { 'x-debug': `prefix ${KEY.slice(3, 18)} suffix` }));
    await run(text(401, `unauthorized ${KEY}`));
    await run(text(429, KEY, { 'retry-after': '1' }));
    const scale = make([(request) => json(200, { ...answerBody(request), answers: { quality: { ...answerBody(request).answers.quality, legend: { '0': KEY, '1': 'b', '2': 'c' } } } })]);
    assert.equal((await failed(scale.client.ask(scoreRequest))).code, 'invalid_response');
  });

  it('is thrown away with the answer that holds it, also when the answer writes it with escapes the raw text does not show', async () => {
    const shortKey = 'abc/defghij';
    const escapes: ReadonlyArray<[string, (text: string) => string]> = [
      ['an escaped slash', (body) => body.replaceAll('/', '\\/')],
      ['unicode escapes', (body) => body.replaceAll('abc', '\\u0061\\u0062\\u0063')],
    ];
    for (const [name, escape] of escapes) {
      let raw = '';
      const { transport, calls } = scripted([
        (request) => {
          const body = answerBody(request) as unknown as { answers: { quality: { legend: Record<string, string> } } };
          body.answers.quality.legend['0'] = shortKey;
          raw = escape(JSON.stringify(body));
          return text(200, raw);
        },
        okStep,
      ]);
      const client = new JevClient({ apiKey: shortKey, transport });
      const error = await failed(client.ask(scoreRequest));
      assert.ok(raw !== '' && !raw.includes(shortKey), `the raw text does not show the key (${name})`);
      assert.equal(error.code, 'invalid_response', name);
      assert.equal(calls.length, 1, name);
      assertClean(error, [shortKey]);
    }
  });

  it('cannot be smuggled into an error through the tag of a transport error', async () => {
    for (const tag of [MARKERS.state, MARKERS.instructions, 'FREE TEXT OF THE CALLER', KEY]) {
      const { client } = make([new JevTransportError('connection', tag)]);
      const error = await failed(client.ask(markerRequest()));
      assert.equal(error.code, 'connection_lost');
      assertClean(error);
      assert.ok(!error.message.includes(tag), error.message);
    }
  });

  it('is not in the error of a transport that throws it', async () => {
    for (const cause of [new Error(KEY), new JevTransportError('connection', KEY), Object.assign(new Error('x'), { code: KEY })]) {
      const { client } = make([cause]);
      const error = await failed(client.ask(noulRequest));
      assertClean(error, [KEY]);
    }
  });

  it('takes a header value that is a piece of the key for an echo only from 8 characters, and a run of key characters only from 12', async () => {
    type Reply = (request: JevTransportRequest) => ReturnType<typeof json>;
    const outcome = async (reply: Reply, apiKey = KEY): Promise<string> => {
      const client = new JevClient({ apiKey, transport: scripted([reply]).transport });
      try {
        await client.ask(noulRequest);
        return 'answer';
      } catch (error) {
        assert.ok(error instanceof JevCallError, String(error));
        return error.code;
      }
    };
    const withHeader = (value: string): Reply => (request) => json(200, answerBody(request), { 'x-note': value });
    const withModel = (model: string): Reply => (request) => json(200, answerBody(request, model));
    assert.equal(await outcome(withHeader('jevkey_')), 'answer', 'seven characters of the key are ordinary text');
    assert.equal(await outcome(withHeader('jevkey_S')), 'invalid_response');
    assert.equal(await outcome(withModel('x-SYNTHETIC-0-x')), 'answer', 'a run of eleven key characters is ordinary text');
    assert.equal(await outcome(withModel('x-SYNTHETIC-0a-x')), 'invalid_response');
    assert.equal(await outcome(withModel('abcdefg'), 'abcdefg'), 'answer', 'a key shorter than 8 characters is not looked for');
  });
});

describe('the configuration', () => {
  it('refuses what it cannot use', () => {
    const bad: Array<Partial<JevClientConfig> | unknown> = [
      null, 'key', [], { apiKey: KEY, timeoutMs: 0 }, { apiKey: KEY, timeoutMs: 600_001 }, { apiKey: KEY, timeoutMs: 1.5 }, { apiKey: KEY, timeoutMs: '30' },
      { apiKey: KEY, model: '' }, { apiKey: KEY, model: 'a b' }, { apiKey: KEY, model: 5 }, { apiKey: KEY, auditPath: '' }, { apiKey: KEY, auditPath: 5 },
      { apiKey: KEY, transport: 'x' }, { apiKey: KEY, now: 5 }, { apiKey: KEY, sleep: {} },
    ];
    for (const config of bad) {
      assert.throws(() => new JevClient(config as JevClientConfig), (error: unknown) => {
        assert.ok(error instanceof JevCallError);
        assert.match(error.message, FORM);
        assert.ok(['参数无效', '无权限'].includes(error.category));
        return true;
      }, JSON.stringify(config)?.slice(0, 60));
    }
  });

  it('takes the limits at their edges and a client with nothing but a key', () => {
    for (const timeoutMs of [1, 30_000, 600_000]) assert.doesNotThrow(() => new JevClient({ apiKey: KEY, timeoutMs }));
    assert.doesNotThrow(() => new JevClient({ apiKey: KEY }));
  });
});
