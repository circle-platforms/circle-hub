// `circle-hub knowledge reproject <product> <line>` (fed-case-reprojection): usage errors are refused before anything is
// opened, and the usage text names the command.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import type { CliContext } from './api.ts';
import { KNOWLEDGE_USAGE, adminCommands } from './cli-admin.ts';
import { UsageError } from './errors.ts';

test('knowledge reproject takes exactly a product and a line, and refuses anything else before opening records', async () => {
  assert.match(KNOWLEDGE_USAGE, /reproject <产品> <版本线>/);
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
  for (const args of [['reproject'], ['reproject', 'FAMX'], ['reproject', 'FAMX', '10.8', 'extra'], ['reproject', 'FAMX', '10.8', '--dry-run'], ['reproject', '', '10.8']]) {
    opened = false;
    await assert.rejects(() => command.run(args, ctx), (error: unknown) => error instanceof UsageError, args.join(' '));
    assert.equal(opened, false, args.join(' '));
  }
});
