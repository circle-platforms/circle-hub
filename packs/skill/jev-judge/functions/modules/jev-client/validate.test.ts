import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JevCallError, parseJevJson, validateJevRequest, validateJevResponse } from './index.ts';
import type { JevQuestion, JevRequest } from './index.ts';
import { MARKERS, answerBody, markerRequest, mixedRequest, noulRequest } from '../../../testing/synthetic.ts';

const FORM = /^(参数无效|无权限|暂时不可用)：[^。]+。[^。]+。$/u;

function refused(request: unknown, code = 'invalid_request'): JevCallError {
  try {
    validateJevRequest(request);
  } catch (error) {
    assert.ok(error instanceof JevCallError, String(error));
    assert.equal(error.category, '参数无效');
    assert.equal(error.code, code);
    assert.equal(error.status, 0);
    assert.equal(error.retryable, false);
    assert.match(error.message, FORM);
    return error;
  }
  assert.fail('the request was accepted');
}

const withQuestion = (question: unknown, id = 'q'): unknown => ({ state: 'a state', questions: { [id]: question } });
const noul = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: 'noul', instructions: 'Is it?', ...extra });
const choice = (criteria: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: 'choice', instructions: 'Which?', criteria, ...extra });
const score = (criteria: unknown): Record<string, unknown> => ({ type: 'score', instructions: 'How far?', criteria });
const options = (count: number): Record<string, string> => Object.fromEntries(Array.from({ length: count }, (_, index) => [`option_${index}`, `description ${index}`]));
const levels = (count: number): string[] => Array.from({ length: count }, (_, index) => `level ${index}`);
const own = <T>(record: Record<string, T>, name: string): T => record[name] as T;
const deep = (depth: number): unknown => (depth === 0 ? 'leaf' : { next: deep(depth - 1) });

