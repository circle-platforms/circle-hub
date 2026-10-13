import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  exportTo,
  importFrom,
  type HubAgent,
  type HubHook,
  type HubInstruction,
  type HubManifest,
  type HubProvider,
  type HubSkill,
} from '../../packages/harness-adapters/index.ts';
import { cursorFixtureRoot, loadVirtualFiles, manifestStrings } from '../fixtures/harness/load.ts';

const fixture = await loadVirtualFiles(cursorFixtureRoot);
const imported = importFrom('cursor', fixture);

function manifestsOfKind<K extends HubManifest['kind']>(kind: K): Extract<HubManifest, { kind: K }>[] {
  return imported.manifests.filter((manifest) => manifest.kind === kind) as Extract<HubManifest, { kind: K }>[];
}

test('Cursor import: fixture covers skills, agent, instructions, hooks, providers', () => {
  assert.deepEqual(
    imported.manifests.map((manifest) => manifest.kind).sort(),
    [
      'hub-agent/1',
      'hub-hook/1',
      'hub-hook/1',
      'hub-instruction/1',
      'hub-instruction/1',
      'hub-provider/1',
      'hub-provider/1',
      'hub-skill/1',
      'hub-skill/1',
    ].sort(),
  );
  const expected = new Set(['HOOK_EVENT_UNMAPPED', 'HOOK_ENTRY_SKIPPED', 'PROVIDER_VALUES_STRIPPED', 'PROVIDER_TRANSPORT_UNKNOWN', 'NAME_DERIVED_FROM_PATH']);
  const unexpected = imported.warnings.filter((warning) => !expected.has(warning.code));
  assert.deepEqual(unexpected, []);
});

test('Cursor import: skills from .cursor and .agents locations, rules globs map to applies', () => {
  const skills = manifestsOfKind('hub-skill/1') as HubSkill[];
  assert.deepEqual(
    skills.map((skill) => skill.name).sort(),
    ['review', 'shared'],
  );
  // `paths` on a skill is a file scope, not triggers: stays proprietary.
  const review = skills.find((skill) => skill.name === 'review')!;
  assert.deepEqual((review.harnessSpecific as { frontmatter?: unknown }).frontmatter, { paths: 'src/**' });

  const [rules] = (manifestsOfKind('hub-instruction/1') as HubInstruction[]).filter(
    (instruction) => instruction.fileName === 'style.mdc',
  );
  assert.deepEqual(rules.applies, ['src/**', 'tests/**']);
  const instructions = manifestsOfKind('hub-instruction/1');
  assert.ok(instructions.some((instruction) => instruction.fileName === 'AGENTS.md'));

  const [agent] = manifestsOfKind('hub-agent/1') as HubAgent[];
  assert.equal(agent.name, 'helper');
  assert.equal(agent.description, 'Help with synthetic tasks');
  // readonly is not a tool whitelist: tools stays empty, readonly proprietary.
  assert.deepEqual(agent.tools, []);
  assert.deepEqual((agent.harnessSpecific as { frontmatter?: unknown }).frontmatter, { readonly: 'true' });
});

test('Cursor import: flat hooks entries, prompt type skipped, language left empty', () => {
  const hooks = manifestsOfKind('hub-hook/1') as HubHook[];
  assert.equal(hooks.length, 2);
  assert.deepEqual(
    hooks.map((hook) => [hook.event, hook.handler]),
    [
      ['beforeShellExecution', 'sh scripts/verify-command.sh'],
      ['sessionStart', 'sh scripts/boot.sh'],
    ],
  );
  for (const hook of hooks) assert.equal(hook.language, undefined);
  const skipped = imported.warnings.filter((warning) => warning.code === 'HOOK_ENTRY_SKIPPED');
  assert.equal(skipped.length, 1);
  assert.ok(skipped[0].detail.includes('"prompt"'));
  assert.equal(skipped[0].detail.includes('synthetic prompt text'), false);
  assert.equal(imported.warnings.filter((warning) => warning.code === 'HOOK_EVENT_UNMAPPED').length, 2);
});

test('Cursor import: url-only entries keep an empty transport (HTTP or SSE is not pinned down)', () => {
  const providers = manifestsOfKind('hub-provider/1') as HubProvider[];
  const local = providers.find((provider) => provider.name === 'local-runner')!;
  assert.equal(local.transport, 'stdio');
  assert.deepEqual(local.credentials, ['RUNNER_KEY']);
  const remote = providers.find((provider) => provider.name === 'remote-hub')!;
  assert.equal(remote.transport, undefined);
  assert.deepEqual(remote.harnessSpecific.shape, { url: true, headers: ['Authorization'] });
});

