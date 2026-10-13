import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  exportTo,
  importFrom,
  type HubInstruction,
  type HubManifest,
  type HubProvider,
} from '../../packages/harness-adapters/index.ts';
import { codexFixtureRoot, loadVirtualFiles } from '../fixtures/harness/load.ts';

const fixture = await loadVirtualFiles(codexFixtureRoot);
const imported = importFrom('codex', fixture);

test('Codex import: AGENTS.md becomes hub-instruction/1', () => {
  const instructions = imported.manifests.filter((manifest) => manifest.kind === 'hub-instruction/1') as HubInstruction[];
  assert.equal(instructions.length, 1);
  assert.equal(instructions[0].scope, undefined);
  assert.deepEqual(instructions[0].applies, []);
  assert.equal(instructions[0].fileName, 'AGENTS.md');
  assert.equal(instructions[0].sourceHarness, 'codex');
  assert.deepEqual(
    instructions[0].files.map((file) => file.path),
    ['AGENTS.md'],
  );
});

test('Codex import: mcp_servers become hub-provider/1 without secret values', () => {
  const providers = imported.manifests.filter((manifest) => manifest.kind === 'hub-provider/1') as HubProvider[];
  assert.equal(providers.length, 2);

  const docs = providers.find((provider) => provider.name === 'docs_lookup')!;
  assert.equal(docs.transport, 'stdio');
  assert.deepEqual(docs.credentials, ['DOCS_API_KEY']);
  // Not derivable from a static config file: provides, credentialMode.
  assert.equal(docs.provides, undefined);
  assert.equal(docs.credentialMode, undefined);
  const shape = docs.harnessSpecific.shape as Record<string, unknown>;
  assert.equal(shape.command, 'npx');
  assert.deepEqual(shape.args, ['-y', '@example/docs-mcp']);
  assert.deepEqual(shape.env, { DOCS_API_KEY: '' });
  assert.deepEqual(
    docs.files.map((file) => file.path),
    ['.codex/config.toml'],
  );

  const pings = providers.find((provider) => provider.name === 'pings')!;
  assert.equal(pings.transport, 'stdio');
  assert.deepEqual(pings.credentials, []);
  assert.equal(pings.credentialMode, undefined);

  assert.equal(JSON.stringify(imported.manifests).includes('synthetic-docs-key'), false);
  assert.deepEqual(
    imported.warnings.map((warning) => warning.code),
    ['PROVIDER_VALUES_STRIPPED'],
  );
});

test('Codex import: TOML subset boundaries skip unsupported lines instead of guessing', () => {
  // The supported subset is documented in packages/harness-adapters/toml.ts:
  // no inline tables, no multiline strings, no arrays of tables, no dates.
  const result = importFrom('codex', {
    '.codex/config.toml': [
      '[mcp_servers.a]',
      'command = "npx"',
      'options = { mode = "fast" }',
      'banner = """multiline"""',
      'args = ["-y"]',
      '',
    ].join('\n'),
  });
  assert.equal(result.manifests.length, 1);
  const [provider] = result.manifests as HubProvider[];
  const shape = provider.harnessSpecific.shape as Record<string, unknown>;
  assert.deepEqual(Object.keys(shape).sort(), ['args', 'command']);
  assert.deepEqual(
    result.warnings.map((warning) => warning.code).sort(),
    ['TOML_LINE_SKIPPED', 'TOML_LINE_SKIPPED'],
  );
  assert.ok(result.warnings.every((warning) => warning.detail.includes('line')));
});

test('Codex import: keys outside mcp_servers are reported and dropped on export', () => {
  const input = { '.codex/config.toml': 'model = "scripted-model"\n\n[mcp_servers.a]\ncommand = "node"\n' };
  const result = importFrom('codex', input);
  assert.equal(result.manifests.length, 1);
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ['CONFIG_EXTRA_KEYS'],
  );
  assert.ok(result.warnings[0].detail.includes('model'));
  const exported = exportTo('codex', result.manifests, input);
  assert.equal((exported.files['.codex/config.toml'] as string).includes('model = '), false);
});

test('Codex import: unrecognized files are reported', () => {
  const result = importFrom('codex', { 'notes.txt': 'synthetic\n' });
  assert.deepEqual(result.manifests, []);
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ['UNRECOGNIZED_FILE'],
  );
});

test('Codex export: primitives without a Codex projection are reported, not silently dropped', () => {
  const skill = {
    kind: 'hub-skill/1',
    name: 'review-code',
    description: '',
    entry: 'SKILL.md',
    tools: [],
    inputs: [],
    outputs: [],
    triggers: [],
    sourceHarness: 'codex',
    knownCompatible: [],
    files: [],
    harnessSpecific: {},
  } satisfies HubManifest;
  const result = exportTo('codex', [skill], {});
  assert.deepEqual(result.files, {});
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ['NO_HARNESS_PROJECTION'],
  );
});

test('Sanitization: TOML skip warnings carry line numbers, not content', () => {
  const result = importFrom('codex', {
    '.codex/config.toml': '[mcp_servers.a]\ncommand = "node"\ntoken = { secret = "super-secret-value" }\n',
  });
  const [warning] = result.warnings.filter((entry) => entry.code === 'TOML_LINE_SKIPPED');
  assert.ok(warning.detail.includes('line 3'), warning.detail);
  assert.equal(warning.detail.includes('super-secret-value'), false);
  assert.equal(warning.detail.includes('secret'), false);
});

test('Sanitization: cwd is dropped and oauth values stripped in codex config', () => {
  const result = importFrom('codex', {
    '.codex/config.toml': [
      '[mcp_servers.a]',
      'command = "node"',
      'cwd = "/srv/app"',
      '',
      '[mcp_servers.a.oauth]',
      'client_id = "synthetic-client"',
      '',
    ].join('\n'),
  });
  const [provider] = result.manifests as HubProvider[];
  const shape = provider.harnessSpecific.shape as Record<string, unknown>;
  assert.equal('cwd' in shape, false);
  assert.deepEqual(shape.oauth, { client_id: '' });
  assert.deepEqual(provider.credentials, []);
  assert.deepEqual(
    result.warnings.map((warning) => warning.code).sort(),
    ['PROVIDER_CWD_DROPPED', 'PROVIDER_VALUES_STRIPPED'],
  );
  assert.equal(JSON.stringify(result.manifests).includes('synthetic-client'), false);
});