describe('a request is checked before it is sent', () => {
  it('refuses what is not a request', () => {
    for (const request of [null, undefined, 'text', 42, [], [noulRequest]]) refused(request);
    refused({ ...noulRequest, apiKey: MARKERS.key });
    refused({ ...noulRequest, endpoint: 'https://example.invalid/' });
  });

  it('refuses a missing or unusable state', () => {
    refused({ questions: noulRequest.questions });
    refused({ state: undefined, questions: noulRequest.questions });
    const states: unknown[] = [null, 42, true, () => 1, Symbol('s'), 10n, { n: Number.NaN }, { n: Infinity }, [undefined], [, 1], { d: new Date() }, new Map(), '\ud800', { '\ud800': 1 }, deep(70)];
    for (const state of states) refused({ state, questions: noulRequest.questions });
    const circular: Record<string, unknown> = {};
    circular.me = circular;
    refused({ state: circular, questions: noulRequest.questions });
  });

  it('takes a string, an array or a plain object as the state, however it is nested within 64 levels', () => {
    for (const state of ['', 'text', [], [1, 'a', null, { b: [true] }], {}, { a: { b: [1] } }, Object.create(null) as object, deep(60)]) {
      assert.doesNotThrow(() => validateJevRequest({ state, questions: noulRequest.questions }), JSON.stringify(state)?.slice(0, 40));
    }
  });

  it('refuses a missing or empty set of questions and a question id outside 1 to 128 of A-Z a-z 0-9 _ -', () => {
    for (const questions of [undefined, null, [], 'q', 5, {}]) refused({ state: 'x', questions });
    for (const id of ['', 'a b', 'é', 'a.b', 'a:b', 'x'.repeat(129), '问题']) refused(withQuestion(noul(), id));
    refused(JSON.parse('{"state":"x","questions":{"__proto__":{"type":"noul","instructions":"Is it?"}}}'));
    assert.doesNotThrow(() => validateJevRequest(withQuestion(noul(), 'x'.repeat(128))));
    assert.doesNotThrow(() => validateJevRequest(withQuestion(noul(), 'A_b-9')));
  });

  it('refuses a question that is not an object, has an unknown field or an unknown type', () => {
    for (const question of [null, 'noul', 5, [], { instructions: 'Is it?' }, { type: 'essay', instructions: 'Write.' }, { type: 'NOUL', instructions: 'Is it?' }, noul({ extra: 1 }), noul({ model: 'x' })]) refused(withQuestion(question));
  });

  it('refuses instructions that are not a non-empty well-formed string', () => {
    for (const instructions of [undefined, '', '  ', 5, { text: 'x' }, ['x'], '\ud800']) refused(withQuestion({ type: 'noul', instructions }));
  });

  it('takes a yes/no question with no criteria or with a true and a false description', () => {
    for (const extra of [{}, { criteria: undefined }, { criteria: null }, { criteria: {} }, { criteria: { true: 'a' } }, { criteria: { true: 'a', false: 'b' } }]) {
      assert.doesNotThrow(() => validateJevRequest(withQuestion(noul(extra))), JSON.stringify(extra));
    }
    for (const criteria of [[], 'x', 5, { maybe: 'x' }, { true: '' }, { false: '  ' }, { true: 5 }, { true: null }, { true: 'a', other: 'b' }]) refused(withQuestion(noul({ criteria })));
  });

  it('refuses a single-choice question without 1 to 255 options named and described as text', () => {
    for (const criteria of [undefined, null, [], 'a', 5, {}, options(256)]) refused(withQuestion(choice(criteria)));
    for (const criteria of [{ '': 'x' }, { '  ': 'x' }, { a: 5 }, { a: null }, { a: undefined }, { a: {} }, { a: '\ud800' }, JSON.parse('{"__proto__":"x"}')]) refused(withQuestion(choice(criteria)));
    assert.doesNotThrow(() => validateJevRequest(withQuestion(choice(options(1)))));
    assert.doesNotThrow(() => validateJevRequest(withQuestion(choice(options(255)))));
    assert.doesNotThrow(() => validateJevRequest(withQuestion(choice({ a: '' }))));
  });

  it('refuses an option name that is a bare number, because an object would move it to the front', () => {
    for (const criteria of [{ '0': 'x' }, { '12': 'x', a: 'y' }, { a: 'x', '3': 'y' }]) refused(withQuestion(choice(criteria)));
    assert.doesNotThrow(() => validateJevRequest(withQuestion(choice({ n12: 'x', '12a': 'y', '-1': 'z', '01': 'w' }))));
  });

  it('keeps the order of the options as written', () => {
    const checked = validateJevRequest(withQuestion(choice({ zebra: 'z', apple: 'a', mango: 'm' })));
    assert.deepEqual(Object.keys((checked.questions.q as Extract<JevQuestion, { type: 'choice' }>).criteria), ['zebra', 'apple', 'mango']);
    assert.deepEqual(Object.keys(JSON.parse(checked.body).questions.q.criteria), ['zebra', 'apple', 'mango']);
  });

  it('refuses an ordered scale without 2 to 10 non-empty levels', () => {
    for (const criteria of [undefined, null, {}, 'a', 5, [], levels(1), levels(11), ['a', ''], ['a', '  '], ['a', 5], ['a', null], ['a', , 'c']]) refused(withQuestion(score(criteria)));
    assert.doesNotThrow(() => validateJevRequest(withQuestion(score(levels(2)))));
    assert.doesNotThrow(() => validateJevRequest(withQuestion(score(levels(10)))));
  });

  it('refuses a model that is not a model name', () => {
    for (const model of ['', 'a b', 'x'.repeat(129), 5, 'jév', null, ['jev-latest']]) refused({ ...noulRequest, model });
    for (const model of ['jev-latest', 'jev-1.14.0', 'x'.repeat(128)]) assert.doesNotThrow(() => validateJevRequest({ ...noulRequest, model }));
  });

  it('refuses a body over 32 MiB with its own code', () => {
    refused({ state: 'x'.repeat(33 * 1024 * 1024), questions: noulRequest.questions }, 'request_too_large');
  });

  it('never names the content of what it refuses', () => {
    const request = markerRequest();
    const bad = [
      { ...request, [MARKERS.key]: 1 },
      { ...request, questions: { ...request.questions, [MARKERS.instructions + ' id']: noul() } },
      { state: MARKERS.state + '\ud800', questions: request.questions },
      { state: MARKERS.state, questions: { q: { type: 'choice', instructions: MARKERS.instructions, criteria: { [MARKERS.option]: 5 } } } },
      { state: MARKERS.state, questions: { q: { type: 'choice', instructions: MARKERS.instructions, criteria: { '7': MARKERS.description, [MARKERS.option]: 'x' } } } },
      { state: MARKERS.state, questions: { q: { type: 'noul', instructions: MARKERS.instructions, criteria: { [MARKERS.option]: MARKERS.description } } } },
      { state: MARKERS.state, questions: { q: { type: 'score', instructions: MARKERS.instructions, criteria: [MARKERS.level, 5] } } },
      { state: MARKERS.state, model: MARKERS.state + ' x', questions: request.questions },
    ];
    for (const candidate of bad) {
      const error = refused(candidate);
      for (const marker of Object.values(MARKERS)) assert.ok(!error.message.includes(marker), `${marker} in ${error.message}`);
    }
  });

  it('returns normalized copies, the exact body, its size and the types in question order', () => {
    const checked = validateJevRequest({ ...mixedRequest, model: 'jev-1.14.0' });
    assert.equal(checked.model, 'jev-1.14.0');
    assert.deepEqual(Object.keys(JSON.parse(checked.body)), ['state', 'model', 'questions']);
    assert.equal(checked.body, JSON.stringify({ state: mixedRequest.state, model: 'jev-1.14.0', questions: mixedRequest.questions }));
    assert.equal(checked.bytes, Buffer.byteLength(checked.body, 'utf8'));
    assert.deepEqual(checked.types, ['noul', 'choice', 'score']);
    assert.notEqual(checked.questions.alpha, mixedRequest.questions.alpha);
    assert.equal(validateJevRequest(noulRequest).model, 'jev-latest');
    assert.equal(validateJevRequest(noulRequest, 'jev-2.0.0').model, 'jev-2.0.0');
  });

  it('counts bytes, not characters', () => {
    const checked = validateJevRequest({ state: '步骤', questions: noulRequest.questions });
    assert.ok(checked.bytes > checked.body.length);
  });
});

