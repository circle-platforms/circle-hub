import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  exportTo,
  importFrom,
  type HubAgent,
  type HubCommand,
  type HubHook,
  type HubInstruction,
  type HubManifest,
  type HubProvider,
  type HubSkill,
} from '../../packages/harness-adapters/index.ts';
import { claudeCodeFixtureRoot, loadVirtualFiles, manifestStrings } from '../fixtures/harness/load.ts';

const fixture = await loadVirtualFiles(claudeCodeFixtureRoot);
const imported = importFrom('claude-code', fixture);

function manifestsOfKind<K extends HubManifest['kind']>(kind: K): Extract<HubManifest, { kind: K }>[] {
  return imported.manifests.filter((manifest) => manifest.kind === kind) as Extract<HubManifest, { kind: K }>[];
}

test('Claude Code import: fixture covers every governed primitive kind', () => {
  assert.deepEqual(
    imported.manifests.map((manifest) => manifest.kind).sort(),
    [
      'hub-agent/1',
      'hub-command/1',
      'hub-hook/1',
      'hub-hook/1',
      'hub-hook/1',
      'hub-instruction/1',
      'hub-provider/1',
      'hub-provider/1',
      'hub-skill/1',
    ].sort(),
  );
  const expected = new Set(['PROVIDER_VALUES_STRIPPED', 'HOOK_DETERMINISM_UNKNOWN']);
  const unexpected = imported.warnings.filter((warning) => !expected.has(warning.code));
  assert.deepEqual(unexpected, []);
});

test('Claude Code import: skill frontmatter maps to hub-skill/1 and proprietary keys survive', () => {
  const [skill] = manifestsOfKind('hub-skill/1');
  assert.equal(skill.name, 'review-code');
  assert.equal(skill.description, 'Review a change set with synthetic checks only');
  assert.equal(skill.entry, 'SKILL.md');
  assert.deepEqual(skill.tools, ['Read', 'Grep']);
  assert.deepEqual(skill.inputs, []);
  assert.deepEqual(skill.outputs, []);
  assert.deepEqual(skill.triggers, []);
  assert.equal(skill.version, undefined);
  assert.equal(skill.model, undefined);
  assert.equal(skill.sourceHarness, 'claude-code');
  assert.deepEqual(skill.knownCompatible, []);
  // Bytes stay out of the manifest: files carries path + sha256 references,
  // harnessSpecific carries locations and unmapped frontmatter keys only.
  assert.deepEqual(
    skill.files.map((file) => file.path),
    ['.claude/skills/review-code/SKILL.md', '.claude/skills/review-code/scripts/check.sh'],
  );
  for (const file of skill.files) assert.match(file.sha256, /^[0-9a-f]{64}$/);
  const specific = skill.harnessSpecific as { path: string; frontmatter: Record<string, string> };
  assert.equal(specific.path, '.claude/skills/review-code/SKILL.md');
  assert.deepEqual(specific.frontmatter, { 'x-team': 'meridian' });
  assert.equal(JSON.stringify(skill.harnessSpecific).includes('# Review code'), false);
});

test('Claude Code import: command, agent and instruction map their fields', () => {
  const [command] = manifestsOfKind('hub-command/1') as HubCommand[];
  assert.equal(command.name, 'summarize');
  assert.equal(command.description, 'Summarize the current change set');
  assert.equal(command.arguments, '[scope]');

  const [agent] = manifestsOfKind('hub-agent/1') as HubAgent[];
  assert.equal(agent.name, 'test-reviewer');
  assert.equal(agent.description, 'Review synthetic test results');
  assert.deepEqual(agent.tools, ['Read', 'Grep']);
  assert.equal(agent.model, 'scripted-model');

  const [instruction] = manifestsOfKind('hub-instruction/1') as HubInstruction[];
  assert.equal(instruction.scope, 'project');
  assert.deepEqual(instruction.applies, []);
  assert.equal(instruction.fileName, 'CLAUDE.md');
});