test('Cursor import: no manifest contains endpoints, secrets or absolute paths', () => {
  const serialized = JSON.stringify(imported.manifests);
  for (const secret of ['synthetic-cursor-key', 'synthetic-cursor-token', 'mcp.example.com']) {
    assert.equal(serialized.includes(secret), false, `${secret} leaked into a manifest`);
  }
  for (const value of manifestStrings(imported.manifests)) {
    assert.equal(/^([/~]|[A-Za-z]:[\\/])/.test(value), false, `absolute path leaked: ${value}`);
  }
});

test('Cursor round trip: unchanged manifests reproduce the originals except stripped values', () => {
  const exported = exportTo('cursor', imported.manifests, fixture);
  const byteIdentical = [
    'AGENTS.md',
    '.cursor/rules/style.mdc',
    '.cursor/skills/review/SKILL.md',
    '.agents/skills/shared/SKILL.md',
    '.cursor/agents/helper.md',
    '.cursor/hooks.json',
  ];
  for (const path of byteIdentical) {
    assert.equal(exported.files[path], fixture[path], path);
  }
  const mcp = JSON.parse(exported.files['.cursor/mcp.json'] as string) as { mcpServers: Record<string, any> };
  assert.deepEqual(mcp.mcpServers['local-runner'].env, { RUNNER_KEY: '[redacted]' });
  assert.equal(mcp.mcpServers['remote-hub'].url, '[redacted]');
  assert.equal(JSON.stringify(mcp).includes('synthetic'), false);
  assert.deepEqual(
    exported.warnings.map((warning) => warning.code).sort(),
    ['SECRET_PLACEHOLDER', 'SECRET_PLACEHOLDER'],
  );
});

test('Cursor round trip: hooks.json keeps version, extra keys and skipped prompt entries', () => {
  const exported = exportTo('cursor', imported.manifests, fixture);
  const hooks = JSON.parse(exported.files['.cursor/hooks.json'] as string) as {
    version: number;
    hooks: Record<string, Array<Record<string, unknown>>>;
  };
  assert.equal(hooks.version, 1);
  assert.deepEqual(hooks.hooks.beforeShellExecution, [{ command: 'sh scripts/verify-command.sh', timeout: 10 }]);
  // The prompt entry was skipped at import but is preserved from the
  // original bytes on export: a round trip never loses entries.
  assert.deepEqual(hooks.hooks.sessionStart, [
    { command: 'sh scripts/boot.sh' },
    { type: 'prompt', prompt: 'synthetic prompt text' },
  ]);
});

test('Cursor export: without the original hooks file, skipped entries cannot be preserved', () => {
  const exported = exportTo('cursor', imported.manifests, {});
  const hooks = JSON.parse(exported.files['.cursor/hooks.json'] as string) as {
    version?: number;
    hooks: Record<string, unknown[]>;
  };
  assert.equal(hooks.version, undefined);
  assert.deepEqual(hooks.hooks.sessionStart, [{ command: 'sh scripts/boot.sh' }]);
  assert.ok(exported.warnings.some((warning) => warning.code === 'HOOK_ENTRY_DROPPED_ON_EXPORT' && warning.path === '.cursor/hooks.json'));
});

test('Cursor import: recursive .agents skills and .claude/.codex compat dirs are imported', () => {
  const result = importFrom('cursor', {
    '.agents/skills/category/deep-skill/SKILL.md': '---\nname: deep-skill\ndescription: Nested agents skill\n---\n\nBody.\n',
    '.claude/skills/from-claude/SKILL.md': '---\nname: from-claude\ndescription: Claude compat\n---\n\nBody.\n',
    '.codex/skills/from-codex/SKILL.md': '---\nname: from-codex\ndescription: Codex compat\n---\n\nBody.\n',
  });
  assert.deepEqual(
    result.manifests.map((manifest) => (manifest as HubSkill).name).sort(),
    ['deep-skill', 'from-claude', 'from-codex'],
  );
  assert.deepEqual(result.warnings, []);
});

test('Cursor import: empty configs are reported', () => {
  for (const path of ['.cursor/hooks.json', '.cursor/mcp.json']) {
    const result = importFrom('cursor', { [path]: '' });
    assert.deepEqual(result.manifests, []);
    assert.deepEqual(
      result.warnings.map((warning) => warning.code),
      ['EMPTY_CONFIG'],
      path,
    );
  }
});

test('Cursor export: commands have no file projection', () => {
  const command = {
    kind: 'hub-command/1',
    name: 'anything',
    description: '',
    sourceHarness: 'cursor',
    knownCompatible: [],
    files: [],
    harnessSpecific: {},
  } satisfies HubManifest;
  const result = exportTo('cursor', [command], {});
  assert.deepEqual(result.files, {});
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ['NO_HARNESS_PROJECTION'],
  );
});

test('Cursor export: cross-harness manifests are refused with a warning', () => {
  const claude = importFrom('claude-code', { 'CLAUDE.md': '# instructions\n' });
  const result = exportTo('cursor', claude.manifests, {});
  assert.deepEqual(result.files, {});
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ['CROSS_HARNESS_EXPORT'],
  );
});
