import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JevError, checkQuestion, checkRequest, checkResponse, isQuestionId, isVersionedModel } from './api.ts';
import type { JevChoiceQuestion, JevRequest } from './api.ts';
import { hasDuplicateKey, jsonProblem, parseResponseText } from './validate.ts';

const MODEL = 'jev-1.13.0';

/** A synthetic request exercising the three question types. */
function sampleRequest(model: string = MODEL): JevRequest {
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

const limits = { pinnedModel: MODEL, maxRequestBytes: 1024 * 1024 };

function refusal(run: () => unknown, code = 'JEV_BAD_REQUEST'): JevError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof JevError, `expected a JevError, got ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail('expected a refusal');
}

describe('model ids and question ids', () => {
  it('tells versioned ids from aliases', () => {
    for (const model of ['jev-1.13.0', 'jev-1.14.0', 'jev-scripted-1.0.0', 'jev-0.0.1']) assert.equal(isVersionedModel(model), true, model);
    for (const model of ['jev-latest', 'jev-preview', 'jev-1.13', 'jev-01.13.0', 'jev-1.13.0-rc1', 'jev 1.13.0', '', 13]) {
      assert.equal(isVersionedModel(model), false, String(model));
    }
  });

  it('accepts short ids of letters, digits, _ and - only', () => {
    for (const id of ['q1', 'span_ab12', 'a-b', 'x'.repeat(128)]) assert.equal(isQuestionId(id), true, id);
    for (const id of ['', 'a.b', 'a b', '问题', 'x'.repeat(129), '__proto__', 7]) assert.equal(isQuestionId(id), false, String(id));
  });
});

describe('checkRequest', () => {
  it('serializes exactly the normalized request and counts UTF-8 bytes', () => {
    const checked = checkRequest(sampleRequest(), limits);
    assert.equal(checked.body, JSON.stringify(sampleRequest()));
    assert.equal(checked.bytes, Buffer.byteLength(checked.body, 'utf8'));
    assert.ok(checked.bytes > checked.body.length);
  });

  it('drops undefined members, keeps null descriptions and option order', () => {
    const request = {
      model: MODEL,
      state: 'x',
      questions: {
        a: { type: 'noul', instructions: 'Is it?', criteria: { true: 'yes', false: undefined } },
        b: { type: 'choice', instructions: 'Which?', criteria: { z: null, a: 'first letter', m: null } },
        c: { type: 'noul', instructions: 'Is it?', criteria: null },
      },
    } as unknown as JevRequest;
    const checked = checkRequest(request, limits);
    assert.deepEqual(checked.request.questions.a, { type: 'noul', instructions: 'Is it?', criteria: { true: 'yes' } });
    assert.deepEqual(Object.keys((checked.request.questions.b as { criteria: object }).criteria), ['z', 'a', 'm']);
    assert.deepEqual(checked.request.questions.c, { type: 'noul', instructions: 'Is it?' });
  });

  it('refuses unknown fields, bad ids and bad question parts', () => {
    const bad: unknown[] = [
      { ...sampleRequest(), extra: 1 },
      { ...sampleRequest(), model: '' },
      { ...sampleRequest(), state: null },
      { ...sampleRequest(), state: 42 },
      { ...sampleRequest(), questions: [] },
      { ...sampleRequest(), questions: { 'a.b': { type: 'noul', instructions: 'x' } } },
      { ...sampleRequest(), questions: JSON.parse('{"__proto__":{"type":"noul","instructions":"x"}}') },
      { ...sampleRequest(), questions: { q: { type: 'noul', instructions: 'x', weight: 2 } } },
      { ...sampleRequest(), questions: { q: { type: 'noul', instructions: '  ' } } },
      { ...sampleRequest(), questions: { q: { type: 'noul', instructions: 'x', criteria: { maybe: 'x' } } } },
      { ...sampleRequest(), questions: { q: { type: 'noul', instructions: 'x', criteria: { true: 1 } } } },
      { ...sampleRequest(), questions: { q: { type: 'choice', instructions: 'x', criteria: { a: undefined } } } },
      { ...sampleRequest(), questions: { q: { type: 'choice', instructions: 'x', criteria: { ' ': null } } } },
      { ...sampleRequest(), questions: { q: { type: 'choice', instructions: 'x', criteria: JSON.parse('{"__proto__":null,"a":null}') } } },
      { ...sampleRequest(), questions: { q: { type: 'choice', instructions: 'x', criteria: ['a', 'b'] } } },
      { ...sampleRequest(), questions: { q: { type: 'score', instructions: 'x', criteria: ['a', ''] } } },
      { ...sampleRequest(), questions: { q: { type: 'score', instructions: 'x', criteria: { 0: 'a', 1: 'b' } } } },
      { ...sampleRequest(), questions: { q: { type: 'yesno', instructions: 'x' } } },
      { ...sampleRequest(), questions: { q: null } },
    ];
    for (const request of bad) refusal(() => checkRequest(request, limits));
  });

  it('refuses option names that are array indices, which an object moves to the front in numeric order', () => {
    for (const name of ['0', '4', '12', '4294967294']) {
      const criteria: Record<string, string | null> = { none: '都不合适' };
      criteria[name] = null;
      const error = refusal(() => checkQuestion('q', { type: 'choice', instructions: 'Which node holds `x`?', criteria }));
      assert.match(error.message, /纯数字/);
      assert.match(error.message, /前缀/);
      assert.ok(!error.message.includes('4294967294'));
    }
    for (const name of ['4294967295', '01', '-1', '1.5', 'n12', '12a', '１２']) {
      const criteria: Record<string, string | null> = { none: '都不合适' };
      criteria[name] = null;
      const question = checkQuestion('q', { type: 'choice', instructions: 'Which node holds `x`?', criteria }) as JevChoiceQuestion;
      assert.deepEqual(Object.keys(question.criteria), ['none', name], name);
    }
  });

  it('names the question and the position, never the option text', () => {
    const error = refusal(() =>
      checkRequest({ ...sampleRequest(), questions: { q7: { type: 'choice', instructions: 'x', criteria: { 秘密选项: 3 } } } } as unknown as JevRequest, limits),
    );
    assert.match(error.message, /问题 q7 的第 1 个选项的说明/);
    assert.ok(!error.message.includes('秘密选项'));
  });

  it('describes a bad state value without quoting the state', () => {
    const error = refusal(() => checkRequest({ ...sampleRequest(), state: { 秘密键: Number.NaN } } as unknown as JevRequest, limits));
    assert.match(error.message, /非有限数字/);
    assert.ok(!error.message.includes('秘密键'));
  });

  it('refuses the pinned-model mismatch and the size limit with their own codes', () => {
    refusal(() => checkRequest(sampleRequest('jev-1.14.0'), limits));
    refusal(() => checkRequest(sampleRequest(), { pinnedModel: MODEL, maxRequestBytes: 100 }), 'JEV_TOO_LARGE');
  });

  it('normalizes a single question the same way', () => {
    assert.deepEqual(checkQuestion('q', { type: 'score', instructions: 'Rate.', criteria: ['low', 'high'] }), { type: 'score', instructions: 'Rate.', criteria: ['low', 'high'] });
  });
});

describe('jsonProblem', () => {
  it('counts container levels from the given depth', () => {
    assert.equal(jsonProblem({ a: [1] }, 63), null);
    assert.match(jsonProblem({ a: [1] }, 64) ?? '', /64 层/);
    assert.equal(jsonProblem('deep string', 1000), null);
  });

  it('stops on a cycle instead of recursing forever', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    assert.match(jsonProblem(cycle, 2) ?? '', /64 层/);
  });

  it('accepts null-prototype objects and unicode keys', () => {
    const value = Object.assign(Object.create(null) as Record<string, unknown>, { 键: '值', n: -0, e: 1e-300 });
    assert.equal(jsonProblem(value, 2), null);
  });
});

describe('hasDuplicateKey', () => {
  it('finds a repeated member name at any level', () => {
    assert.equal(hasDuplicateKey('{"a":1,"a":2}'), true);
    assert.equal(hasDuplicateKey('{"x":{"a":1,"b":{"c":1,"c":2}}}'), true);
    assert.equal(hasDuplicateKey('[{"a":1},{"a":1,"a":3}]'), true);
    assert.equal(hasDuplicateKey('{"a":1,"\\u0061":2}'), true);
  });

  it('does not confuse values, escaped quotes or sibling objects with repeated keys', () => {
    assert.equal(hasDuplicateKey('{"a":"a","b":["a","a"],"c":{"a":1},"d":{"a":1}}'), false);
    assert.equal(hasDuplicateKey('{"k\\"":1,"k":2,"q":"x\\",\\"k\\":"}'), false);
    assert.equal(hasDuplicateKey('{"a\\\\":1,"a":2}'), false);
    assert.equal(hasDuplicateKey('[]'), false);
    assert.equal(hasDuplicateKey('"just a string"'), false);
    assert.equal(hasDuplicateKey('{}'), false);
  });

  it('is used by parseResponseText', () => {
    const context = { pinnedModel: MODEL };
    assert.deepEqual(parseResponseText('{"a":1}', context), { a: 1 });
    refusal(() => parseResponseText('{"a":1,"a":1}', context), 'JEV_BAD_RESPONSE');
    refusal(() => parseResponseText('{"a":', context), 'JEV_BAD_RESPONSE');
  });
});

describe('checkResponse', () => {
  const request = checkRequest(sampleRequest(), limits).request;
  const valid = {
    model: MODEL,
    answers: {
      q1: { type: 'noul', noul: 0.25 },
      q2: { type: 'choice', choice: 'none', confidence: 0.1, probabilities: { sectionA: 0.3, sectionB: 0.3, none: 0.4 } },
      q3: { type: 'score', score: 0, confidence: 1, legend: { 0: 'vague', 1: 'somewhat', 2: 'exact' }, probabilities: { 0: 1, 1: 0, 2: 0 } },
    },
    usage: { input_tokens: 0, output_tokens: 0 },
  };

  it('accepts a valid response and drops fields it does not know (forward compatible)', () => {
    const extended = structuredClone(valid) as Record<string, unknown>;
    extended.latency_ms = 12;
    (extended.answers as Record<string, Record<string, unknown>>).q1!.reasoning = 'not part of the contract';
    const response = checkResponse(request, extended, { pinnedModel: MODEL, requestId: 'req_9' });
    assert.deepEqual(response.answers.q1, { type: 'noul', noul: 0.25 });
    assert.equal(response.requestId, 'req_9');
    assert.deepEqual(Object.keys(response), ['model', 'answers', 'usage', 'requestId']);
  });

  it('accepts the probability bounds 0 and 1 exactly', () => {
    const response = checkResponse(request, valid, { pinnedModel: MODEL });
    assert.equal(response.answers.q3!.type, 'score');
    assert.equal(response.requestId, undefined);
  });

  it('treats a __proto__ answer key from JSON as an extra answer', () => {
    const raw = JSON.parse(JSON.stringify(valid).replace('"answers":{', '"answers":{"__proto__":{"type":"noul","noul":0.5},'));
    const error = refusal(() => checkResponse(request, raw, { pinnedModel: MODEL }), 'JEV_BAD_RESPONSE');
    assert.match(error.message, /1 个回答不对应/);
  });

  it('accepts any model name for an alias-pinned client but still checks its shape', () => {
    const aliasRequest = { ...request, model: 'jev-latest' };
    assert.equal(checkResponse(aliasRequest, { ...valid, model: 'jev-1.13.0' }, { pinnedModel: 'jev-latest' }).model, 'jev-1.13.0');
    refusal(() => checkResponse(aliasRequest, { ...valid, model: 'has space' }, { pinnedModel: 'jev-latest' }), 'JEV_BAD_RESPONSE');
  });

  it('carries the attempt count and status into its errors', () => {
    const error = refusal(() => checkResponse(request, { ...valid, answers: {} }, { pinnedModel: MODEL, attempts: 3, status: 200, requestId: 'r' }), 'JEV_BAD_RESPONSE');
    assert.equal(error.attempts, 3);
    assert.equal(error.status, 200);
    assert.equal(error.requestId, 'r');
    assert.equal(error.questionId, 'q1');
  });
});