describe('an answer is checked before it is used', () => {
  const asked = validateJevRequest(mixedRequest);
  const sentBody = (): ReturnType<typeof answerBody> => answerBody({ url: '', headers: {}, body: asked.body, timeoutMs: 1 });
  const refusedAnswer = (raw: unknown): JevCallError => {
    try {
      validateJevResponse(asked.questions, raw);
    } catch (error) {
      assert.ok(error instanceof JevCallError, String(error));
      assert.equal(error.category, '暂时不可用');
      assert.equal(error.code, 'invalid_response');
      assert.equal(error.status, 200);
      assert.equal(error.retryable, false);
      assert.match(error.message, FORM);
      return error;
    }
    return assert.fail('the answer was accepted');
  };
  const mutated = (change: (body: Record<string, any>) => void): Record<string, any> => {
    const body = structuredClone(sentBody()) as Record<string, any>;
    change(body);
    return body;
  };

  it('takes a valid answer and returns protocol fields only, in question order', () => {
    const body = { ...sentBody(), debug: 'extra', usage: { input_tokens: 120, output_tokens: 30, billing: 'extra' } };
    body.answers.zeta = { ...body.answers.zeta, extra: 1 };
    const checked = validateJevResponse(asked.questions, body);
    assert.deepEqual(Object.keys(checked), ['model', 'answers', 'usage']);
    assert.deepEqual(Object.keys(checked.answers), ['zeta', 'alpha', 'mid']);
    assert.deepEqual(checked.usage, { input_tokens: 120, output_tokens: 30 });
    assert.deepEqual(checked.answers.zeta, { type: 'noul', noul: 0.75 });
    assert.deepEqual(Object.keys(checked.answers.alpha as object), ['type', 'choice', 'probabilities', 'confidence']);
    assert.deepEqual(Object.keys((checked.answers.alpha as { probabilities: object }).probabilities), ['b', 'a', 'none']);
    assert.deepEqual(Object.keys(checked.answers.mid as object), ['type', 'score', 'legend', 'probabilities', 'confidence']);
  });

  it('refuses what is not an answer object with a model, answers and usage', () => {
    for (const raw of [null, undefined, 'x', 5, [], {}]) refusedAnswer(raw);
    for (const model of [undefined, '', 5, 'a b', 'x'.repeat(129), null]) refusedAnswer(mutated((b) => void (b.model = model)));
    for (const usage of [undefined, null, [], { input_tokens: 1 }, { input_tokens: -1, output_tokens: 1 }, { input_tokens: 1.5, output_tokens: 1 }, { input_tokens: true, output_tokens: 1 }, { input_tokens: '1', output_tokens: 1 }, { input_tokens: 1, output_tokens: Number.MAX_SAFE_INTEGER + 2 }]) {
      refusedAnswer(mutated((b) => void (b.usage = usage)));
    }
    for (const answers of [undefined, null, [], 'x']) refusedAnswer(mutated((b) => void (b.answers = answers)));
  });

  it('wants every question answered once and nothing else', () => {
    refusedAnswer(mutated((b) => void delete b.answers.zeta));
    refusedAnswer(mutated((b) => void (b.answers.extra = { type: 'noul', noul: 0.5 })));
    refusedAnswer(mutated((b) => void (b.answers.zeta = null)));
    refusedAnswer(mutated((b) => void (b.answers.zeta = [])));
    refusedAnswer(mutated((b) => void (b.answers.alpha = { ...b.answers.zeta })));
    refusedAnswer(mutated((b) => void (b.answers.zeta = { ...b.answers.alpha })));
  });

  it('wants a yes/no answer to be a finite number from 0 to 1', () => {
    for (const noul of [undefined, null, '0.5', true, -0.01, 1.01, 2, Number.MAX_VALUE]) refusedAnswer(mutated((b) => void (b.answers.zeta.noul = noul)));
    for (const noul of [0, 1, 0.5]) assert.doesNotThrow(() => validateJevResponse(asked.questions, mutated((b) => void (b.answers.zeta.noul = noul))));
  });

  it('wants a single-choice answer to be one of the options, the most probable, over exactly those options', () => {
    for (const choiceValue of [undefined, null, 5, 'zzz', 'toString', '__proto__', 'a ']) refusedAnswer(mutated((b) => void (b.answers.alpha.choice = choiceValue)));
    refusedAnswer(mutated((b) => void (b.answers.alpha.choice = 'a'))); // b has 0.7, a has 0.3
    for (const probabilities of [undefined, null, [], 'x', { b: 0.7, a: 0.3 }, { b: 0.7, a: 0.2, none: 0.1, extra: 0 }, { b: 0.7, a: 0.3, other: 0 }]) {
      refusedAnswer(mutated((b) => void (b.answers.alpha.probabilities = probabilities)));
    }
    for (const bad of [-0.1, 1.1, '0.7', null, true]) refusedAnswer(mutated((b) => void (b.answers.alpha.probabilities.b = bad)));
    refusedAnswer(mutated((b) => void (b.answers.alpha.probabilities = { b: 0.7, a: 0.2, none: 0 })));
    refusedAnswer(mutated((b) => void (b.answers.alpha.probabilities = { b: 0.7, a: 0.3, none: 0.1 })));
    for (const confidence of [undefined, null, '0.5', -0.1, 1.5, true]) refusedAnswer(mutated((b) => void (b.answers.alpha.confidence = confidence)));
  });

  it('takes a tie for the top and a sum that is off by rounding only', () => {
    const tie = mutated((b) => {
      b.answers.alpha.probabilities = { b: 0.5, a: 0.5, none: 0 };
      b.answers.alpha.choice = 'a';
    });
    assert.doesNotThrow(() => validateJevResponse(asked.questions, tie));
    const rounded = mutated((b) => void (b.answers.alpha.probabilities = { b: 0.7004, a: 0.2998, none: 0 }));
    assert.doesNotThrow(() => validateJevResponse(asked.questions, rounded));
  });

  it('takes probabilities that sum to 1 within a thousandth and no further', () => {
    const sums: ReadonlyArray<[number, number, boolean]> = [[0.3009, 0, true], [0.2991, 0, true], [0.3011, 0, false], [0.2989, 0, false], [0.3, 0.0009, true], [0.3, 0.0011, false]];
    for (const [a, none, ok] of sums) {
      const body = mutated((b) => {
        b.answers.alpha.probabilities = { b: 0.7, a, none };
        b.answers.alpha.choice = 'b';
      });
      if (ok) assert.doesNotThrow(() => validateJevResponse(asked.questions, body), JSON.stringify({ a, none }));
      else assert.throws(() => validateJevResponse(asked.questions, body), JevCallError, JSON.stringify({ a, none }));
    }
  });

  it('takes the legend as the service sent it, and a score between two levels', () => {
    const body = mutated((b) => {
      b.answers.mid.legend = { '0': 'zero', '1': 'one', '2': 'two' };
      b.answers.mid.score = 1.25;
    });
    const checked = validateJevResponse(asked.questions, body);
    assert.deepEqual((checked.answers.mid as { legend: unknown; score: number }).legend, { '0': 'zero', '1': 'one', '2': 'two' });
    assert.equal((checked.answers.mid as { score: number }).score, 1.25);
  });

  it('wants a scale answer to hold a legend and probabilities for exactly the levels and a score in range', () => {
    for (const score of [undefined, null, '1', -0.1, 2.01, Number.NaN, true]) refusedAnswer(mutated((b) => void (b.answers.mid.score = score === Number.NaN ? 'NaN' : score)));
    for (const legend of [undefined, null, [], { '0': 'a', '1': 'b' }, { '0': 'a', '1': 'b', '2': 'c', '3': 'd' }, { '0': 'a', '1': 'b', '3': 'c' }, { '0': 'a', '1': 'b', '2': 5 }, { '0': 'a', '1': 'b', '2': null }]) {
      refusedAnswer(mutated((b) => void (b.answers.mid.legend = legend)));
    }
    for (const probabilities of [undefined, { '0': 0, '1': 0.4 }, { a: 0, b: 0.4, c: 0.6 }, { '0': 0, '1': 0.4, '2': 0.7 }]) {
      refusedAnswer(mutated((b) => void (b.answers.mid.probabilities = probabilities)));
    }
    refusedAnswer(mutated((b) => void (b.answers.mid.confidence = 2)));
    assert.doesNotThrow(() => validateJevResponse(asked.questions, mutated((b) => void (b.answers.mid.score = 0))));
    assert.doesNotThrow(() => validateJevResponse(asked.questions, mutated((b) => void (b.answers.mid.score = 2))));
  });

  it('never names what the service sent', () => {
    const error = refusedAnswer(mutated((b) => void (b.answers.zeta.noul = MARKERS.state)));
    assert.ok(!error.message.includes(MARKERS.state));
    const bad = refusedAnswer(mutated((b) => void (b.answers[MARKERS.option] = { type: 'noul', noul: 0.5 })));
    assert.ok(!bad.message.includes(MARKERS.option));
  });
});

