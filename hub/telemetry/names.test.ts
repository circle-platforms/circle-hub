// The name list is an interface: complete against the tools, the CLI commands and the sync routes it mirrors, and closed
// against whatever a client or a URL sends.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PERSONAL_SYNC_CAPABILITY_ROUTES, PERSONAL_SYNC_HTTP_ROUTES } from '../../contracts/src/sync.ts';
import { TOOLS } from '../../contracts/src/tools.ts';
import { PLATFORM_COMMANDS } from '../platform/api.ts';
import { adminCommands } from '../server/cli-admin.ts';
import { ACCOUNTED_USAGE, STEP_NAMES, USAGE_NAMES, commandStep, consoleStep, isUsageName, mcpStep, syncStep } from './names.ts';

test('step names are unique lowercase words with no room for a dynamic value', () => {
  assert.equal(new Set(STEP_NAMES).size, STEP_NAMES.length);
  for (const name of STEP_NAMES) assert.match(name, /^[a-z]+(?:[-_][a-z]+)*$/);
});

test('the usage names are the design table and nothing is written twice', () => {
  assert.deepEqual([...USAGE_NAMES], [
    'db.queries', 'db.rows', 'db.bytes', 'db.ms', 'db.wait_ms', 'sandbox.runs', 'sandbox.wait_ms', 'sandbox.ms',
    'source.reads', 'source.bytes', 'source.ms', 'answer.bytes', 'self.ms', 'steps.dropped',
  ]);
  assert.ok(ACCOUNTED_USAGE.every((name) => name.endsWith('ms')));
  assert.ok(!(ACCOUNTED_USAGE as readonly string[]).includes('self.ms'), 'self.ms is what they leave');
  assert.equal(isUsageName('db.rows'), true);
  assert.equal(isUsageName('db.nothing'), false);
});

test('every tool has its own root name; what a client writes never becomes a name', () => {
  for (const tool of TOOLS) assert.equal(mcpStep('tools/call', tool.name), tool.name);
  assert.equal(mcpStep('tools/call', 'some_tool_of_a_client'), 'handle-mcp');
  assert.equal(mcpStep('tools/call', 12), 'handle-mcp');
  assert.equal(mcpStep('initialize', undefined), 'initialize');
  assert.equal(mcpStep('tools/list', undefined), 'list-tools');
  assert.equal(mcpStep('ping', undefined), 'handle-mcp');
});

test('every command of the CLI has its own root name; an unknown one does not', () => {
  const commands = [...PLATFORM_COMMANDS, ...adminCommands().map((command) => command.name), 'user', 'token', 'logs', 'run', 'local-tools', 'setup-code'];
  for (const command of commands) assert.equal(commandStep(command), `run-${command}`, command);
  assert.equal(commandStep('no-such-command'), 'run-command');
  assert.equal(commandStep('check'), 'run-command', 'an inner step is not a command');
});

test('every sync route has its own root name', () => {
  for (const route of Object.keys({ ...PERSONAL_SYNC_HTTP_ROUTES, ...PERSONAL_SYNC_CAPABILITY_ROUTES })) assert.notEqual(syncStep(route), 'serve-sync', route);
  assert.equal(syncStep('modeCheck'), 'sync-mode-check');
  assert.equal(syncStep('anything'), 'serve-sync');
});

test('a console path names its area, never its ids', () => {
  assert.equal(consoleStep('/console'), 'serve-console');
  assert.equal(consoleStep('/console/runs/run_123'), 'serve-runs');
  assert.equal(consoleStep('/console/api/runs'), 'serve-api');
  assert.equal(consoleStep('/console/health'), 'serve-health');
  assert.equal(consoleStep('/console/api/stream'), 'stream-console', 'a stream lasts hours: it must not rank with the requests');
  assert.equal(consoleStep('/console/run_123'), 'serve-console');
  assert.equal(consoleStep('/console/favicon.svg'), 'serve-console');
});
