import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { SCRIPTED_MODEL, ScriptedJev, askAll, batchRequest, candidatesOf, inputDigest, judgmentRecord, planBatches, reuseKey } from './api.ts';
import type { JevAnswer, JevBatchItem, JevChoiceQuestion, JevJudgmentRecord, JevPlanOptions, JevQuestion, JevRequest, JevResponse } from './api.ts';
import { canonicalize } from '../records/api.ts';

const AT = '2026-10-22T08:00:00.000Z';
const piece = { text: '示例片段：设置示例接口的地址' };
const state = { s1: piece };
// Golden values, cross-checked against the hand-written canonical text with shasum -a 256.
const PIECE_DIGEST = '06fba8ff6969e98deb19e9a0d67bc3cd663d1121f1181730b39afc0541a696be';
const STATE_DIGEST = 'f40f5719762a34bc97bd477551bfae837c774de3bc9336d86503e829271c58f4';
const REUSE_KEY = ["c37c88","44b60f","a2c03c","604e56","e1f38f","a150c3","ea8dde","d569f9","4abe8b","8f2a5a","8a8a"].join('');

function chapterQuestion(): JevChoiceQuestion {
  return {
    type: 'choice',
    instructions: 'Which chapter of the manual holds `s1`?',
    criteria: { 第01章: '网络配置', 第02章: '系统管理', none: '没有合适的章节' },
  };
}

function exchange(question: JevQuestion = chapterQuestion(), id = 's1', model = 'jev-1.13.0', returned = model): { request: JevRequest; response: JevResponse } {
  const request: JevRequest = { model, state, questions: { [id]: question } };
  const answer: JevAnswer =
    question.type === 'choice'
      ? { type: 'choice', choice: '第02章', confidence: 0.85, probabilities: { 第01章: 0.05, 第02章: 0.9, none: 0.05 } }
      : question.type === 'noul'
        ? { type: 'noul', noul: 0.75 }
        : { type: 'score', score: 1.6, confidence: 0.4, legend: { 0: 'vague', 1: 'somewhat', 2: 'exact' }, probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 } };
  const response: JevResponse = { model: returned, answers: { [id]: answer }, usage: { inputTokens: 120, outputTokens: 1 }, requestId: 'req_example_1' };
  return { request, response };
}

function record(question?: JevQuestion, id = 's1', model?: string, returned?: string): JevJudgmentRecord {
  const { request, response } = exchange(question, id, model, returned);
  return judgmentRecord({ request, response, questionId: id, input: piece, at: AT });
}

describe('inputDigest', () => {
  it('is the SHA-256 of the RFC 8785 canonical JSON, independent of key order', () => {
    assert.equal(inputDigest(piece), PIECE_DIGEST);
    assert.equal(inputDigest(state), STATE_DIGEST);
    assert.equal(inputDigest({ b: 2, a: '示例' }), createHash('sha256').update('{"a":"示例","b":2}').digest('hex'));
    assert.equal(inputDigest({ b: 2, a: '示例' }), inputDigest({ a: '示例', b: 2 }));
    assert.notEqual(inputDigest({ text: '示例片段' }), inputDigest({ text: '示例片段 ' }));
    assert.equal(inputDigest('plain text'), createHash('sha256').update('"plain text"').digest('hex'));
  });

  it('refuses input that has no canonical JSON', () => {
    assert.throws(() => inputDigest({ value: Number.NaN }), TypeError);
    assert.throws(() => inputDigest(undefined), TypeError);
    assert.throws(() => inputDigest({ when: new Date(0) }), TypeError);
  });
});

