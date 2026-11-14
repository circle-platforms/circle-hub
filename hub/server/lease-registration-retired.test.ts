import test from 'node:test';
import assert from 'node:assert/strict';
import { leaseCommand, LEASE_USAGE } from './cli-admin.ts';
import type { Session } from './cli-session.ts';

// Registration belongs to the one environment form; removed commands must not create a second directory.
test('standalone lease registration commands have no command or storage side effects', async () => {
  for (const action of ['register', 'unregister']) {
    const session = new Proxy({}, { get() { throw new Error('removed commands must not access an identity or store'); } }) as Session;
    await assert.rejects(leaseCommand(session, [action, 'synthetic/prefix/', '--reason', '合成测试']), error =>
      error instanceof Error && error.name === 'UsageError' && error.message.includes('lease 的子命令'));
  }
  assert.doesNotMatch(LEASE_USAGE, /register|unregister/);
  assert.match(LEASE_USAGE, /lease list/);
  assert.match(LEASE_USAGE, /release/);
});
