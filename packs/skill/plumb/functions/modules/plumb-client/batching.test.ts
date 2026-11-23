import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import { PlumbClient, PlumbHttpError, type PlumbBatchQuestion } from './index.ts';

const GATEWAY_MAX_QUESTIONS = 32;
const GATEWAY_MAX_PAIRS = 256;
const NONE_NAMES = ['都不是', 'none'];

interface Seen {
  questions: number;
  pairs: number;
}

function pairsOf(question: { task?: string; candidates?: Array<{ name: string } | string>; criteria?: unknown }): number {
  if (question.task === 'single_cmd_judge' || question.task === 'steplist_judge' || question.task === 'match') return 1;
  const listed = question.candidates ?? (Array.isArray(question.criteria) ? question.criteria : []);
  const names = listed.map((c) => (typeof c === 'string' ? c : c.name));
  if (question.task === 'sequence' && names.length === 0) return 3;
  const none = names.filter((n) => NONE_NAMES.includes(n)).length;
  return names.length >= 2 && none === 1 ? names.length - 1 : names.length;
}

type Mode = 'gateway' | 'too_large' | 'backend_down';
let mode: Mode = 'gateway';
const seen: Seen[] = [];

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const fail = (status: number, type: string, message: string): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type, message, retryable: false } }));
    };
    if (req.method !== 'POST' || req.url !== '/v1/judge') return fail(404, 'not_found', 'no such route');
    if (mode === 'backend_down') return fail(503, 'backend_down', 'backend sleeping');
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      task?: string;
      questions?: Record<string, { task?: string; candidates?: Array<{ name: string }>; criteria?: unknown }>;
    };
    const entries = Object.entries(body.questions ?? { single: { task: body.task } });
    seen.push({ questions: entries.length, pairs: entries.reduce((n, [, q]) => n + pairsOf(q), 0) });
    if (mode === 'too_large') return fail(413, 'request_too_large', 'Compiled judge pairs (24) exceed limit (16)');
    if (entries.length > GATEWAY_MAX_QUESTIONS) return fail(400, 'invalid_request', `At most ${GATEWAY_MAX_QUESTIONS} questions per batch`);
    let remaining = GATEWAY_MAX_PAIRS;
    const answers: Record<string, unknown> = {};
    for (const [qid, q] of entries) {
      const cost = pairsOf(q);
      if (cost > remaining) return fail(413, 'request_too_large', `Compiled judge pairs (${cost}) exceed limit (${remaining})`);
      remaining -= cost;
      const names = (q.candidates ?? []).map((c) => c.name);
      const picked = names[0] ?? 'yes';
      answers[qid] = q.task === 'choice'
        ? { type: 'choice', choice: picked, confidence: 0.9, probabilities: { [picked]: 0.9, 都不是: 0.1 }, gate: { action: 'pass', calibrated: true } }
        : { type: 'noul', match: 0.9, probabilities: { yes: 0.9, no: 0.1 }, gate: { action: 'pass', calibrated: true } };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: '未确认',
      decided_by: '模型',
      model_version: 'plumb-27b-0.5.0',
      request_id: `req-${seen.length}`,
      answers,
    }));
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address() as AddressInfo;
const client = (): PlumbClient => new PlumbClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'plumb_sk_synthetic_batching', model: 'plumb-27b-0.5.0', noCache: true });
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function choiceQuestion(candidateCount: number): PlumbBatchQuestion {
  return {
    task: 'choice',
    node: { line: 'synthetic', title: 'configure the synthetic object' },
    candidates: [
      ...Array.from({ length: candidateCount }, (_, i) => ({ name: `synthetic command ${i}`, text: `syntax ${i}` })),
      { name: '都不是', text: '以上候选均不符合' },
    ],
  };
}

