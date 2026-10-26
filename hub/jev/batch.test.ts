import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  JevError,
  SCRIPTED_MODEL,
  ScriptedJev,
  askAll,
  batchRequest,
  estimateJsonTokens,
  estimateTokens,
  planBatches,
} from './api.ts';
import type { JevAskAllResult, JevBatchItem, JevClient, JevErrorCode, JevPlan, JevQuestion, JevRequest, JevResponse, ScriptedSpec } from './api.ts';

// Invented text only: a small pool of common characters cycled into passages of any length.
const POOL = '示例手册段落配置说明接口地址设置命令参数范围默认取值显示状态查询删除添加修改保存重启服务进程网络系统认证日志';

function passage(index: number, length: number): string {
  let text = '';
  for (let at = 0; text.length < length; at++) text += POOL[(index * 7 + at) % POOL.length];
  return text;
}

function chapterQuestion(id: string, options: number, descriptionLength = 12): JevQuestion {
  const criteria: Record<string, string | null> = {};
  for (let index = 1; index < options; index++) criteria[`第${String(index).padStart(2, '0')}章`] = passage(index, descriptionLength);
  criteria.none = '没有合适的章节';
  return { type: 'choice', instructions: `Which chapter of the manual holds \`${id}\`?`, criteria };
}

function items(count: number, length: number, options = 28, descriptionLength = 12): JevBatchItem[] {
  return Array.from({ length: count }, (_, index) => {
    const id = `p${index}`;
    return { id, piece: passage(index, length), question: chapterQuestion(id, options, descriptionLength) };
  });
}

function ids(plan: JevPlan): string[][] {
  return plan.batches.map((batch) => batch.items.map((item) => item.id));
}

/** Every batch respects both limits, also when re-estimated from the whole request text. */
function assertWithinLimits(plan: JevPlan): void {
  for (const batch of plan.batches) {
    assert.ok(batch.items.length <= plan.limits.maxQuestionsPerRequest);
    assert.ok(batch.estimatedTokens <= plan.limits.maxEstimatedTokens);
    assert.ok(batch.estimatedQuestionTokens <= plan.limits.maxQuestionTokens);
    const request = batchRequest(SCRIPTED_MODEL, plan, batch.items);
    assert.ok(estimateJsonTokens(request) <= batch.estimatedTokens, 'incremental estimate is below the whole-text estimate');
    for (const [id, question] of Object.entries(request.questions)) {
      const alone = estimateJsonTokens({ ...request, questions: { [id]: question } });
      assert.ok(alone <= batch.estimatedQuestionTokens, 'per-question estimate is below the whole-text estimate');
    }
  }
}

function flat(plan: JevPlan): string[] {
  return [...ids(plan).flat(), ...plan.oversized.map((entry) => entry.item.id)];
}

describe('estimateTokens', () => {
  it('counts one token per CJK character and per three ASCII letters, digits or spaces', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens('abc'), 1);
    assert.equal(estimateTokens('abcd'), 2);
    assert.equal(estimateTokens('a b c d e f'), 4);
    assert.equal(estimateTokens('示例'), 2);
    assert.equal(estimateTokens('示例 abc'), 4);
    assert.equal(estimateTokens('{"a":1}'), 5 + 1);
    assert.equal(estimateTokens('，。'), 2);
    assert.equal(estimateTokens('é'), 1);
    assert.equal(estimateTokens('😀'), 2);
    assert.equal(estimateTokens('𠀀x'), 3);
  });

  it('estimates mixed Chinese and English above a four-characters-per-token reading', () => {
    const english = 'Set the address of the demo interface with the demo command. '.repeat(20);
    assert.ok(estimateTokens(english) >= english.length / 4);
    const chinese = passage(1, 1000);
    assert.equal(estimateTokens(chinese), 1000);
    assert.equal(estimateJsonTokens(chinese), 1002);
  });
});

