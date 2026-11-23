import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packWarrant, staleWarrant, versionOrder, versionsApart } from './warrant-version.ts';

test('a pack function identity is taken apart; every other identity is not one', () => {
  assert.deepEqual(packWarrant('synthetic-flow.sheet_verified@3.26.8'), { pack: 'synthetic-flow', check: 'sheet_verified', version: '3.26.8' });
  assert.deepEqual(packWarrant('synthetic-flow.group.check-1@10.0.12'), { pack: 'synthetic-flow', check: 'group.check-1', version: '10.0.12' });
  const others: unknown[] = ['synthetic.verify@1', 'dispatch@1', 'knowledge.contribution@1', 'synthetic-flow.sheet_verified', 'synthetic-flow.@1.2.3', '.check@1.2.3', 'Synthetic.check@1.2.3',
    'synthetic-flow.sheet verified@1.2.3', 'synthetic-flow.check@1.2', 'synthetic-flow.check@1.2.3-rc1', 'synthetic-flow.a@b@1.2.3', `运行内检查@${'a'.repeat(64)}`, '', null, undefined, 7, `synthetic-flow.${'x'.repeat(300)}@1.2.3`];
  for (const other of others) assert.equal(packWarrant(other), null, String(other));
});

test('two identities are versions apart only as one function of one pack', () => {
  const pair = versionsApart('synthetic-flow.sheet_verified@3.20.4', 'synthetic-flow.sheet_verified@3.26.8');
  assert.equal(pair?.expected.version, '3.20.4');
  assert.equal(pair?.actual.version, '3.26.8');
  assert.equal(versionsApart('synthetic-flow.sheet_verified@3.26.8', 'synthetic-flow.sheet_verified@3.26.8'), null);
  assert.equal(versionsApart('synthetic-flow.sheet_verified@3.26.8', 'synthetic-flow.other_check@3.26.7'), null);
  assert.equal(versionsApart('synthetic-flow.sheet_verified@3.26.8', 'other-flow.sheet_verified@3.26.7'), null);
  assert.equal(versionsApart('synthetic-flow.sheet_verified@3.26.8', 'private-source-marker@1'), null);
  assert.equal(versionsApart(null, 'synthetic-flow.sheet_verified@3.26.8'), null);
});

test('versions are ordered by their numbers, not as text', () => {
  assert.ok(versionOrder('3.26.8', '3.20.4') > 0);
  assert.ok(versionOrder('3.9.0', '3.10.0') < 0);
  assert.ok(versionOrder('10.0.0', '9.99.99') > 0);
  assert.equal(versionOrder('1.2.3', '1.2.3'), 0);
});

test('an executor is behind only against a version of its own pack that is in use', () => {
  assert.deepEqual(staleWarrant('synthetic-flow.sheet_verified@3.20.4', 'synthetic-flow', '3.26.8'), { named: 'synthetic-flow.sheet_verified@3.20.4', wanted: 'synthetic-flow.sheet_verified@3.26.8' });
  assert.deepEqual(staleWarrant('synthetic-flow.sheet_verified@3.27.0', 'synthetic-flow', '3.26.8'), { named: 'synthetic-flow.sheet_verified@3.27.0', wanted: 'synthetic-flow.sheet_verified@3.26.8' }, 'ahead of the version in use is as unusable as behind it');
  assert.equal(staleWarrant('synthetic-flow.sheet_verified@3.26.8', 'synthetic-flow', '3.26.8'), null);
  assert.equal(staleWarrant('synthetic-flow.sheet_verified@3.20.4', 'synthetic-flow', null), null, 'no version in use: nothing to compare');
  assert.equal(staleWarrant('synthetic-flow.sheet_verified@3.20.4', 'other-flow', '3.26.8'), null, 'a function of another pack');
  assert.equal(staleWarrant('synthetic.verify@1', 'synthetic-workflow', '1.0.0'), null, 'not a pack function identity');
  assert.equal(staleWarrant('synthetic-flow.sheet_verified@3.20.4', 'synthetic-flow', 'not-a-version'), null);
});
