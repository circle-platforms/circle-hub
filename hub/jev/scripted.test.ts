import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JevError, SCRIPTED_MODEL, ScriptedJev, checkRequest } from './api.ts';
import type { JevChoiceAnswer, JevNoulAnswer, JevQuestion, JevRequest, JevScoreAnswer, ScriptedSpec } from './api.ts';

/** A synthetic request exercising the three question types. */
function sampleRequest(model: string = SCRIPTED_MODEL): JevRequest {
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

async function rejection(promise: Promise<unknown>): Promise<JevError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof JevError, `expected a JevError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected a rejection');
}

// Picks by question type: yes 0.9, the first option at 0.7, level 1 at 0.6.
function byType(question: JevQuestion): ScriptedSpec {
  if (question.type === 'noul') return { noul: 0.9 };
  if (question.type === 'choice') return { choice: Object.keys(question.criteria)[0]!, p: 0.7 };
  return { level: 1, p: 0.6 };
}

describe('ScriptedJev', () => {
  it('answers every question type deterministically', async () => {
    const first = await new ScriptedJev(byType).ask(sampleRequest(SCRIPTED_MODEL));
    const second = await new ScriptedJev(byType).ask(sampleRequest(SCRIPTED_MODEL));
    assert.deepEqual(first, second);
    assert.equal(first.model, SCRIPTED_MODEL);
    assert.equal(first.requestId, 'scripted-1');
    assert.deepEqual(first.answers.q1, { type: 'noul', noul: 0.9 });
    const choice = first.answers.q2 as JevChoiceAnswer;
    assert.equal(choice.choice, 'sectionA');
    assert.deepEqual(choice.probabilities, { sectionA: 0.7, sectionB: 0.15000000000000002, none: 0.15000000000000002 });
    assert.ok(Math.abs(choice.confidence - 0.55) < 1e-12);
    const score = first.answers.q3 as JevScoreAnswer;
    assert.deepEqual(score.legend, { 0: 'vague', 1: 'somewhat', 2: 'exact' });
    assert.ok(Math.abs(score.score - 1) < 1e-12);
    assert.equal(first.usage.outputTokens, 3);
    assert.ok(first.usage.inputTokens > 0);
  });

  it('records every request as a deep-frozen copy, in order', async () => {
    const client = new ScriptedJev(byType);
    const request = sampleRequest(SCRIPTED_MODEL);
    await client.ask(request);
    await client.ask({ ...request, state: 'second' });
    assert.equal(client.requests.length, 2);
    assert.deepEqual(client.requests[0], request);
    assert.equal(client.requests[1]!.state, 'second');
    (request.state as { item: { text: string } }).item.text = 'changed after the call';
    assert.notEqual((client.requests[0]!.state as { item: { text: string } }).item.text, 'changed after the call');
    assert.ok(Object.isFrozen(client.requests[0]!.questions.q2));
    assert.throws(() => {
      (client.requests[0]!.state as { item: { text: string } }).item.text = 'mutated';
    }, TypeError);
  });

  it('passes the question, the state and the id to the script', async () => {
    const seen: Array<[string, string, unknown]> = [];
    const client = new ScriptedJev((question, state, id) => {
      seen.push([id, question.type, state]);
      return byType(question);
    });
    await client.ask(sampleRequest(SCRIPTED_MODEL));
    assert.deepEqual(
      seen.map(([id, type]) => [id, type]),
      [
        ['q1', 'noul'],
        ['q2', 'choice'],
        ['q3', 'score'],
      ],
    );
    assert.deepEqual(seen[0]![2], sampleRequest().state);
  });

  it('can pick the explicit none option, the only way to say that nothing fits', async () => {
    const client = new ScriptedJev((question) => (question.type === 'choice' ? { choice: 'none', p: 0.8 } : byType(question)));
    const choice = (await client.ask(sampleRequest(SCRIPTED_MODEL))).answers.q2 as JevChoiceAnswer;
    assert.equal(choice.choice, 'none');
    assert.equal(choice.probabilities.none, 0.8);
  });

  it('cannot pick an option the question does not have', async () => {
    const request: JevRequest = {
      model: SCRIPTED_MODEL,
      state: 'x',
      questions: { q: { type: 'choice', instructions: 'Which?', criteria: { a: null, b: null } } },
    };
    await assert.rejects(new ScriptedJev(() => ({ choice: 'none' })).ask(request), TypeError);
  });

  it('derives choice and score from an explicit distribution, filling missing options with 0', async () => {
    const client = new ScriptedJev((question): ScriptedSpec =>
      question.type === 'choice' ? { probabilities: { sectionB: 0.75, none: 0.25 } } : question.type === 'score' ? { probabilities: { 0: 0.5, 2: 0.5 } } : { noul: 0.2 },
    );
    const response = await client.ask(sampleRequest(SCRIPTED_MODEL));
    assert.deepEqual(response.answers.q2, { type: 'choice', choice: 'sectionB', confidence: 0.625, probabilities: { sectionA: 0, sectionB: 0.75, none: 0.25 } });
    const score = response.answers.q3 as JevScoreAnswer;
    assert.equal(score.score, 1);
    assert.deepEqual(score.probabilities, { 0: 0.5, 1: 0, 2: 0.5 });
    assert.equal((response.answers.q1 as JevNoulAnswer).noul, 0.2);
  });

  it('fails the whole request with the scripted code after the scripted latency', async () => {
    const delays: number[] = [];
    const client = new ScriptedJev((question, _state, id) => (id === 'q2' ? { fail: 'JEV_RATE_LIMITED', delayMs: 40 } : { ...byType(question), delayMs: 10 }), {
      sleep: async (ms) => void delays.push(ms),
    });
    const error = await rejection(client.ask(sampleRequest(SCRIPTED_MODEL)));
    assert.equal(error.code, 'JEV_RATE_LIMITED');
    assert.equal(error.requestId, 'scripted-1');
    assert.deepEqual(delays, [40]);
    assert.equal(client.requests.length, 1);
  });

  it('waits for real when no sleep is injected', async () => {
    const started = Date.now();
    await new ScriptedJev((question) => ({ ...byType(question), delayMs: 60 })).ask(sampleRequest(SCRIPTED_MODEL));
    assert.ok(Date.now() - started >= 55);
  });

  it('validates scripted answers with the service rules every client shared', async () => {
    const cases: Array<[string, (question: JevQuestion) => ScriptedSpec, RegExp]> = [
      ['a sum of 2', (q) => (q.type === 'choice' ? { probabilities: { sectionA: 1, sectionB: 0.5, none: 0.5 } } : byType(q)), /概率之和是 2/],
      ['a probability above 1', (q) => (q.type === 'noul' ? { noul: 1.5 } : byType(q)), /q1 的 noul 不是/],
      ['NaN', (q) => (q.type === 'noul' ? { noul: Number.NaN } : byType(q)), /q1 的 noul 不是/],
      ['a choice that is not the most probable', (q) => (q.type === 'choice' ? { choice: 'sectionA', p: 0.2 } : byType(q)), /不是概率最高的项/],
      ['a raw answer of the wrong type', (q) => (q.type === 'score' ? { raw: { type: 'noul', noul: 0.5 } } : byType(q)), /q3 的回答类型不是 score/],
      ['a raw answer that is not an object', (q) => (q.type === 'noul' ? { raw: 'yes' } : byType(q)), /q1 的回答不是对象/],
    ];
    for (const [name, script, why] of cases) {
      const error = await rejection(new ScriptedJev(script).ask(sampleRequest(SCRIPTED_MODEL)));
      assert.equal(error.code, 'JEV_BAD_RESPONSE', name);
      assert.match(error.message, why, name);
    }
  });

  it('refuses requests locally exactly as the removed client did and records nothing', async () => {
    const client = new ScriptedJev(byType, { maxRequestBytes: 4096 });
    const criteria: Record<string, null> = {};
    for (let index = 0; index < 256; index++) criteria[`o${index}`] = null;
    const tooMany: JevRequest = { model: SCRIPTED_MODEL, state: 'x', questions: { q: { type: 'choice', instructions: 'Which?', criteria } } };
    const tooBig: JevRequest = { ...sampleRequest(SCRIPTED_MODEL), state: '示'.repeat(2000) };
    const otherModel = sampleRequest('jev-1.13.0');
    for (const request of [tooMany, tooBig, otherModel]) {
      const expected = (() => {
        try {
          checkRequest(request, { pinnedModel: SCRIPTED_MODEL, maxRequestBytes: 4096 });
        } catch (error) {
          return (error as JevError).code;
        }
        return 'accepted';
      })();
      const error = await rejection(client.ask(request));
      assert.equal(error.code, expected);
    }
    assert.equal(client.requests.length, 0);
  });

  it('refuses aliases unless allowAlias is set, and checks the returned model', async () => {
    assert.throws(() => new ScriptedJev(byType, { model: 'jev-scripted-latest' }), (error: unknown) => error instanceof JevError && error.code === 'JEV_BAD_REQUEST');
    const alias = new ScriptedJev(byType, { model: 'jev-scripted-latest', allowAlias: true, returnedModel: 'jev-scripted-1.13.0' });
    assert.equal((await alias.ask(sampleRequest('jev-scripted-latest'))).model, 'jev-scripted-1.13.0');
    const drifted = new ScriptedJev(byType, { model: 'jev-scripted-1.13.0', returnedModel: 'jev-scripted-1.14.0' });
    const error = await rejection(drifted.ask(sampleRequest('jev-scripted-1.13.0')));
    assert.equal(error.code, 'JEV_BAD_RESPONSE');
  });

  it('refuses a model name without the scripted segment, so its judgments never pass for the service', () => {
    const vendorNamed = [
      { model: 'jev-1.13.0' },
      { returnedModel: 'jev-1.13.0' },
      { model: 'jev-latest', allowAlias: true },
      { model: 'jev-scripted-latest', allowAlias: true, returnedModel: 'jev-1.13.0' },
      { model: 'jev-unscripted-1.0.0' },
      { model: 'jev-scripted2-1.0.0' },
    ];
    for (const options of vendorNamed) {
      assert.throws(
        () => new ScriptedJev(byType, options),
        (error: unknown) => error instanceof JevError && error.code === 'JEV_BAD_REQUEST' && /scripted/.test(error.message),
        JSON.stringify(options),
      );
    }
    for (const model of [SCRIPTED_MODEL, 'jev-scripted-1.13.0', 'scripted-2.0.0']) assert.equal(new ScriptedJev(byType, { model }).pinnedModel, model);
  });

  it('throws a TypeError for a spec that does not fit the question', async () => {
    const misfits: Array<(question: JevQuestion) => unknown> = [
      (q) => (q.type === 'noul' ? { choice: 'sectionA' } : byType(q)),
      (q) => (q.type === 'choice' ? { level: 0 } : byType(q)),
      (q) => (q.type === 'score' ? { choice: 'vague' } : byType(q)),
      (q) => (q.type === 'choice' ? { probabilities: { sectionZ: 1 } } : byType(q)),
      (q) => (q.type === 'choice' ? { choice: 'sectionA', p: 2 } : byType(q)),
      (q) => (q.type === 'noul' ? { fail: 'NOT_A_CODE' } : byType(q)),
      (q) => (q.type === 'noul' ? { noul: 0.5, delayMs: -1 } : byType(q)),
      () => null,
    ];
    for (const script of misfits) {
      await assert.rejects(new ScriptedJev(script as (question: JevQuestion) => ScriptedSpec).ask(sampleRequest(SCRIPTED_MODEL)), TypeError);
    }
  });
});
