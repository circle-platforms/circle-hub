import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { KNOWLEDGE_USAGE } from './cli-admin.ts';
import { main, RESERVED_COMMANDS } from './cli.ts';

test('reserved command help carries command descriptions rather than home-axis meanings', async () => {
  const out: string[] = [];
  const code = await main(['help'], { assembly: async () => ({ assemble: () => { throw new Error('synthetic unused assembly'); } }), io: { stdout: line => out.push(line), stderr: line => out.push(line), env: {}, cwd: tmpdir() } });
  assert.equal(code, 0);
  assert.deepEqual(RESERVED_COMMANDS, ['pack', 'resource', 'secret', 'knowledge', 'init-admin', 'operator-token']);
  const help = out.join('\n');
  assert.match(help, /resource\s+管理资源声明；由装配模块注册/);
  assert.match(help, /knowledge\s+读取和管理知识树；由装配模块注册/);
  assert.match(KNOWLEDGE_USAGE, /retract \(--entry <记录摘要> \| --run <运行> \| --object <对象摘要>\)… --reason <一行原因>/);
});


test('command bridge derives allowed commands from registration and refuses platform commands before execution', async () => {
  const { COMMAND_METADATA } = await import('./command-registry.ts');
  const { createCommandBridge } = await import('./command-bridge.ts');
  let executions = 0;
  const bridge = createCommandBridge({ env: {}, cwd: tmpdir(), main: async () => { executions++; return 0; } });
  assert.equal(new Set(COMMAND_METADATA.map(command => command.name)).size, COMMAND_METADATA.length);
  for (const command of COMMAND_METADATA) {
    const result = await bridge.run([command.name], { token: 'synthetic' });
    assert.equal(result.code, command.bridge ? 0 : 2, command.name);
  }
  assert.equal(executions, COMMAND_METADATA.filter(command => command.bridge).length);
});


test('subcommand tables reject unknown and inherited names without opening records', async () => {
  const { userCommand, tokenCommand } = await import('./cli.ts');
  const { UsageError } = await import('./errors.ts');
  const context = { io: {}, records: async () => { throw new Error('must not open records'); } } as unknown as import('./api.ts').CliContext;
  const options = {} as import('./cli.ts').CliOptions;
  for (const command of [userCommand, tokenCommand]) {
    for (const name of ['unknown', 'constructor', 'toString', '__proto__']) await assert.rejects(command([name], context, options), UsageError);
  }
});
