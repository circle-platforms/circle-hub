import assert from 'node:assert/strict';
import {test} from 'node:test';
import {initAdminCommand} from './cli-admin.ts';
import type {Session} from './cli-session.ts';

test('explicit empty password stdin refuses before any database or credential access', async () => {
  let accesses = 0;
  const output: string[] = [];
  const forbidden = async () => { accesses++; throw new Error('synthetic credential state must remain untouched'); };
  const session = {
    options: {readSecret: async () => ''},
    records: forbidden,
    tokens: forbidden,
    out: (line: string) => output.push(line),
  } as unknown as Session;
  await assert.rejects(initAdminCommand(session, ['--password-stdin']), /未收到管理员密码/);
  assert.equal(accesses, 0);
  assert.deepEqual(output, []);
});
