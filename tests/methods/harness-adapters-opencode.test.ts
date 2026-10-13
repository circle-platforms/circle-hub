import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  exportTo,
  importFrom,
  type HubAgent,
  type HubCommand,
  type HubInstruction,
  type HubManifest,
  type HubProvider,
  type HubSkill,
} from '../../packages/harness-adapters/index.ts';
import { loadVirtualFiles, manifestStrings, opencodeFixtureRoot } from '../fixtures/harness/load.ts';

const fixture = await loadVirtualFiles(opencodeFixtureRoot);
const imported = importFrom('opencode', fixture);

function manifestsOfKind<K extends HubManifest['kind']>(kind: K): Extract<HubManifest, { kind: K }>[] {
  return imported.manifests.filter((manifest) => manifest.kind === kind) as Extract<HubManifest, { kind: K }>[];
}

test('OpenCode import: fixture covers skills (both forms), command, agent, instruction, providers', () => {
  assert.deepEqual(
    imported.manifests.map((manifest) => manifest.kind).sort(),
    ['hub-agent/1', 'hub-command/1', 'hub-instruction/1', 'hub-provider/1', 'hub-provider/1', 'hub-skill/1', 'hub-skill/1'].sort(),
  );
  // No hub-hook/1: OpenCode registers hooks from plugin code, there is no
  // hooks file to import.
  const expected = new Set(['PROVIDER_VALUES_STRIPPED', 'CANONICAL_NORMALIZATION']);
  const unexpected = imported.warnings.filter((warning) => !expected.has(warning.code));
  assert.deepEqual(unexpected, []);
});

test('OpenCode import: skill names come from path ids, display name stays proprietary', () => {
  const skills = manifestsOfKind('hub-skill/1') as HubSkill[];
  const review = skills.find((skill) => skill.name === 'review')!;
  assert.equal(review.description, 'Review synthetic changes');
  assert.equal(review.entry, 'SKILL.md');
  const specific = review.harnessSpecific as { frontmatter?: Record<string, string> };
  assert.deepEqual(specific.frontmatter, { name: 'Review Display Name' });
  assert.deepEqual(
    review.files.map((file) => file.path).sort(),
    ['.opencode/skills/review/SKILL.md', '.opencode/skills/review/scripts/check.sh'],
  );

  // The root `<id>.md` form.
  const quick = skills.find((skill) => skill.name === 'quick')!;
  assert.equal(quick.entry, 'quick.md');
  assert.deepEqual(quick.files.map((file) => file.path), ['.opencode/skills/quick.md']);
});

test('OpenCode import: nested command and agent names keep their path', () => {
  const [command] = manifestsOfKind('hub-command/1') as HubCommand[];
  assert.equal(command.name, 'team/review');
  assert.equal(command.description, 'Nested team review');
  // agent/model/subagent have no hub-command fields and stay proprietary.
  assert.deepEqual((command.harnessSpecific as { frontmatter?: unknown }).frontmatter, {
    agent: 'builder',
    model: 'example/synthetic-model',
  });

  const [agent] = manifestsOfKind('hub-agent/1') as HubAgent[];
  assert.equal(agent.name, 'team/builder');
  assert.equal(agent.description, 'Build synthetic artifacts');
  assert.equal(agent.model, undefined);
  assert.deepEqual(agent.tools, []);

  const [instruction] = manifestsOfKind('hub-instruction/1') as HubInstruction[];
  assert.equal(instruction.fileName, 'AGENTS.md');
  assert.deepEqual(instruction.applies, []);
});

test('OpenCode import: mcp.servers map local to stdio and remote to streamable-http', () => {
  const providers = manifestsOfKind('hub-provider/1') as HubProvider[];
  const local = providers.find((provider) => provider.name === 'local-runner')!;
  assert.equal(local.transport, 'stdio');
  assert.deepEqual(local.credentials, ['RUNNER_TOKEN']);
  assert.deepEqual(local.harnessSpecific.shape, { type: true, command: true, environment: ['RUNNER_TOKEN'] });

  const remote = providers.find((provider) => provider.name === 'remote-hub')!;
  assert.equal(remote.transport, 'streamable-http');
  assert.deepEqual(remote.credentials, ['Authorization']);
  assert.deepEqual(remote.harnessSpecific.shape, { type: true, url: true, headers: ['Authorization'] });
});

test('OpenCode import: no manifest contains endpoints, secrets, env values or absolute paths', () => {
  const serialized = JSON.stringify(imported.manifests);
  for (const secret of ['synthetic-opencode-token', 'synthetic-opencode-header', 'mcp.example.com']) {
    assert.equal(serialized.includes(secret), false, `${secret} leaked into a manifest`);
  }
  for (const value of manifestStrings(imported.manifests)) {
    assert.equal(/^([/~]|[A-Za-z]:[\\/])/.test(value), false, `absolute path leaked into a manifest: ${value}`);
  }
});

