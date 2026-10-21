// The body and query shape check: positive and negative cases per keyword, and adversarial input (huge strings and arrays,
// deep nesting, prototype keys, non-plain objects, numbers that are not finite) answered quickly and never accepted.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Shape } from '../../contracts/src/resources.ts';
import { shapeProblem } from './shape.ts';

const ids: Shape = {
  type: 'object',
  properties: { bug_ids: { type: 'array', items: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string', maxLength: 12, pattern: '^[0-9]{1,12}$' }] }, minItems: 1, maxItems: 100 } },
  required: ['bug_ids'],
  additionalProperties: false,
};

test('objects are closed, required members present', () => {
  assert.equal(shapeProblem(ids, { bug_ids: [1, '22'] }), null);
  assert.match(shapeProblem(ids, { bug_ids: [1], status: 'closed' }) ?? '', /\/status: not an allowed member/);
  assert.match(shapeProblem(ids, {}) ?? '', /\/bug_ids: required/);
  assert.match(shapeProblem(ids, []) ?? '', /not an object/);
  assert.match(shapeProblem(ids, null) ?? '', /not an object/);
  assert.match(shapeProblem(ids, new Date()) ?? '', /not an object/);
  assert.match(shapeProblem(ids, JSON.parse('{"bug_ids":[1],"__proto__":{"x":1}}')) ?? '', /__proto__: not an allowed member/);
});

test('arrays, strings, numbers, enums, const, anyOf', () => {
  assert.match(shapeProblem(ids, { bug_ids: [] }) ?? '', /fewer than 1/);
  assert.match(shapeProblem(ids, { bug_ids: Array.from({ length: 101 }, (_, i) => i + 1) }) ?? '', /more than 100/);
  assert.match(shapeProblem(ids, { bug_ids: [0] }) ?? '', /\/bug_ids\/0: fits none/);
  assert.match(shapeProblem(ids, { bug_ids: ['12a'] }) ?? '', /fits none/);
  assert.match(shapeProblem(ids, { bug_ids: [1.5] }) ?? '', /fits none/);
  const s: Shape = { type: 'string', minLength: 2, maxLength: 4, enum: ['ab', 'abc', 'abcde'] };
  assert.equal(shapeProblem(s, 'ab'), null);
  assert.match(shapeProblem(s, 'a') ?? '', /shorter/);
  assert.match(shapeProblem(s, 'abcde') ?? '', /longer/);
  assert.match(shapeProblem(s, 'abd') ?? '', /allowed values/);
  assert.equal(shapeProblem({ type: 'string', maxLength: 2 }, '中文'), null, 'lengths count code points');
  assert.equal(shapeProblem({ type: 'string', maxLength: 1 }, '😀'), null, 'an astral character is one code point');
  assert.match(shapeProblem({ type: 'string', maxLength: 3, const: 'abc' }, 'abd') ?? '', /required value/);
  assert.match(shapeProblem({ type: 'integer', maximum: 3 }, 4) ?? '', /above 3/);
  assert.match(shapeProblem({ type: 'integer' }, 2 ** 60) ?? '', /not an integer/);
  assert.match(shapeProblem({ type: 'number' }, Number.NaN) ?? '', /not a number/);
  assert.match(shapeProblem({ type: 'number' }, Number.POSITIVE_INFINITY) ?? '', /not a number/);
  assert.equal(shapeProblem({ type: 'boolean' }, false), null);
  assert.match(shapeProblem({ type: 'boolean' }, 'false') ?? '', /not a boolean/);
  assert.equal(shapeProblem({ type: 'null' }, null), null);
  assert.match(shapeProblem({ type: 'null' }, undefined) ?? '', /not null/);
});

test('adversarial input is refused quickly', () => {
  const started = Date.now();
  const s: Shape = { type: 'string', maxLength: 64, pattern: '^[a]+$' };
  assert.match(shapeProblem(s, 'a'.repeat(10_000_000)) ?? '', /longer than 64/);
  assert.match(shapeProblem(s, `${'a'.repeat(63)}!`) ?? '', /does not match/);
  const list: Shape = { type: 'array', items: { type: 'integer' }, maxItems: 10 };
  assert.match(shapeProblem(list, new Array(5_000_000).fill(1)) ?? '', /more than 10/);
  let deep: unknown = 1;
  for (let i = 0; i < 10_000; i++) deep = { a: deep };
  const nested: Shape = { type: 'object', properties: { a: { type: 'integer' } }, additionalProperties: false };
  assert.match(shapeProblem(nested, deep) ?? '', /not an integer/);
  assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started} ms`);
});

test('a shape deeper than the limit is never accepted', () => {
  let shape: Shape = { type: 'null' };
  let value: unknown = null;
  for (let i = 0; i < 40; i++) {
    shape = { type: 'array', items: shape, maxItems: 1 };
    value = [value];
  }
  assert.match(shapeProblem(shape, value) ?? '', /nested deeper/);
});
