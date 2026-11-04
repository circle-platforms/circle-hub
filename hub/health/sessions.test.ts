// Open MCP sessions: a stateless endpoint, so open means initialized and not silent for too long.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionTracker } from './sessions.ts';

const clock = () => {
  const state = { at: 0 };
  return { state, now: () => new Date(state.at) };
};

test('sessions count by declared client name until the client ends them', () => {
  const { now } = clock();
  const sessions = createSessionTracker({ now });
  sessions.opened('s1', 'client-a');
  sessions.opened('s2', 'client-a');
  sessions.opened('s3', 'client-b');
  sessions.opened('s4', null);
  assert.deepEqual(sessions.counts(), { total: 4, byClient: { 'client-a': 2, 'client-b': 1 } }, 'a session that declared no name counts in the total only');
  sessions.closed('s1');
  sessions.closed('unknown');
  sessions.closed(null);
  assert.deepEqual(sessions.counts(), { total: 3, byClient: { 'client-a': 1, 'client-b': 1 } });
});

test('a silent session stops counting, a request keeps it open, and one this process never saw open has no name', () => {
  const { state, now } = clock();
  const sessions = createSessionTracker({ now, idleMs: 1000 });
  sessions.opened('kept', 'client-a');
  sessions.opened('silent', 'client-b');
  state.at = 900;
  sessions.seen('kept');
  sessions.seen('from-before-a-restart');
  sessions.seen(null);
  state.at = 1500;
  assert.deepEqual(sessions.counts(), { total: 2, byClient: { 'client-a': 1 } }, 'silent for longer than the limit');
  state.at = 2000;
  assert.deepEqual(sessions.counts(), { total: 0, byClient: {} });
});

test('sessions and names stay bounded whatever clients declare', () => {
  const { now } = clock();
  const sessions = createSessionTracker({ now, maxSessions: 50 });
  for (let index = 0; index < 200; index += 1) sessions.opened(`s${index}`, `client-${index}`);
  const { total, byClient } = sessions.counts();
  assert.equal(total, 50);
  assert.equal(Object.keys(byClient).length, 20);
});