describe('judgmentRecord', () => {
  it('records model versions, request id, question, candidates, the piece, the whole state and probabilities', () => {
    assert.deepEqual(record(), {
      requested_model: 'jev-1.13.0',
      returned_model: 'jev-1.13.0',
      exact_model: 'jev-1.13.0',
      request_id: 'req_example_1',
      question_id: 's1',
      question_type: 'choice',
      instructions: 'Which chapter of the manual holds `s1`?',
      candidates: [
        { name: '第01章', description: '网络配置' },
        { name: '第02章', description: '系统管理' },
        { name: 'none', description: '没有合适的章节' },
      ],
      input_digest: PIECE_DIGEST,
      state_digest: STATE_DIGEST,
      probabilities: { 第01章: 0.05, 第02章: 0.9, none: 0.05 },
      answer: { type: 'choice', choice: '第02章', confidence: 0.85, probabilities: { 第01章: 0.05, 第02章: 0.9, none: 0.05 } },
      usage: { input_tokens: 120, output_tokens: 1 },
      judged_at: AT,
      reuse_key: REUSE_KEY,
    });
  });

  it('is deterministic plain JSON', () => {
    const first = record();
    const second = record();
    assert.deepEqual(first, second);
    assert.equal(canonicalize(first), canonicalize(second));
    assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  });

  it('does not share the answer object with the response', () => {
    const { request, response } = exchange();
    const result = judgmentRecord({ request, response, questionId: 's1', input: piece, at: AT });
    (response.answers.s1 as { confidence: number }).confidence = 0;
    assert.equal((result.answer as { confidence: number }).confidence, 0.85);
  });

  it('records yes/no as candidates true and false with false = 1 - noul', () => {
    const result = record({ type: 'noul', instructions: 'Does `s1` describe a command?', criteria: { true: 'It names a command' } });
    assert.deepEqual(result.candidates, [
      { name: 'true', description: 'It names a command' },
      { name: 'false', description: null },
    ]);
    assert.deepEqual(result.probabilities, { true: 0.75, false: 0.25 });
  });

  it('records score levels as candidates 0..n-1', () => {
    const result = record({ type: 'score', instructions: 'How specific is `s1`?', criteria: ['vague', 'somewhat', 'exact'] });
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.name),
      ['0', '1', '2'],
    );
    assert.deepEqual(result.probabilities, { 0: 0.1, 1: 0.2, 2: 0.7 });
  });

  it('marks the exact version unknown when an alias comes back, and never offers it for reuse', () => {
    const aliased = record(undefined, 's1', 'jev-latest', 'jev-latest');
    assert.equal(aliased.exact_model, null);
    assert.equal(aliased.reuse_key, null);
    const resolved = record(undefined, 's1', 'jev-latest', 'jev-1.13.0');
    assert.equal(resolved.exact_model, 'jev-1.13.0');
    assert.equal(resolved.reuse_key, null);
  });

  it('names the scripted judge in the model of every record it produced', async () => {
    const client = new ScriptedJev(() => ({ choice: '第02章', p: 0.9 }));
    const request: JevRequest = { model: client.pinnedModel, state, questions: { s1: chapterQuestion() } };
    const result = judgmentRecord({ request, response: await client.ask(request), questionId: 's1', input: piece, at: AT });
    assert.equal(result.exact_model, SCRIPTED_MODEL);
    assert.match(result.returned_model, /-scripted-/);
    assert.notEqual(result.reuse_key, REUSE_KEY);
  });

  it('refuses a question the exchange does not hold, a type mismatch and a bad timestamp', () => {
    const { request, response } = exchange();
    assert.throws(() => judgmentRecord({ request, response, questionId: 'other', input: piece, at: AT }), TypeError);
    const mismatched: JevResponse = { ...response, answers: { s1: { type: 'noul', noul: 0.5 } } };
    assert.throws(() => judgmentRecord({ request, response: mismatched, questionId: 's1', input: piece, at: AT }), TypeError);
    for (const at of ['2026-10-22 08:00:00', '2026-10-22T08:00:00+08:00', '2026-13-40T99:00:00Z', '']) {
      assert.throws(() => judgmentRecord({ request, response, questionId: 's1', input: piece, at }), RangeError, at);
    }
  });
});

describe('reuseKey', () => {
  const base = { model: 'jev-1.13.0', question: chapterQuestion(), stateDigest: STATE_DIGEST };

  it('has a pinned format', () => {
    assert.equal(reuseKey(base), REUSE_KEY);
  });

  it('ignores the question id, which the model never sees, and the identity of the objects', () => {
    assert.equal(record(undefined, 'q9').reuse_key, REUSE_KEY);
    assert.equal(reuseKey({ ...base, question: structuredClone(chapterQuestion()) }), REUSE_KEY);
  });

  it('changes with the model, the question text, the option order, a description or the state', () => {
    const reordered: JevChoiceQuestion = { ...chapterQuestion(), criteria: { 第02章: '系统管理', 第01章: '网络配置', none: '没有合适的章节' } };
    const described: JevChoiceQuestion = { ...chapterQuestion(), criteria: { ...chapterQuestion().criteria, none: null } };
    const variants = [
      reuseKey({ ...base, model: 'jev-1.14.0' }),
      reuseKey({ ...base, question: { ...chapterQuestion(), instructions: 'Which chapter holds `s1`?' } }),
      reuseKey({ ...base, question: reordered }),
      reuseKey({ ...base, question: described }),
      reuseKey({ ...base, stateDigest: inputDigest({ s1: { text: '另一个示例片段' } }) }),
      reuseKey({ ...base, stateDigest: inputDigest({ s1: piece, s2: { text: '旁边的另一个片段' } }) }),
      reuseKey({ ...base, question: { type: 'noul', instructions: chapterQuestion().instructions } }),
    ];
    assert.equal(new Set([REUSE_KEY, ...variants]).size, variants.length + 1);
  });

  it('treats a missing description like null', () => {
    const absent: JevQuestion = { type: 'noul', instructions: 'Is `s1` a command?' };
    const empty: JevQuestion = { type: 'noul', instructions: 'Is `s1` a command?', criteria: { true: null, false: null } };
    assert.equal(reuseKey({ ...base, question: absent }), reuseKey({ ...base, question: empty }));
  });

  it('is null for a model that is not an exact version, and refuses a malformed digest', () => {
    assert.equal(reuseKey({ ...base, model: 'jev-latest' }), null);
    assert.throws(() => reuseKey({ ...base, stateDigest: 'ABC' }), TypeError);
    assert.throws(() => reuseKey({ model: 'jev-1.13.0', question: chapterQuestion() } as unknown as Parameters<typeof reuseKey>[0]), TypeError);
  });

  it('lists candidates in the order they are sent', () => {
    assert.deepEqual(
      candidatesOf(chapterQuestion()).map((candidate) => candidate.name),
      ['第01章', '第02章', 'none'],
    );
  });
});

