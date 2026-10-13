import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  exportTo,
  importFrom,
  type HubAgent,
  type HubCommand,
  type HubHook,
  type HubProvider,
  type HubSkill,
  type HubManifest,
} from '../../packages/harness-adapters/index.ts';
import { geminiFixtureRoot, loadVirtualFiles, manifestStrings } from '../fixtures/harness/load.ts';
import { parseToml } from '../../packages/harness-adapters/toml.ts';

const fixture = await loadVirtualFiles(geminiFixtureRoot);
const imported = importFrom('gemini', fixture);

function manifestsOfKind<K extends HubManifest['kind']>(kind: K): Extract<HubManifest, { kind: K }>[] {
  return imported.manifests.filter((manifest) => manifest.kind === kind) as Extract<HubManifest, { kind: K }>[];
}

test('Gemini import: fixture covers skill, command, agent, instruction, hook, providers', () => {
  assert.deepEqual(
    imported.manifests.map((manifest) => manifest.kind).sort(),
    ['hub-agent/1', 'hub-command/1', 'hub-hook/1', 'hub-instruction/1', 'hub-provider/1', 'hub-provider/1', 'hub-provider/1', 'hub-skill/1'].sort(),
  );
  const expected = new Set(['HOOK_EVENT_UNMAPPED', 'PROVIDER_VALUES_STRIPPED', 'PROVIDER_TRANSPORT_UNKNOWN']);
  const unexpected = imported.warnings.filter((warning) => !expected.has(warning.code));
  assert.deepEqual(unexpected, []);
});

test('Gemini import: skill, TOML command and agent map their fields', () => {
  const [skill] = manifestsOfKind('hub-skill/1') as HubSkill[];
  assert.equal(skill.name, 'tidy');
  assert.equal(skill.description, 'Tidy synthetic notes');
  assert.equal(skill.entry, 'SKILL.md');

  const [command] = manifestsOfKind('hub-command/1') as HubCommand[];
  assert.equal(command.name, 'git:commit');
  assert.equal(command.description, 'Commit synthetic changes');
  // The prompt template body stays in the file bytes, not in the manifest.
  assert.equal(JSON.stringify(command).includes('Review the staged'), false);
  assert.deepEqual(command.files.map((file) => file.path), ['.gemini/commands/git/commit.toml']);

  const [agent] = manifestsOfKind('hub-agent/1') as HubAgent[];
  assert.equal(agent.name, 'reviewer');
  assert.equal(agent.description, 'Review synthetic output');
  // Wildcards are kept unexpanded.
  assert.deepEqual(agent.tools, ['Read', 'mcp_*']);
  assert.equal(agent.model, 'scripted-model');
});

test('Gemini import: hooks keep group keys by name and map command handlers', () => {
  const [hook] = manifestsOfKind('hub-hook/1') as HubHook[];
  assert.equal(hook.event, 'SessionStart');
  assert.equal(hook.handler, 'sh scripts/session-start.sh');
  assert.equal(hook.language, 'shell');
  assert.equal(hook.order, undefined);
  const specific = hook.harnessSpecific as { matcher?: string; entryKeys: string[]; groupKeys: string[] };
  assert.equal(specific.matcher, 'Bash');
  assert.deepEqual(specific.entryKeys, ['type', 'command', 'name', 'timeout']);
  assert.deepEqual(specific.groupKeys, ['matcher', 'sequential', 'hooks']);
});

test('Gemini import: mcpServers map command to stdio, httpUrl to streamable-http, url to nothing', () => {
  const providers = manifestsOfKind('hub-provider/1') as HubProvider[];
  const local = providers.find((provider) => provider.name === 'local-tools')!;
  assert.equal(local.transport, 'stdio');
  assert.deepEqual(local.credentials, ['TOOLS_KEY']);

  const remote = providers.find((provider) => provider.name === 'remote-hub')!;
  assert.equal(remote.transport, 'streamable-http');
  assert.deepEqual(remote.harnessSpecific.shape, { httpUrl: true, headers: ['Authorization'] });

  const sse = providers.find((provider) => provider.name === 'legacy-sse')!;
  assert.equal(sse.transport, undefined);

  assert.equal(imported.warnings.filter((warning) => warning.code === 'PROVIDER_TRANSPORT_UNKNOWN').length, 1);
});

