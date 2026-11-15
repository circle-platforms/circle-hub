import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ScopedDispatchFactsSchema } from '../../../contracts/api.ts';
import { uiLabelOf } from '../../../contracts/generated/vocabulary.ts';
import { environmentJobText } from './connections.ts';

const job = 'a'.repeat(64);

test('an environment outcome caption identifies the round instead of claiming the whole job was unsent', () => {
  const facts = ScopedDispatchFactsSchema.parse({
    job_facts: { scope: { job }, operation: 'dispatch', reservation_recorded: true },
    dispatch_attempt: { scope: { operation: 'dispatch', job, round: 2 }, outcome: 'not_dispatched', not_sent: true },
  });
  assert.equal(environmentJobText(facts), `第2轮正式派发：${uiLabelOf('effect_outcome', 'not_dispatched')}`);
  assert.equal(environmentJobText(facts).includes(job), false);
});

test('an absent attempt is displayed as missing scoped evidence rather than as a no-send outcome', () => {
  const facts = ScopedDispatchFactsSchema.parse({ job_facts: { scope: { job } } });
  assert.equal(environmentJobText(facts), '尚无按范围可核对的派发结局');
});

test('a readonly precheck does not acquire a fabricated dispatch round or physical result', () => {
  for (const readonly_verified of [true, false]) {
    const facts = ScopedDispatchFactsSchema.parse({ job_facts: { scope: { job }, operation: 'precheck', readonly_verified } });
    const text = environmentJobText(facts);
    assert.equal(text, readonly_verified ? '只读预检：已取得全部条件通过的核对' : '只读预检：尚未取得全部条件通过的核对');
    assert.equal(text.includes('轮'), false);
    assert.equal(text.includes('错误'), false);
    assert.equal(text.includes('已生效'), false);
  }
});
