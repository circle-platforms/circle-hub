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

test('Codex import: AGENTS.md and AGENTS.override.md become hub-instruction/1', () => {
  const instructions = imported.manifests.filter((manifest) => manifest.kind === 'hub-instruction/1') as HubInstruction[];
  assert.equal(instructions.length, 2);
  assert.deepEqual(
    instructions.map((instruction) => instruction.fileName).sort(),
    ['AGENTS.md', 'AGENTS.override.md'],
  );
  for (const instruction of instructions) {
    assert.equal(instruction.scope, undefined);
    assert.deepEqual(instruction.applies, []);
    assert.equal(instruction.sourceHarness, 'codex');
  }
});

test('Codex import: .agents skills and .codex/hooks.json become hub-skill/1 and hub-hook/1', () => {
  const skills = imported.manifests.filter((manifest) => manifest.kind === 'hub-skill/1');
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, 'tidy');
  // Space-separated allowed-tools lands in harnessSpecific, not tools.
  assert.deepEqual(skills[0].tools, []);
  assert.deepEqual((skills[0].harnessSpecific as { allowedTools?: string[] }).allowedTools, ['Read', 'Write']);

  const hooks = imported.manifests.filter((manifest) => manifest.kind === 'hub-hook/1');
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].event, 'PreToolUse');
  assert.equal(hooks[0].handler, 'sh scripts/codex-check.sh');
  assert.equal(hooks[0].order, undefined);
  assert.equal(hooks[0].deterministic, undefined);
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
    imported.warnings.map((warning) => warning.code).sort(),
    ['HOOK_EVENT_UNMAPPED', 'PROVIDER_VALUES_STRIPPED'],
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
  const agent = {
    kind: 'hub-agent/1',
    name: 'test-reviewer',
    description: '',
    tools: [],
    sourceHarness: 'codex',
    knownCompatible: [],
    files: [],
    harnessSpecific: {},
  } satisfies HubManifest;
  const result = exportTo('codex', [agent], {});
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

test('Codex import: empty config.toml is reported, not silently ignored', () => {
  for (const text of ['', '# only a comment\n', 'model = "scripted-model"\n']) {
    const result = importFrom('codex', { '.codex/config.toml': text });
    assert.deepEqual(result.manifests, []);
    const codes = result.warnings.map((warning) => warning.code);
    assert.ok(codes.includes('EMPTY_CONFIG'), `${JSON.stringify(text)} -> ${codes.join(',')}`);
  }
});

test('Codex import: TOML comments are reported by line and dropped on export', () => {
  const input = {
    '.codex/config.toml': [
      '# Synthetic servers',
      '[mcp_servers.a]',
      'command = "node" # local runner',
      '',
    ].join('\n'),
  };
  const result = importFrom('codex', input);
  const dropped = result.warnings.filter((warning) => warning.code === 'TOML_COMMENT_DROPPED');
  assert.equal(dropped.length, 1);
  assert.ok(dropped[0].detail.includes('1'));
  assert.ok(dropped[0].detail.includes('3'));
  assert.equal(dropped[0].detail.includes('Synthetic servers'), false);
  const exported = exportTo('codex', result.manifests, input);
  assert.equal((exported.files['.codex/config.toml'] as string).includes('#'), false);
});

test('Codex export: empty tables never produce a bare [mcp_servers] header', () => {
  const result = importFrom('codex', {
    '.codex/config.toml': '[mcp_servers.a]\ncommand = "node"\n\n[mcp_servers.a.env]\n',
  });
  const exported = exportTo('codex', result.manifests, {});
  const text = exported.files['.codex/config.toml'] as string;
  assert.ok(text.includes('[mcp_servers.a]'), text);
  assert.equal(text.includes('[mcp_servers.a.env]'), false, text);
  // And with zero providers at all, no file is written.
  assert.deepEqual(exportTo('codex', [], {}).files, {});
});