test('Gemini import: no manifest contains endpoints, secrets or absolute paths', () => {
  const serialized = JSON.stringify(imported.manifests);
  for (const secret of ['synthetic-gemini-key', 'synthetic-gemini-token', 'mcp.example.com']) {
    assert.equal(serialized.includes(secret), false, `${secret} leaked into a manifest`);
  }
  for (const value of manifestStrings(imported.manifests)) {
    assert.equal(/^([/~]|[A-Za-z]:[\\/])/.test(value), false, `absolute path leaked: ${value}`);
  }
});

test('Gemini round trip: unchanged manifests reproduce the originals except stripped values', () => {
  const exported = exportTo('gemini', imported.manifests, fixture);
  const byteIdentical = [
    'GEMINI.md',
    '.gemini/skills/tidy/SKILL.md',
    '.gemini/commands/git/commit.toml',
    '.gemini/agents/reviewer.md',
  ];
  for (const path of byteIdentical) {
    assert.equal(exported.files[path], fixture[path], path);
  }
  const settings = JSON.parse(exported.files['.gemini/settings.json'] as string) as Record<string, any>;
  // Section order follows the original file.
  assert.deepEqual(Object.keys(settings), ['hooks', 'mcpServers']);
  // Group and entry extras come back from the original bytes.
  assert.equal(settings.hooks.SessionStart[0].sequential, true);
  assert.deepEqual(settings.hooks.SessionStart[0].hooks[0], {
    type: 'command',
    command: 'sh scripts/session-start.sh',
    name: 'session-start',
    timeout: 5000,
  });
  assert.deepEqual(settings.mcpServers['local-tools'].env, { TOOLS_KEY: '[redacted]' });
  assert.equal(settings.mcpServers['remote-hub'].httpUrl, '[redacted]');
  assert.equal(settings.mcpServers['legacy-sse'].url, '[redacted]');
  assert.equal(JSON.stringify(settings).includes('synthetic'), false);
  assert.deepEqual(
    exported.warnings.map((warning) => warning.code).sort(),
    ['SECRET_PLACEHOLDER', 'SECRET_PLACEHOLDER', 'SECRET_PLACEHOLDER'],
  );
});

test('Gemini round trip: an edited command description is reflected, the prompt is untouched', () => {
  const manifests = structuredClone(imported.manifests);
  const command = manifests.find((manifest) => manifest.kind === 'hub-command/1')!;
  command.description = 'Edited in the hub';
  const exported = exportTo('gemini', manifests, fixture);
  const text = exported.files['.gemini/commands/git/commit.toml'] as string;
  assert.notEqual(text, fixture['.gemini/commands/git/commit.toml']);
  const parsed = parseToml(text);
  assert.equal(parsed.values.description, 'Edited in the hub');
  assert.equal(parsed.values.prompt, 'Review the staged synthetic changes and commit them.\n\nArguments: {{args}}\n');
});

test('Gemini import: an entry with more than one endpoint key is invalid', () => {
  const result = importFrom('gemini', {
    '.gemini/settings.json': JSON.stringify({
      mcpServers: { bad: { command: 'node', httpUrl: 'https://mcp.example.com/x' } },
    }),
  });
  assert.deepEqual(result.manifests, []);
  assert.deepEqual(
    result.warnings.map((warning) => warning.code).sort(),
    ['CANONICAL_NORMALIZATION', 'PROVIDER_ENTRY_INVALID'],
  );
});

test('Gemini import: empty settings.json is reported once', () => {
  const result = importFrom('gemini', { '.gemini/settings.json': '  \n' });
  assert.deepEqual(result.manifests, []);
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ['EMPTY_CONFIG'],
  );
});

test('Gemini import: a settings.json without governed sections stays quiet', () => {
  const result = importFrom('gemini', {
    '.gemini/settings.json': `${JSON.stringify({ general: { previewFeatures: true } }, null, 2)}\n`,
  });
  assert.deepEqual(result.manifests, []);
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ['CONFIG_EXTRA_KEYS'],
  );
});

test('Gemini import: unrecognized files are reported', () => {
  const result = importFrom('gemini', { 'notes.md': 'synthetic\n' });
  assert.deepEqual(result.manifests, []);
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ['UNRECOGNIZED_FILE'],
  );
});

test('Gemini export: cross-harness manifests are refused with a warning', () => {
  const claude = importFrom('claude-code', { 'CLAUDE.md': '# instructions\n' });
  const result = exportTo('gemini', claude.manifests, {});
  assert.deepEqual(result.files, {});
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ['CROSS_HARNESS_EXPORT'],
  );
});