describe('the names of object members are names like any other', () => {
  const names = ['constructor', 'toString', 'hasOwnProperty', 'valueOf', 'prototype'];
  const request: JevRequest = {
    state: 'a state',
    questions: Object.fromEntries(
      names.map((name) => [name, { type: 'choice', instructions: 'Which?', criteria: Object.fromEntries(names.map((option) => [option, `about ${option}`])) } as const]),
    ),
  };

  it('are taken as question ids and as option names, in the order written', () => {
    const checked = validateJevRequest(request);
    assert.deepEqual(Object.keys(checked.questions), names);
    assert.deepEqual(Object.keys((own(checked.questions, 'constructor') as Extract<JevQuestion, { type: 'choice' }>).criteria), names);
    assert.deepEqual(Object.keys(JSON.parse(checked.body).questions), names);
  });

  it('are answered as any others, and only as own members', () => {
    const asked = validateJevRequest(request);
    const body = answerBody({ url: '', headers: {}, body: asked.body, timeoutMs: 1 });
    const checked = validateJevResponse(asked.questions, body);
    assert.deepEqual(Object.keys(checked.answers), names);
    assert.equal((own(checked.answers, 'constructor') as { choice: string }).choice, 'constructor');
    const missing = structuredClone(body);
    assert.ok(Reflect.deleteProperty(missing.answers, 'toString'));
    assert.throws(() => validateJevResponse(asked.questions, missing), JevCallError);
    const inherited = structuredClone(body) as Record<string, any>;
    assert.ok(Reflect.deleteProperty(inherited.answers.valueOf.probabilities, 'toString'));
    assert.throws(() => validateJevResponse(asked.questions, inherited), JevCallError);
  });

  it('are refused only where a name would change the object that holds it', () => {
    refused(withQuestion(noul(), '__proto__'));
    refused(withQuestion(choice(JSON.parse('{"__proto__":"x","b":"y"}'))));
  });
});