describe('planBatches', () => {
  it('puts 90 Chinese passages with a 28-option question into 9 requests of 10, in order', () => {
    const plan = planBatches(items(90, 800));
    assert.equal(plan.batches.length, 9);
    assert.ok(plan.batches.every((batch) => batch.items.length === 10));
    assert.deepEqual(flat(plan), items(90, 800).map((item) => item.id));
    assert.deepEqual(plan.oversized, []);
    assertWithinLimits(plan);
    assert.equal(Object.keys((plan.batches[0]!.items[0]!.question as { criteria: object }).criteria).length, 28);
  });

  it('lets the per-question limit bind for long passages (the state is part of every question)', () => {
    const plan = planBatches(items(10, 5000));
    assert.deepEqual(ids(plan).map((batch) => batch.length), [4, 4, 2]);
    assertWithinLimits(plan);
    assert.ok(plan.batches[0]!.estimatedQuestionTokens > 20_000);
    assert.ok(plan.batches[0]!.estimatedTokens < plan.limits.maxEstimatedTokens);
  });

  it('lets the per-request limit bind for large questions on small passages', () => {
    const plan = planBatches(items(7, 50, 255, 40));
    assert.deepEqual(ids(plan).map((batch) => batch.length), [3, 3, 1]);
    assertWithinLimits(plan);
    const first = plan.batches[0]!;
    // A fourth question of the same size would break the per-request limit; the per-question limit is not binding.
    assert.ok((first.estimatedTokens / 3) * 4 > plan.limits.maxEstimatedTokens);
    assert.ok(first.estimatedQuestionTokens < plan.limits.maxQuestionTokens);
  });

  it('honours tighter limits given by the caller', () => {
    const plan = planBatches(items(12, 800), { maxQuestionsPerRequest: 5, maxEstimatedTokens: 6000, maxQuestionTokens: 3000 });
    assertWithinLimits(plan);
    assert.ok(plan.batches.length > 3);
    assert.deepEqual(flat(plan), items(12, 800).map((item) => item.id));
  });

  it('reports an item that does not fit even alone and never batches it', () => {
    const list = items(3, 800);
    list.splice(1, 0, { id: 'huge', piece: passage(9, 30_000), question: chapterQuestion('huge', 28) });
    const plan = planBatches(list);
    assert.deepEqual(ids(plan), [['p0', 'p1', 'p2']]);
    assert.equal(plan.oversized.length, 1);
    assert.equal(plan.oversized[0]!.item.id, 'huge');
    assert.ok(plan.oversized[0]!.estimatedTokens > 30_000);
  });

  it('puts the shared context and every piece under its id into the request state', () => {
    const plan = planBatches(items(2, 20), { shared: { product: '示例产品', version: '1.0' } });
    const request = batchRequest(SCRIPTED_MODEL, plan, plan.batches[0]!.items);
    assert.deepEqual(Object.keys(request.state as object), ['product', 'version', 'p0', 'p1']);
    assert.deepEqual(Object.keys(request.questions), ['p0', 'p1']);
    assert.equal((request.state as Record<string, string>).p1, passage(1, 20));
  });

  it('refuses limits beyond the service limits and bad options', () => {
    assert.throws(() => planBatches([], { maxEstimatedTokens: 64_001 }), RangeError);
    assert.throws(() => planBatches([], { maxQuestionTokens: 32_001 }), RangeError);
    assert.throws(() => planBatches([], { maxQuestionsPerRequest: 0 }), RangeError);
    assert.throws(() => planBatches([], { maxQuestionsPerRequest: 1.5 }), RangeError);
    assert.deepEqual(planBatches([]).batches, []);
  });

  it('refuses duplicate or malformed ids, ids that collide with shared keys, bad questions and bad pieces', () => {
    const [a, b] = items(2, 10) as [JevBatchItem, JevBatchItem];
    assert.throws(() => planBatches([a, { ...b, id: a.id }]), TypeError);
    assert.throws(() => planBatches([{ ...a, id: 'has space' }]), TypeError);
    assert.throws(() => planBatches([{ ...a, id: 'a.b' }]), TypeError);
    assert.throws(() => planBatches([{ ...a, id: '__proto__' }]), TypeError);
    assert.throws(() => planBatches([a], { shared: { p0: 'context' } }), TypeError);
    assert.throws(
      () => planBatches([{ ...a, question: { type: 'choice', instructions: 'x', criteria: {} } }]),
      (error: unknown) => error instanceof JevError && error.code === 'JEV_BAD_REQUEST',
    );
    assert.throws(
      () => planBatches([{ ...a, piece: { value: Number.NaN } }]),
      (error: unknown) => error instanceof JevError && error.code === 'JEV_BAD_REQUEST',
    );
  });
});

/** Wraps a client and records how many requests were in flight at once. */
class Tracking implements JevClient {
  readonly pinnedModel: string;
  inFlight = 0;
  most = 0;
  #inner: JevClient;
  constructor(inner: JevClient) {
    this.#inner = inner;
    this.pinnedModel = inner.pinnedModel;
  }
  async ask(request: JevRequest): Promise<JevResponse> {
    this.inFlight++;
    this.most = Math.max(this.most, this.inFlight);
    try {
      return await this.#inner.ask(request);
    } finally {
      this.inFlight--;
    }
  }
}

const firstChapter = (question: JevQuestion): ScriptedSpec => ({ choice: Object.keys((question as { criteria: object }).criteria)[0]!, p: 0.9 });

