import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import type { CliContext } from './api.ts';
import { adminCommands } from './cli-admin.ts';
import { UsageError } from './errors.ts';

test('knowledge retract rejects a missing reason, a broken reason and no target before opening records', async () => {
  const command = adminCommands().find(item => item.name === 'knowledge');
  assert.ok(command);
  let opened = false;
  const ctx: CliContext = {
    io: { stdout() {}, stderr() {}, env: {}, cwd: tmpdir() },
    config() { opened = true; throw new Error('config'); },
    async records() { opened = true; throw new Error('records'); },
    async deps() { opened = true; throw new Error('deps'); },
    async actingAdmin() { opened = true; throw new Error('admin'); },
  };
  const entry = 'a'.repeat(64);
  const cases = [
    ['retract', '--entry', entry],
    ['retract', '--entry', entry, '--reason', '第一行\n第二行'],
    ['retract', '--reason', '合成撤回'],
    ['retract', '--object', '不是摘要', '--reason', '合成撤回'],
  ];
  for (const args of cases) {
    opened = false;
    await assert.rejects(() => command.run(args, ctx), (error: unknown) => error instanceof UsageError);
    assert.equal(opened, false, args.join(' '));
  }
});
