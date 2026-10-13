import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportTo, importFrom } from '../../packages/harness-adapters/index.ts';
import { claudeCodeFixtureRoot, codexFixtureRoot, loadVirtualFiles } from '../fixtures/harness/load.ts';

test('Claude Code round trip: unchanged manifests reproduce the original files byte-identically', async () => {
  const fixture = await loadVirtualFiles(claudeCodeFixtureRoot);
  const imported = importFrom('claude-code', fixture);
  const exported = exportTo('claude-code', imported.manifests, fixture);

  const byteIdentical = [
    'CLAUDE.md',
    'CLAUDE.local.md',
    'AGENTS.md',
    '.claude/rules/style-guide.md',
    '.claude/skills/review-code/SKILL.md',
    '.claude/skills/review-code/scripts/check.sh',
    '.claude/commands/summarize.md',
    '.claude/commands/review/code.md',
    '.claude/agents/test-reviewer.md',
    '.claude/settings.json',
    '.claude/settings.local.json',
    'packages/demo/.claude/skills/deep-skill/SKILL.md',
  ];
  for (const path of byteIdentical) {
    assert.equal(exported.files[path], fixture[path], path);
  }
  assert.deepEqual(Object.keys(exported.files).sort(), [...byteIdentical, '.mcp.json'].sort());

  // .mcp.json cannot be byte-identical: endpoint and env values were stripped
  // at import; export writes placeholders and says exactly what to refill.
  assert.notEqual(exported.files['.mcp.json'], fixture['.mcp.json']);
  const mcp = JSON.parse(exported.files['.mcp.json'] as string) as {
    mcpServers: Record<string, Record<string, any>>;
  };
  assert.deepEqual(Object.keys(mcp.mcpServers), ['docs-lookup', 'team-knowledge']);
  assert.deepEqual(mcp.mcpServers['docs-lookup'].env, { DOCS_API_KEY: '[redacted]', DOCS_REGION: '[redacted]' });
  assert.equal(mcp.mcpServers['team-knowledge'].url, '[redacted]');
  assert.equal(JSON.stringify(mcp).includes('synthetic'), false);
  assert.deepEqual(
    exported.warnings.map((warning) => warning.code).sort(),
    ['SECRET_PLACEHOLDER', 'SECRET_PLACEHOLDER'],
  );
});

test('Claude Code round trip: an edited manifest frontmatter is reflected, the body is untouched', async () => {
  const fixture = await loadVirtualFiles(claudeCodeFixtureRoot);
  const imported = importFrom('claude-code', fixture);
  const manifests = structuredClone(imported.manifests);
  const skill = manifests.find((manifest) => manifest.kind === 'hub-skill/1')!;
  skill.description = 'Edited in the hub';
  const exported = exportTo('claude-code', manifests, fixture);
  const text = exported.files['.claude/skills/review-code/SKILL.md'] as string;
  assert.ok(text.includes('description: Edited in the hub'), text);
  assert.equal(text.includes('Review a change set with synthetic checks only'), false);
  // Unchanged keys keep their original form and order; the body is verbatim.
  assert.ok(text.startsWith('---\nname: review-code\ndescription: Edited in the hub\nmodel: scripted-model\nallowed-tools: Read, Grep\nx-team: meridian\n---\n'), text);
  const originalBody = (fixture['.claude/skills/review-code/SKILL.md'] as string).split('---\n').pop()!;
  assert.ok(text.endsWith(originalBody), text);
  // Other files stay byte-identical.
  assert.equal(exported.files['.claude/commands/summarize.md'], fixture['.claude/commands/summarize.md']);
});

test('Claude Code round trip: non-canonical settings.json is normalized with a warning', () => {
  const text =
    '{\n    "hooks": {\n        "PreToolUse": [\n            {\n                "matcher": "Bash",\n                "hooks": [\n                    {\n                        "type": "command",\n                        "command": "sh check.sh"\n                    }\n                ]\n            }\n        ]\n    }\n}\n';
  const input = { '.claude/settings.json': text };
  const imported = importFrom('claude-code', input);
  assert.deepEqual(
    imported.warnings.map((warning) => warning.code).sort(),
    ['CANONICAL_NORMALIZATION', 'HOOK_EVENT_UNMAPPED'],
  );
  const exported = exportTo('claude-code', imported.manifests, input);
  assert.notEqual(exported.files['.claude/settings.json'], text);
  assert.equal(
    exported.files['.claude/settings.json'],
    `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'sh check.sh' }] }] } }, null, 2)}\n`,
  );
});

test('Claude Code round trip: settings.json keys outside hooks are reported and dropped', () => {
  const text = `${JSON.stringify({
    model: 'scripted-model',
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'sh boot.sh' }] }] },
  }, null, 2)}\n`;
  const input = { '.claude/settings.json': text };
  const imported = importFrom('claude-code', input);
  assert.deepEqual(
    imported.warnings.map((warning) => warning.code).sort(),
    ['CONFIG_EXTRA_KEYS', 'HOOK_EVENT_UNMAPPED'],
  );
  const exported = exportTo('claude-code', imported.manifests, input);
  const settings = JSON.parse(exported.files['.claude/settings.json'] as string) as Record<string, unknown>;
  assert.deepEqual(Object.keys(settings), ['hooks']);
});

test('Codex round trip: markdown files byte-identical, stripped env values become placeholders', async () => {
  const fixture = await loadVirtualFiles(codexFixtureRoot);
  const imported = importFrom('codex', fixture);
  const exported = exportTo('codex', imported.manifests, fixture);

  const byteIdentical = [
    'AGENTS.md',
    'AGENTS.override.md',
    '.agents/skills/tidy/SKILL.md',
    '.codex/hooks.json',
  ];
  for (const path of byteIdentical) {
    assert.equal(exported.files[path], fixture[path], path);
  }
  assert.deepEqual(Object.keys(exported.files).sort(), [...byteIdentical, '.codex/config.toml'].sort());

  const config = exported.files['.codex/config.toml'] as string;
  assert.notEqual(config, fixture['.codex/config.toml']);
  assert.ok(config.includes('DOCS_API_KEY = "[redacted]"'), config);
  assert.ok(config.includes('[mcp_servers.pings]'), config);
  assert.ok(config.includes('args = ["server.js"]'), config);
  assert.equal(config.includes('synthetic-docs-key'), false);
  assert.deepEqual(
    exported.warnings.map((warning) => warning.code),
    ['SECRET_PLACEHOLDER'],
  );
});
