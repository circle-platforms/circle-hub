import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { KNOWLEDGE_USAGE } from './cli-admin.ts';
import { main, RESERVED_COMMANDS } from './cli.ts';

test('reserved command help carries command descriptions rather than home-axis meanings', async () => {
  const out: string[] = [];
  const code = await main(['help'], { assembly: async () => ({ assemble: () => { throw new Error('synthetic unused assembly'); } }), io: { stdout: line => out.push(line), stderr: line => out.push(line), env: {}, cwd: tmpdir() } });
  assert.equal(code, 0);
  assert.deepEqual(RESERVED_COMMANDS, ['pack', 'skill', 'resource', 'secret', 'knowledge', 'init-admin', 'operator-token']);
  const help = out.join('\n');
  assert.match(help, /resource\s+管理资源声明；由装配模块注册/);
  assert.match(help, /knowledge\s+读取和管理知识树；由装配模块注册/);
  assert.match(KNOWLEDGE_USAGE, /retract \(--entry <记录摘要> \| --run <运行> \| --object <对象摘要>\)… --reason <一行原因>/);
});