test('Claude Code import: multiple hooks become individual ordered manifests', () => {
  const hooks = manifestsOfKind('hub-hook/1') as HubHook[];
  assert.equal(hooks.length, 3);
  assert.deepEqual(hooks.map((hook) => hook.event), ['PreToolUse', 'PostToolUse', 'PostToolUse']);
  assert.deepEqual(hooks.map((hook) => hook.order), [0, 1, 2]);
  assert.deepEqual(
    hooks.map((hook) => hook.handler),
    ['sh scripts/check-command.sh', 'sh scripts/format-check.sh', 'sh scripts/lint-check.sh'],
  );
  for (const hook of hooks) {
    assert.equal(hook.language, 'shell');
    assert.equal(hook.deterministic, false);
    assert.deepEqual(hook.files.map((file) => file.path), ['.claude/settings.json']);
  }
  const specific = hooks.map((hook) => hook.harnessSpecific as { matcher?: string; groupIndex: number; entryIndex: number; entry: Record<string, unknown> });
  assert.equal(specific[0].matcher, 'Bash');
  assert.deepEqual(
    specific.map((entry) => [entry.groupIndex, entry.entryIndex]),
    [[0, 0], [0, 0], [0, 1]],
  );
  assert.equal(specific[2].entry.timeout, 30);
  const determinism = imported.warnings.filter((warning) => warning.code === 'HOOK_DETERMINISM_UNKNOWN');
  assert.equal(determinism.length, 3);
});

test('Claude Code import: stdio and http MCP servers keep names and shapes without secrets', () => {
  const providers = manifestsOfKind('hub-provider/1') as HubProvider[];
  assert.equal(providers.length, 2);

  const docs = providers.find((provider) => provider.name === 'docs-lookup')!;
  assert.equal(docs.transport, 'stdio');
  assert.deepEqual(docs.credentials, ['DOCS_API_KEY', 'DOCS_REGION']);
  assert.equal(docs.credentialMode, 'static');
  assert.deepEqual(docs.provides, { tools: [], resources: [], prompts: [] });
  assert.deepEqual(docs.reads, []);
  assert.deepEqual(docs.writes, []);
  const docsShape = docs.harnessSpecific.shape as Record<string, unknown>;
  assert.equal(docsShape.command, 'npx');
  assert.deepEqual(docsShape.args, ['-y', '@example/docs-mcp']);
  assert.deepEqual(docsShape.env, { DOCS_API_KEY: '', DOCS_REGION: '' });

  const knowledge = providers.find((provider) => provider.name === 'team-knowledge')!;
  assert.equal(knowledge.transport, 'streamable-http');
  assert.deepEqual(knowledge.credentials, ['Authorization']);
  const knowledgeShape = knowledge.harnessSpecific.shape as Record<string, unknown>;
  assert.equal(knowledgeShape.type, 'http');
  assert.equal(knowledgeShape.url, '');
  assert.deepEqual(knowledgeShape.headers, { Authorization: '' });

  const stripped = imported.warnings.filter((warning) => warning.code === 'PROVIDER_VALUES_STRIPPED');
  assert.equal(stripped.length, 2);
});

test('Claude Code import: no manifest contains endpoints, secrets, env values or absolute paths', () => {
  const serialized = JSON.stringify(imported.manifests);
  for (const secret of ['synthetic-docs-key', 'example-region', 'synthetic-knowledge-token', 'mcp.example.com']) {
    assert.equal(serialized.includes(secret), false, `${secret} leaked into a manifest`);
  }
  for (const value of manifestStrings(imported.manifests)) {
    assert.equal(/^([/~]|[A-Za-z]:[\\/])/.test(value), false, `absolute path leaked into a manifest: ${value}`);
    assert.equal(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value), false, `endpoint leaked into a manifest: ${value}`);
  }
});

test('Claude Code import: missing frontmatter fields are derived or left empty, never guessed', () => {
  const result = importFrom('claude-code', {
    '.claude/skills/plain-skill/SKILL.md': '# Plain skill\n\nNo frontmatter at all.\n',
  });
  const [skill] = result.manifests as HubSkill[];
  assert.equal(skill.name, 'plain-skill');
  assert.equal(skill.description, '');
  assert.deepEqual(skill.tools, []);
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ['NAME_DERIVED_FROM_PATH'],
  );
});

test('Claude Code import: broken frontmatter warns and keeps the rest importable', () => {
  const unclosed = importFrom('claude-code', {
    '.claude/agents/broken.md': '---\nname: broken-agent\ndescription: never closed\n',
  });
  const [agent] = unclosed.manifests as HubAgent[];
  assert.equal(agent.name, 'broken');
  assert.deepEqual(
    unclosed.warnings.map((warning) => warning.code),
    ['FRONTMATTER_UNCLOSED', 'NAME_DERIVED_FROM_PATH'],
  );

  const badLine = importFrom('claude-code', {
    '.claude/commands/weird.md': '---\nthis line has no colon\ndescription: kept\n---\n\nBody.\n',
  });
  const [command] = badLine.manifests as HubCommand[];
  assert.equal(command.description, 'kept');
  assert.deepEqual(
    badLine.warnings.map((warning) => warning.code),
    ['FRONTMATTER_LINE_SKIPPED'],
  );
});

