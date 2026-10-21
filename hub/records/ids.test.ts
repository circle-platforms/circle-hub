import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunId, TokenId, UserId } from '../../contracts/src/common.ts';
import { ID_PATTERN, idTime, isId, newId, ulid } from './ids.ts';

test('ids are prefix_ULID in lowercase Crockford base-32 and match the contract patterns', () => {
  const now = Date.UTC(2026, 9, 21, 8, 0, 0, 123);
  for (const [prefix, schema] of [['usr', UserId], ['tok', TokenId], ['run', RunId]] as const) {
    const id = newId(prefix, now);
    assert.match(id, ID_PATTERN);
    assert.equal(schema.safeParse(id).success, true, id);
    assert.equal(idTime(id), now);
    assert.equal(isId(prefix, id), true);
    assert.doesNotMatch(id.slice(prefix.length + 1), /[ilou]/);
  }
  assert.throws(() => newId('Run'), TypeError);
  assert.throws(() => newId('r'), TypeError);
  assert.throws(() => newId('run_x'), TypeError);
  assert.throws(() => ulid(-1), RangeError);
  assert.throws(() => ulid(2 ** 48), RangeError);
});

test('ids are monotonic within a process, also within one millisecond and after a clock step back', () => {
  const now = Date.now() + 10_000;
  const ids = [newId('rcd', now)];
  for (let index = 0; index < 2000; index++) ids.push(newId('rcd', now));
  ids.push(newId('rcd', now - 5000));
  ids.push(newId('rcd', now + 1));
  for (let index = 1; index < ids.length; index++) assert.ok(ids[index - 1] < ids[index], `${ids[index - 1]} < ${ids[index]}`);
  assert.equal(new Set(ids).size, ids.length);
  // The clock step back keeps the last time rather than going backwards.
  assert.equal(idTime(ids[ids.length - 2]), now);
});
