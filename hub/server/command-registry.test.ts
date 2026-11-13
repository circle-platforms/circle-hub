import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandStep, installCommandSteps, STEP_NAMES } from '../records/api.ts';
import { ADMIN_COMMANDS, BRIDGED_COMMANDS, COMMAND_METADATA } from './command-registry.ts';

test('the CLI catalog supplies command trace steps including team and platform commands', () => {
  installCommandSteps(COMMAND_METADATA);
  assert.equal(commandStep('team'), 'run-team');
  assert.equal(commandStep('pack'), 'run-pack');
  assert.equal(commandStep('status'), 'run-status');
  assert.ok(STEP_NAMES.includes('run-team'));
  assert.equal(commandStep('synthetic-unregistered'), 'run-command');
});

test('team management is registered with a handler and bridge eligibility while deployment stays outside the bridge', () => {
  const team = ADMIN_COMMANDS.find(command => command.name === 'team');
  assert.ok(team);
  assert.equal(typeof team.handler, 'function');
  assert.ok(BRIDGED_COMMANDS.has('team'));
  for (const name of ['backup', 'restore', 'deploy', 'rollback']) assert.equal(BRIDGED_COMMANDS.has(name), false, name);
});