// The model judges every question of a request against the whole state, so a judgment is reusable only while the
// whole state it saw is unchanged.
describe('reuse across runs of a plan', () => {
  function pieces(texts: readonly string[]): JevBatchItem[] {
    return texts.map((text, index) => {
      const id = `s${index}`;
      return { id, piece: { text }, question: { ...chapterQuestion(), instructions: `Which chapter of the manual holds \`${id}\`?` } };
    });
  }

  const TEXTS = ['示例片段 甲', '示例片段 乙', '示例片段 丙', '示例片段 丁', '示例片段 戊', '示例片段 己'];

  async function keys(items: readonly JevBatchItem[], options: JevPlanOptions): Promise<Map<string, string | null>> {
    const client = new ScriptedJev(() => ({ choice: '第02章', p: 0.9 }));
    const plan = planBatches(items, options);
    const result = await askAll(client, plan);
    const out = new Map<string, string | null>();
    for (const item of items) {
      const answered = result.answered.get(item.id)!;
      const made = judgmentRecord({ request: answered.request, response: answered.response, questionId: item.id, input: item.piece, at: AT });
      assert.equal(made.state_digest, inputDigest(answered.request.state));
      assert.equal(made.input_digest, inputDigest(item.piece));
      out.set(item.id, made.reuse_key);
    }
    return out;
  }

  it('gives the same keys when an unchanged plan is asked again, and a key can be computed before asking', async () => {
    const items = pieces(TEXTS);
    const first = await keys(items, { maxQuestionsPerRequest: 3 });
    assert.deepEqual(await keys(pieces(TEXTS), { maxQuestionsPerRequest: 3 }), first);
    assert.equal(new Set(first.values()).size, 6);
    const plan = planBatches(items, { maxQuestionsPerRequest: 3 });
    const request = batchRequest(SCRIPTED_MODEL, plan, plan.batches[1]!.items);
    assert.equal(reuseKey({ model: SCRIPTED_MODEL, question: request.questions.s4!, stateDigest: inputDigest(request.state) }), first.get('s4'));
  });

  it('gives every question of a batch a new key when one piece of it changes, and leaves the other batches alone', async () => {
    const before = await keys(pieces(TEXTS), { maxQuestionsPerRequest: 3 });
    const changed = TEXTS.map((text, index) => (index === 1 ? '改过的示例片段 乙' : text));
    const after = await keys(pieces(changed), { maxQuestionsPerRequest: 3 });
    for (const id of ['s0', 's1', 's2']) assert.notEqual(after.get(id), before.get(id), id);
    for (const id of ['s3', 's4', 's5']) assert.equal(after.get(id), before.get(id), id);
  });

  it('tells batch compositions apart: a piece judged alone and beside others gets different keys', async () => {
    const together = await keys(pieces(TEXTS), { maxQuestionsPerRequest: 6 });
    const apart = await keys(pieces(TEXTS), { maxQuestionsPerRequest: 1 });
    for (const id of together.keys()) assert.notEqual(together.get(id), apart.get(id), id);
    const neighbour = TEXTS.map((text, index) => (index === 5 ? '改过的示例片段 己' : text));
    assert.equal((await keys(pieces(neighbour), { maxQuestionsPerRequest: 1 })).get('s0'), apart.get('s0'));
  });
});
