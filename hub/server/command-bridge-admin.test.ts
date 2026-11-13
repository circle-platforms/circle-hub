import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCommandArgv, commandParameterShape } from './command-parameters.ts';
import { createCommandBridge } from './command-bridge.ts';
import { UsageError } from './errors.ts';
import { commandStep } from '../telemetry/api.ts';
import { COMMAND_METADATA } from './command-registry.ts';

const reference = 'src:' + 'a'.repeat(64);
test('executor and document upload forms retain exclusive source modes and reach the existing CLI bridge', async () => {
  const argvSeen: string[][] = [];
  const bridge = createCommandBridge({ env: {}, cwd: '/synthetic/commands', main: async (argv, options) => {
    argvSeen.push([...argv]);
    assert.equal((options.io as { env: NodeJS.ProcessEnv }).env.CIRCLE_HUB_TOKEN, 'synthetic-token');
    return 0;
  } });
  for (const [id, values, expected] of [
    ['executor.add', { reference }, ['executor', 'add', '--reference=' + reference]],
    ['executor.update', { executor: 'synthetic-executor', reference }, ['executor', 'update', 'synthetic-executor', '--reference=' + reference]],
    ['doc.put', { name: 'synthetic-topology', reference }, ['doc', 'put', 'synthetic-topology', '--reference=' + reference]],
  ] as const) {
    const argv = buildCommandArgv(id, values);
    assert.deepEqual(argv, expected);
    assert.equal((await bridge.run(argv, { token: 'synthetic-token' })).code, 0);
    assert.throws(() => buildCommandArgv(id, { ...values, file: 'local.json' }), UsageError);
    assert.throws(() => buildCommandArgv(id, { ...values, reference: 'rec:' + 'a'.repeat(64) }), UsageError);
  }
  assert.equal(argvSeen.length, 3);
  assert.deepEqual(buildCommandArgv('executor.add', { file: 'local.json' }), ['executor', 'add', 'local.json']);
  assert.deepEqual(buildCommandArgv('doc.put', { name: 'synthetic-topology', file: 'local.json' }), ['doc', 'put', 'synthetic-topology', 'local.json']);
});

test('installed skill forms call existing pack handlers without new audience or secret options', async () => {
  const bridge = createCommandBridge({ env: {}, cwd: '/synthetic/commands', main: async () => 0 });
  for (const [id, pack] of [['pack.install', 'synthetic-skill@1.0.0'], ['pack.uninstall', 'synthetic-skill']] as const) {
    const argv = buildCommandArgv(id, { pack });
    assert.equal((await bridge.run(argv, { token: 'synthetic-token' })).code, 0);
    assert.equal(commandParameterShape(id).fields.length, 1);
    assert.throws(() => buildCommandArgv(id, { pack, team: 'synthetic-team' }), UsageError);
  }
});

test('web command bridge requires upload references while local CLI paths remain a separate capability', async () => {
  let calls = 0;
  const bridge = createCommandBridge({ env: {}, cwd: '/synthetic/commands', main: async () => { calls++; return 0; } });
  for (const argv of [['executor', 'add', '/synthetic/private.json'], ['executor', 'update', 'synthetic-executor', '/synthetic/private.json'], ['doc', 'put', 'synthetic-topology', '/synthetic/private.json'], ['executor', 'add', '/synthetic/private.json', '--reference=' + reference]]) {
    assert.equal((await bridge.run(argv, { token: 'synthetic-token' })).code, 2);
  }
  assert.equal(calls, 0);
});

test('new administrator subcommands retain their registered command telemetry steps', () => {
  for (const name of ['executor', 'doc', 'pack']) {
    const command = COMMAND_METADATA.find(entry => entry.name === name);
    assert.equal(command?.step, commandStep(name));
    assert.equal(command?.bridge, true);
  }
});