test('OpenCode round trip: markdown byte-identical, jsonc config regenerated with placeholders', () => {
  const exported = exportTo('opencode', imported.manifests, fixture);
  const byteIdentical = [
    'AGENTS.md',
    '.opencode/skills/review/SKILL.md',
    '.opencode/skills/review/scripts/check.sh',
    '.opencode/skills/quick.md',
    '.opencode/commands/team/review.md',
    '.opencode/agents/team/builder.md',
  ];
  for (const path of byteIdentical) {
    assert.equal(exported.files[path], fixture[path], path);
  }
  // The jsonc comments and trailing commas cannot survive regeneration.
  assert.notEqual(exported.files['opencode.jsonc'], fixture['opencode.jsonc']);
  const config = JSON.parse(exported.files['opencode.jsonc'] as string) as {
    mcp: { servers: Record<string, Record<string, any>> };
  };
  assert.deepEqual(Object.keys(config.mcp.servers), ['local-runner', 'remote-hub']);
  assert.deepEqual(config.mcp.servers['local-runner'].command, ['node', 'server.js']);
  assert.deepEqual(config.mcp.servers['local-runner'].environment, { RUNNER_TOKEN: '[redacted]' });
  assert.equal(config.mcp.servers['remote-hub'].url, '[redacted]');
  assert.equal(JSON.stringify(config).includes('synthetic'), false);
  assert.deepEqual(
    exported.warnings.map((warning) => warning.code).sort(),
    ['SECRET_PLACEHOLDER', 'SECRET_PLACEHOLDER'],
  );
});

test('OpenCode import: empty and invalid configs are reported', () => {
  assert.deepEqual(
    importFrom('opencode', { 'opencode.json': '' }).warnings.map((warning) => warning.code),
    ['EMPTY_CONFIG'],
  );
  assert.deepEqual(
    importFrom('opencode', { 'opencode.json': '{}' }).warnings.map((warning) => warning.code),
    ['EMPTY_CONFIG'],
  );
  assert.deepEqual(
    importFrom('opencode', { 'opencode.json': 'not json' }).warnings.map((warning) => warning.code),
    ['CONFIG_JSON_INVALID'],
  );
});

test('OpenCode import: invalid and unknown provider shapes are reported per entry', () => {
  const result = importFrom('opencode', {
    'opencode.json': JSON.stringify({
      mcp: {
        servers: {
          'local-no-command': { type: 'local' },
          'remote-no-url': { type: 'remote' },
          untyped: { command: ['node'] },
          exotic: { type: 'grpc', url: 'https://mcp.example.com/grpc' },
        },
      },
    }),
  });
  assert.deepEqual(
    result.manifests.map((manifest) => (manifest as HubProvider).name).sort(),
    ['exotic', 'untyped'],
  );
  const exotic = result.manifests.find((manifest) => (manifest as HubProvider).name === 'exotic') as HubProvider;
  assert.equal(exotic.transport, undefined);
  assert.deepEqual(
    result.warnings.map((warning) => warning.code).sort(),
    [
      'CANONICAL_NORMALIZATION',
      'PROVIDER_ENTRY_INVALID',
      'PROVIDER_ENTRY_INVALID',
      'PROVIDER_SHAPE_UNKNOWN',
      'PROVIDER_TRANSPORT_UNKNOWN',
      'PROVIDER_VALUES_STRIPPED',
    ],
  );
});

test('OpenCode import: unrecognized files are reported', () => {
  const result = importFrom('opencode', { 'README.md': '# anything\n' });
  assert.deepEqual(result.manifests, []);
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ['UNRECOGNIZED_FILE'],
  );
});

test('OpenCode export: hooks have no file projection', () => {
  const hook = {
    kind: 'hub-hook/1',
    event: 'PreToolUse',
    handler: 'sh check.sh',
    sourceHarness: 'opencode',
    knownCompatible: [],
    files: [],
    harnessSpecific: {},
  } satisfies HubManifest;
  const result = exportTo('opencode', [hook], {});
  assert.deepEqual(result.files, {});
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ['NO_HARNESS_PROJECTION'],
  );
});

test('OpenCode export: cross-harness manifests are refused with a warning', () => {
  const claude = importFrom('claude-code', { 'CLAUDE.md': '# instructions\n' });
  const result = exportTo('opencode', claude.manifests, {});
  assert.deepEqual(result.files, {});
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ['CROSS_HARNESS_EXPORT'],
  );
});
