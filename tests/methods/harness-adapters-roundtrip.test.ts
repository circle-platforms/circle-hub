import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportTo, importFrom } from '../../packages/harness-adapters/index.ts';
import { claudeCodeFixtureRoot, codexFixtureRoot, loadVirtualFiles } from '../fixtures/harness/load.ts';

test('Claude Code round trip: markdown files and canonical settings.json are byte-identical', async () => {
  const fixture = await loadVirtualFiles(claudeCodeFixtureRoot);
  const imported = importFrom('claude-code', fixture);
  const exported = exportTo('claude-code', imported.manifests);

  const byteIdentical = [
    'CLAUDE.md',
    '.claude/skills/review-code/SKILL.md',
    '.claude/skills/review-code/scripts/check.sh',
    '.claude/commands/summarize.md',
    '.claude/agents/test-reviewer.md',
    '.claude/settings.json',
  ];
  for (const path of byteIdentical) {
    assert.equal(exported.files[path], fixture[path], path);
  }
  assert.deepEqual(Object.keys(exported.files).sort(), [...byteIdentical, '.mcp.json'].sort());

  // .mcp.json cannot be byte-identical: endpoint and env values were stripped
  // at import; the export warnings say exactly what must be refilled.
  assert.notEqual(exported.files['.mcp.json'], fixture['.mcp.json']);
  const mcp = JSON.parse(exported.files['.mcp.json'] as string) as {
    mcpServers: Record<string, Record<string, any>>;
  };
  assert.deepEqual(Object.keys(mcp.mcpServers), ['docs-lookup', 'team-knowledge']);
  assert.deepEqual(mcp.mcpServers['docs-lookup'].env, { DOCS_API_KEY: '', DOCS_REGION: '' });
  assert.equal(mcp.mcpServers['team-knowledge'].url, '');
  assert.equal(JSON.stringify(mcp).includes('synthetic'), false);
  assert.deepEqual(
    exported.warnings.map((warning) => warning.code).sort(),
    ['PROVIDER_VALUES_EMPTY', 'PROVIDER_VALUES_EMPTY'],
  );
});

test('Claude Code round trip: non-canonical settings.json is normalized with a warning', () => {
  const text =
    '{\n    "hooks": {\n        "PreToolUse": [\n            {\n                "matcher": "Bash",\n                "hooks": [\n                    {\n                        "type": "command",\n                        "command": "sh check.sh"\n                    }\n                ]\n            }\n        ]\n    }\n}\n';
  const imported = importFrom('claude-code', { '.claude/settings.json': text });
  assert.deepEqual(
    imported.warnings.map((warning) => warning.code).sort(),
    ['CANONICAL_NORMALIZATION', 'HOOK_DETERMINISM_UNKNOWN'],
  );
  const exported = exportTo('claude-code', imported.manifests);
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
  const imported = importFrom('claude-code', { '.claude/settings.json': text });
  assert.deepEqual(
    imported.warnings.map((warning) => warning.code).sort(),
    ['CONFIG_EXTRA_KEYS', 'HOOK_DETERMINISM_UNKNOWN'],
  );
  const exported = exportTo('claude-code', imported.manifests);
  const settings = JSON.parse(exported.files['.claude/settings.json'] as string) as Record<string, unknown>;
  assert.deepEqual(Object.keys(settings), ['hooks']);
});

test('Codex round trip: AGENTS.md is byte-identical, stripped env values are flagged', async () => {
  const fixture = await loadVirtualFiles(codexFixtureRoot);
  const imported = importFrom('codex', fixture);
  const exported = exportTo('codex', imported.manifests);

  assert.equal(exported.files['AGENTS.md'], fixture['AGENTS.md']);
  assert.deepEqual(Object.keys(exported.files).sort(), ['.codex/config.toml', 'AGENTS.md']);

  const config = exported.files['.codex/config.toml'] as string;
  assert.notEqual(config, fixture['.codex/config.toml']);
  assert.ok(config.includes('DOCS_API_KEY = ""'), config);
  assert.ok(config.includes('[mcp_servers.pings]'), config);
  assert.ok(config.includes('args = ["server.js"]'), config);
  assert.equal(config.includes('synthetic-docs-key'), false);
  assert.deepEqual(
    exported.warnings.map((warning) => warning.code),
    ['PROVIDER_VALUES_EMPTY'],
  );
});