describe('JSON that repeats a name is refused, not collapsed', () => {
  it('parses plain JSON', () => {
    assert.deepEqual(parseJevJson('{"a":[1,{"b":"c"}],"d":null}'), { ok: true, value: { a: [1, { b: 'c' }], d: null } });
  });

  it('refuses text that is not JSON', () => {
    for (const text of ['', '{', 'nope', '{"a":1,}', "{'a':1}"]) assert.deepEqual(parseJevJson(text), { ok: false, problem: 'syntax' });
  });

  it('refuses an object that names a member twice, at any depth and also when the name is escaped', () => {
    for (const text of ['{"a":1,"a":2}', '{"x":{"a":1,"b":2,"a":3}}', '[{"a":1},{"b":1,"b":2}]', '{"a":1,"\\u0061":2}', '{"q":{"type":"noul","noul":0.5},"q":{"type":"noul","noul":0.6}}']) {
      assert.deepEqual(parseJevJson(text), { ok: false, problem: 'duplicate_key' }, text);
    }
  });

  it('takes the same name in different objects and strings that look like keys', () => {
    for (const text of ['{"a":{"a":1},"b":{"a":2}}', '[{"a":1},{"a":2}]', '{"a":"a","b":"a"}', '{"a":["a","a"]}', '{"a":"x\\",\\"a\\":1"}', '{"a b":1,"a":2}']) {
      assert.equal(parseJevJson(text).ok, true, text);
    }
  });
});