test('Claude Code import: empty input imports to nothing without warnings', () => {
  assert.deepEqual(importFrom('claude-code', {}), { manifests: [], warnings: [] });
});

test('Claude Code import: unrecognized files are reported, not silently dropped', () => {
  const result = importFrom('claude-code', { 'README.md': '# anything\n' });
  assert.deepEqual(result.manifests, []);
  assert.deepEqual(
    result.warnings.map((warning) => [warning.code, warning.path]),
    [['UNRECOGNIZED_FILE', 'README.md']],
  );
});

test('Claude Code import: invalid settings JSON warns and imports no hooks', () => {
  const result = importFrom('claude-code', { '.claude/settings.json': 'not json' });
  assert.equal(result.manifests.length, 0);
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ['CONFIG_JSON_INVALID'],
  );
});

test('Claude Code import: legacy sse transport is left empty with a warning', () => {
  const result = importFrom('claude-code', {
    '.mcp.json': JSON.stringify({ mcpServers: { legacy: { type: 'sse', url: 'http://192.0.2.10:9000/sse' } } }),
  });
  const [provider] = result.manifests as HubProvider[];
  assert.equal(provider.transport, undefined);
  assert.deepEqual(
    result.warnings.map((warning) => warning.code).sort(),
    ['CANONICAL_NORMALIZATION', 'PROVIDER_TRANSPORT_UNKNOWN', 'PROVIDER_VALUES_STRIPPED'],
  );
  assert.equal(JSON.stringify(result.manifests).includes('192.0.2.10'), false);
});

test('Claude Code import: absolute command paths and arg values are kept out of manifests', () => {
  const result = importFrom('claude-code', {
    '.mcp.json': JSON.stringify({
      mcpServers: {
        local: { command: '/opt/tools/bin/server', args: ['--root', '/srv/data', 'plain'] },
      },
    }),
  });
  const [provider] = result.manifests as HubProvider[];
  const shape = provider.harnessSpecific.shape as Record<string, unknown>;
  assert.equal(shape.command, 'server');
  assert.deepEqual(shape.args, ['--root', '[redacted]', 'plain']);
  assert.deepEqual(
    result.warnings.map((warning) => warning.code).sort(),
    ['CANONICAL_NORMALIZATION', 'PROVIDER_ARG_REDACTED', 'PROVIDER_COMMAND_ABSOLUTE'],
  );
});

test('Claude Code export: cross-harness manifests are refused with a warning', () => {
  const codex = importFrom('codex', { 'AGENTS.md': '# instructions\n' });
  const result = exportTo('claude-code', codex.manifests, {});
  assert.deepEqual(result.files, {});
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ['CROSS_HARNESS_EXPORT'],
  );
});

test('Claude Code export: manifests failing the neutral schema are rejected', () => {
  const result = exportTo('claude-code', [{ kind: 'hub-skill/1', name: '' } as unknown as HubManifest], {});
  assert.deepEqual(result.files, {});
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ['MANIFEST_INVALID'],
  );
});

test('Claude Code export: hub-tool/1 has no file projection', () => {
  const tool = {
    kind: 'hub-tool/1',
    name: 'docs.lookup',
    description: '',
    inputSchema: {},
    sourceHarness: 'claude-code',
    knownCompatible: [],
    files: [],
    harnessSpecific: {},
  } satisfies HubManifest;
  const result = exportTo('claude-code', [tool], {});
  assert.deepEqual(result.files, {});
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ['NO_HARNESS_PROJECTION'],
  );
});

test('Claude Code export: source files missing from the file table are reported', () => {
  const result = exportTo('claude-code', imported.manifests, {});
  assert.deepEqual(Object.keys(result.files).sort(), ['.claude/settings.json', '.mcp.json']);
  assert.equal(
    result.warnings.filter((warning) => warning.code === 'SOURCE_FILE_MISSING').length,
    4,
  );
});

test('Claude Code round trip: binary sibling files stay byte-exact', () => {
  const bytes = new Uint8Array([0, 159, 146, 150, 1, 2, 3]);
  const input = {
    '.claude/skills/blob-skill/SKILL.md': '---\nname: blob-skill\n---\n\nBody.\n',
    '.claude/skills/blob-skill/data.bin': bytes,
  };
  const result = exportTo('claude-code', importFrom('claude-code', input).manifests, input);
  assert.deepEqual(result.files['.claude/skills/blob-skill/data.bin'], bytes);
  assert.equal(result.files['.claude/skills/blob-skill/SKILL.md'], input['.claude/skills/blob-skill/SKILL.md']);
});