describe('askAll', () => {
  it('answers every question and collects the answers by id in plan order', async () => {
    const plan = planBatches(items(25, 100));
    const client = new ScriptedJev(firstChapter);
    const result = await askAll(client, plan);
    assert.equal(result.requestsSent, 3);
    assert.equal(result.failed.size, 0);
    assert.deepEqual([...result.answered.keys()], items(25, 100).map((item) => item.id));
    const entry = result.answered.get('p13')!;
    assert.equal(entry.answer.type, 'choice');
    assert.ok(Object.hasOwn(entry.request.questions, 'p13'));
    assert.equal(entry.response.answers.p13, entry.answer);
    assert.equal(client.requests.length, 3);
  });

  for (const concurrency of [1, 2, 4]) {
    it(`keeps at most ${concurrency} request(s) in flight`, async () => {
      const plan = planBatches(items(12, 50), { maxQuestionsPerRequest: 2 });
      const tracking = new Tracking(new ScriptedJev((question) => ({ ...firstChapter(question), delayMs: 15 })));
      const result = await askAll(tracking, plan, { concurrency });
      assert.equal(result.answered.size, 12);
      assert.equal(tracking.most, concurrency);
    });
  }

  it('retries a batch that is too large once, split in half', async () => {
    const client = new ScriptedJev((question, state) => (Object.keys(state as object).length > 2 ? { fail: 'JEV_TOO_LARGE' } : firstChapter(question)));
    const result = await askAll(client, planBatches(items(4, 50), { maxQuestionsPerRequest: 4 }));
    assert.equal(result.requestsSent, 3);
    assert.equal(result.answered.size, 4);
    assert.equal(result.failed.size, 0);
    assert.deepEqual(
      client.requests.map((request) => Object.keys(request.questions)),
      [
        ['p0', 'p1', 'p2', 'p3'],
        ['p0', 'p1'],
        ['p2', 'p3'],
      ],
    );
  });

  it('splits only once: halves that fail again stay failed', async () => {
    const client = new ScriptedJev((question, state) => (Object.keys(state as object).length > 2 ? { fail: 'JEV_TOO_LARGE' } : firstChapter(question)));
    const result = await askAll(client, planBatches(items(6, 50), { maxQuestionsPerRequest: 6 }));
    assert.equal(result.requestsSent, 3);
    assert.equal(result.answered.size, 0);
    assert.deepEqual([...result.failed.keys()], ['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
    assert.ok([...result.failed.values()].every((error) => error.code === 'JEV_TOO_LARGE'));
  });

  it('isolates a malformed answer to the half that holds it', async () => {
    const client = new ScriptedJev((question, _state, id) => (id === 'p3' ? { raw: { type: 'choice', choice: 'nowhere' } } : firstChapter(question)));
    const result = await askAll(client, planBatches(items(4, 50), { maxQuestionsPerRequest: 4 }));
    assert.deepEqual([...result.answered.keys()], ['p0', 'p1']);
    assert.deepEqual([...result.failed.keys()], ['p2', 'p3']);
    assert.equal(result.failed.get('p3')!.code, 'JEV_BAD_RESPONSE');
  });

  it('stops at an authorization failure without retrying or starting further batches', async () => {
    const client = new ScriptedJev(() => ({ fail: 'JEV_UNAUTHORIZED' }));
    const result = await askAll(client, planBatches(items(6, 50), { maxQuestionsPerRequest: 2 }), { concurrency: 1 });
    assert.equal(result.requestsSent, 1);
    assert.equal(result.failed.size, 6);
    assert.ok([...result.failed.values()].every((error) => error.code === 'JEV_UNAUTHORIZED'));
    // The items of batches never sent say so: no attempt, no status, no request id of another request.
    assert.deepEqual(
      [...result.failed.values()].map((error) => error.attempts),
      [1, 1, 0, 0, 0, 0],
    );
    const unsent = result.failed.get('p5')!;
    assert.equal(unsent.requestId, null);
    assert.match(unsent.message, /没有发出/);
  });

  it('fails oversized items as JEV_TOO_LARGE without sending them', async () => {
    const list = [...items(2, 50), { id: 'huge', piece: passage(3, 30_000), question: chapterQuestion('huge', 28) }];
    const client = new ScriptedJev(firstChapter);
    const result = await askAll(client, planBatches(list));
    assert.equal(result.requestsSent, 1);
    assert.deepEqual([...result.answered.keys()], ['p0', 'p1']);
    assert.equal(result.failed.get('huge')!.code, 'JEV_TOO_LARGE');
    assert.equal(result.failed.get('huge')!.attempts, 0);
    assert.ok(client.requests.every((request) => !Object.hasOwn(request.questions, 'huge')));
  });

  it('propagates an error that is not a JevError', async () => {
    const client = new ScriptedJev(() => {
      throw new RangeError('script bug');
    });
    await assert.rejects(askAll(client, planBatches(items(4, 50), { maxQuestionsPerRequest: 2 })), RangeError);
  });

  it('refuses a bad concurrency', async () => {
    await assert.rejects(askAll(new ScriptedJev(firstChapter), planBatches([]), { concurrency: 0 }), RangeError);
  });
});

// A scripted judge failing whole requests (as the service failed whole requests), counting the requests it saw. With
// no HTTP client of its own left, askAll alone decides between splitting a batch and stopping the plan.
describe('askAll stop rules with a failing scripted judge', () => {
  // The pilot shape: 90 passages, 9 requests of 10.
  const pilot = (): JevPlan => planBatches(items(90, 50));

  function codes(result: JevAskAllResult): Set<JevErrorCode> {
    return new Set([...result.failed.values()].map((error) => error.code));
  }

  function unsent(result: JevAskAllResult): number {
    return [...result.failed.values()].filter((error) => error.attempts === 0).length;
  }

  it('answers the pilot shape with 9 requests', async () => {
    const client = new ScriptedJev(firstChapter);
    const result = await askAll(client, pilot());
    assert.equal(result.answered.size, 90);
    assert.equal(client.requests.length, 9);
  });

  it('stops the plan at a persistent rate limit: no split, no new batch', async () => {
    const client = new ScriptedJev(() => ({ fail: 'JEV_RATE_LIMITED' }));
    const result = await askAll(client, pilot());
    assert.equal(result.requestsSent, 2, 'one batch per worker');
    assert.equal(client.requests.length, 2, 'the scripted judge retries nothing');
    assert.equal(result.failed.size, 90);
    assert.deepEqual(codes(result), new Set(['JEV_RATE_LIMITED']));
    assert.equal(unsent(result), 70);
  });

  it('stops the plan when the judge answers with another model: one answer per worker, the rest unsent', async () => {
    const client = new ScriptedJev(firstChapter, { returnedModel: 'jev-scripted-1.14.0' });
    const result = await askAll(client, pilot());
    assert.equal(client.requests.length, 2);
    assert.equal(result.failed.size, 90);
    assert.deepEqual(codes(result), new Set(['JEV_BAD_RESPONSE']));
    assert.equal(unsent(result), 70);
  });

  it('splits a batch the judge refuses (JEV_BAD_REQUEST) once, so the other half is answered', async () => {
    const client = new ScriptedJev((question, state) => (Object.hasOwn(state as object, 'p3') ? { fail: 'JEV_BAD_REQUEST' } : firstChapter(question)));
    const result = await askAll(client, planBatches(items(10, 50)), { concurrency: 1 });
    assert.deepEqual([...result.failed.keys()], ['p0', 'p1', 'p2', 'p3', 'p4']);
    assert.equal(result.answered.size, 5);
    assert.equal(client.requests.length, 3);
  });

  it('splits an unavailable batch once and stops the plan when both halves fail too', async () => {
    const client = new ScriptedJev(() => ({ fail: 'JEV_UNAVAILABLE' }));
    const result = await askAll(client, pilot(), { concurrency: 1 });
    assert.equal(result.requestsSent, 3, 'the batch and its two halves');
    assert.equal(result.failed.size, 90);
    assert.deepEqual(codes(result), new Set(['JEV_UNAVAILABLE']));
    assert.equal(unsent(result), 80);
  });

  it('keeps an outage bounded with two workers', async () => {
    const client = new ScriptedJev(() => ({ fail: 'JEV_UNAVAILABLE' }));
    const result = await askAll(client, pilot());
    assert.ok(result.requestsSent <= 4, `requestsSent ${result.requestsSent}`);
    assert.equal(result.failed.size, 90);
  });

  it('stops after three unavailable requests in a row, also when every batch holds one question', async () => {
    const client = new ScriptedJev(() => ({ fail: 'JEV_UNAVAILABLE' }));
    const result = await askAll(client, planBatches(items(20, 50), { maxQuestionsPerRequest: 1 }), { concurrency: 1 });
    assert.equal(result.requestsSent, 3);
    assert.equal(result.failed.size, 20);
  });

  it('isolates a piece the judge cannot finish: the other half and the later batches are answered', async () => {
    const client = new ScriptedJev((question, state) => (Object.hasOwn(state as object, 'p3') ? { fail: 'JEV_UNAVAILABLE' } : firstChapter(question)));
    const result = await askAll(client, planBatches(items(20, 50)), { concurrency: 1 });
    assert.deepEqual([...result.failed.keys()], ['p0', 'p1', 'p2', 'p3', 'p4']);
    assert.equal(result.answered.size, 15);
    assert.equal(client.requests.length, 4, 'the batch, its two halves and the next batch');
  });
});