describe('judgeBatched against the gateway pair budget', () => {
  it('splits seven recalls of 24 and 16 candidates into requests that stay inside the budget of 256 pairs', async () => {
    mode = 'gateway';
    seen.length = 0;
    const questions: Record<string, PlumbBatchQuestion> = {};
    for (let step = 1; step <= 7; step += 1) {
      questions[`0:${step}:c0`] = choiceQuestion(24);
      questions[`0:${step}:c1`] = choiceQuestion(16);
    }
    assert.equal(Object.keys(questions).length, 14);
    assert.equal(Object.values(questions).reduce((n, q) => n + pairsOf(q), 0), 280, 'the whole batch is 280 pairs, which no single request may carry');

    const res = await client().judgeBatched({ task: 'choice', questions });

    assert.equal(Object.keys(res.answers).length, 14);
    assert.ok(seen.length >= 2, 'a batch of 280 pairs needs more than one request');
    for (const request of seen) {
      assert.ok(request.pairs <= GATEWAY_MAX_PAIRS, `a request carried ${request.pairs} pairs`);
      assert.ok(request.questions <= GATEWAY_MAX_QUESTIONS);
    }
    assert.equal(seen.reduce((n, r) => n + r.questions, 0), 14);
  });

  it('still sends a batch that fits the limits as one request', async () => {
    mode = 'gateway';
    seen.length = 0;
    const questions: Record<string, PlumbBatchQuestion> = {};
    for (let i = 0; i < 32; i += 1) questions[`q${i}`] = { task: 'single_cmd_judge', command: `synthetic ${i}`, state: 'ctx' };
    const res = await client().judgeBatched({ task: 'single_cmd_judge', questions });
    assert.equal(Object.keys(res.answers).length, 32);
    assert.deepEqual(seen, [{ questions: 32, pairs: 32 }]);
  });

  it('says which requests have to be split before anything is sent', () => {
    const fits: Record<string, PlumbBatchQuestion> = { a: choiceQuestion(24), b: choiceQuestion(16) };
    const tooManyPairs: Record<string, PlumbBatchQuestion> = {};
    for (let i = 0; i < 14; i += 1) tooManyPairs[`q${i}`] = choiceQuestion(i % 2 === 0 ? 24 : 16);
    const tooManyQuestions: Record<string, PlumbBatchQuestion> = {};
    for (let i = 0; i < 33; i += 1) tooManyQuestions[`m${i}`] = { task: 'single_cmd_judge', command: `synthetic ${i}` };
    const c = client();
    assert.equal(c.exceedsRequestLimits({ task: 'choice', questions: fits }), false);
    assert.equal(c.exceedsRequestLimits({ task: 'choice', questions: tooManyPairs }), true);
    assert.equal(c.exceedsRequestLimits({ task: 'single_cmd_judge', questions: tooManyQuestions }), true);
    assert.equal(c.exceedsRequestLimits({ task: 'single_cmd_judge', state: 'one question' }), false);
  });

  it('refuses a direct judge call that the gateway would refuse, before any request is sent', async () => {
    mode = 'gateway';
    seen.length = 0;
    const questions: Record<string, PlumbBatchQuestion> = {};
    for (let i = 0; i < 14; i += 1) questions[`q${i}`] = choiceQuestion(i % 2 === 0 ? 24 : 16);
    await assert.rejects(
      () => client().judge({ task: 'choice', questions }),
      (error: Error) => /^参数无效：/.test(error.message) && /256/.test(error.message) && /judgeBatched/.test(error.message),
    );
    assert.equal(seen.length, 0, 'nothing may reach the gateway');
  });
});

describe('refusals carry the gateway error type and name every limit', () => {
  it('reads error.type when the gateway sends no error.code, and states all three request limits on a 413', async () => {
    mode = 'too_large';
    seen.length = 0;
    await assert.rejects(
      () => client().judge({ task: 'single_cmd_judge', state: 'ctx', command: 'synthetic' }),
      (error: unknown) => {
        assert.ok(error instanceof PlumbHttpError);
        assert.equal(error.status, 413);
        assert.equal(error.code, 'request_too_large');
        assert.match(error.message, /Compiled judge pairs \(24\) exceed limit \(16\)/);
        assert.match(error.message, /32 题/);
        assert.match(error.message, /256 个打分对/);
        assert.match(error.message, /1 MiB/);
        return true;
      },
    );
  });

  it('points to the wake command when the backend sleeps, which the gateway reports as error.type', async () => {
    mode = 'backend_down';
    await assert.rejects(
      () => client().judge({ task: 'single_cmd_judge', state: 'ctx', command: 'synthetic' }),
      (error: unknown) => {
        assert.ok(error instanceof PlumbHttpError);
        assert.equal(error.code, 'backend_down');
        assert.match(error.message, /plumb wake/);
        return true;
      },
    );
  });
});
