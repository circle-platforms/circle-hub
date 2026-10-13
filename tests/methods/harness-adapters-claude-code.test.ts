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

test('Claude Code import: fixture covers every governed primitive kind and location', () => {
  assert.deepEqual(
    imported.manifests.map((manifest) => manifest.kind).sort(),
    [
      'hub-agent/1',
      'hub-command/1',
      'hub-command/1',
      'hub-hook/1',
      'hub-hook/1',
      'hub-hook/1',
      'hub-hook/1',
      'hub-instruction/1',
      'hub-instruction/1',
      'hub-instruction/1',
      'hub-instruction/1',
      'hub-provider/1',
      'hub-provider/1',
      'hub-skill/1',
      'hub-skill/1',
    ].sort(),
  );
  const expected = new Set(['PROVIDER_VALUES_STRIPPED', 'HOOK_EVENT_UNMAPPED']);
  const unexpected = imported.warnings.filter((warning) => !expected.has(warning.code));
  assert.deepEqual(unexpected, []);
});

test('Claude Code import: locations — nested skills, nested commands, rules, local files', () => {
  const skills = manifestsOfKind('hub-skill/1');
  assert.deepEqual(
    skills.map((skill) => skill.name).sort(),
    ['deep-skill', 'review-code'],
  );
  const deep = skills.find((skill) => skill.name === 'deep-skill')!;
  assert.equal((deep.harnessSpecific as { path: string }).path, 'packages/demo/.claude/skills/deep-skill/SKILL.md');

  const commands = manifestsOfKind('hub-command/1');
  assert.deepEqual(
    commands.map((command) => command.name).sort(),
    ['review:code', 'summarize'],
  );

  const instructions = manifestsOfKind('hub-instruction/1');
  assert.deepEqual(
    instructions.map((instruction) => instruction.fileName).sort(),
    ['AGENTS.md', 'CLAUDE.local.md', 'CLAUDE.md', 'style-guide.md'],
  );
  const rules = instructions.find((instruction) => instruction.fileName === 'style-guide.md')!;
  assert.deepEqual(rules.applies, ['src/**', 'tests/**']);

  const hooks = manifestsOfKind('hub-hook/1');
  const local = hooks.find((hook) => (hook.harnessSpecific as { filePath: string }).filePath === '.claude/settings.local.json')!;
  assert.equal(local.event, 'SessionStart');
  assert.equal(local.handler, 'sh scripts/boot-check.sh');
});

test('Claude Code import: skill frontmatter maps to hub-skill/1 and proprietary keys survive', () => {
  const [skill] = manifestsOfKind('hub-skill/1');
  assert.equal(skill.name, 'review-code');
  assert.equal(skill.description, 'Review a change set with synthetic checks only');
  assert.equal(skill.entry, 'SKILL.md');
  assert.equal(skill.model, 'scripted-model');
  // allowed-tools is a no-prompt permission hint, not a tool restriction: it
  // lands in harnessSpecific, not in tools.
  assert.deepEqual(skill.tools, []);
  const specific = skill.harnessSpecific as { allowedTools?: string[] };
  assert.deepEqual(specific.allowedTools, ['Read', 'Grep']);
  assert.deepEqual(skill.inputs, []);
  assert.deepEqual(skill.outputs, []);
  assert.deepEqual(skill.triggers, []);
  assert.equal(skill.version, undefined);
  assert.equal(skill.sourceHarness, 'claude-code');
  assert.deepEqual(skill.knownCompatible, []);
  // Bytes stay out of the manifest: files carries path + sha256 references,
  // harnessSpecific carries locations and unmapped frontmatter keys only.
  assert.deepEqual(
    skill.files.map((file) => file.path),
    ['.claude/skills/review-code/SKILL.md', '.claude/skills/review-code/scripts/check.sh'],
  );
  for (const file of skill.files) assert.match(file.sha256, /^[0-9a-f]{64}$/);
  const specific2 = skill.harnessSpecific as { path: string; frontmatter: Record<string, string> };
  assert.equal(specific2.path, '.claude/skills/review-code/SKILL.md');
  assert.deepEqual(specific2.frontmatter, { 'x-team': 'meridian' });
  assert.equal(JSON.stringify(skill.harnessSpecific).includes('# Review code'), false);
});

test('Claude Code import: command, agent and instruction map their fields', () => {
  const command = (manifestsOfKind('hub-command/1') as HubCommand[]).find((entry) => entry.name === 'summarize')!;
  assert.equal(command.name, 'summarize');
  assert.equal(command.description, 'Summarize the current change set');
  // argument-hint is a prompt hint, not the arguments field.
  assert.equal(command.arguments, undefined);
  assert.equal((command.harnessSpecific as { argumentHint?: string }).argumentHint, '[scope]');

  const [agent] = manifestsOfKind('hub-agent/1') as HubAgent[];
  assert.equal(agent.name, 'test-reviewer');
  assert.equal(agent.description, 'Review synthetic test results');
  assert.deepEqual(agent.tools, ['Read', 'Grep']);
  assert.equal(agent.model, 'scripted-model');

  const [instruction] = (manifestsOfKind('hub-instruction/1') as HubInstruction[]).filter(
    (entry) => entry.fileName === 'CLAUDE.md',
  );
  // scope is not derivable from a Claude Code instruction file: left empty.
  assert.equal(instruction.scope, undefined);
  assert.deepEqual(instruction.applies, []);
  assert.equal(instruction.fileName, 'CLAUDE.md');
});

test('Claude Code import: multiple hooks become individual manifests without invented order', () => {
  const hooks = (manifestsOfKind('hub-hook/1') as HubHook[]).filter(
    (hook) => (hook.harnessSpecific as { filePath: string }).filePath === '.claude/settings.json',
  );
  assert.equal(hooks.length, 3);
  assert.deepEqual(hooks.map((hook) => hook.event), ['PreToolUse', 'PostToolUse', 'PostToolUse']);
  assert.deepEqual(
    hooks.map((hook) => hook.handler),
    ['sh scripts/check-command.sh', 'sh scripts/format-check.sh', 'sh scripts/lint-check.sh'],
  );
  for (const hook of hooks) {
    assert.equal(hook.language, 'shell');
    // Harness hooks run in parallel and their determinism is not derivable:
    // both fields stay empty rather than being invented.
    assert.equal(hook.order, undefined);
    assert.equal(hook.deterministic, undefined);
    assert.deepEqual(hook.files.map((file) => file.path), ['.claude/settings.json']);
  }
  const specific = hooks.map((hook) => hook.harnessSpecific as { matcher?: string; eventIndex: number; groupIndex: number; entryIndex: number; entryKeys: string[] });
  assert.equal(specific[0].matcher, 'Bash');
  assert.deepEqual(
    specific.map((entry) => [entry.eventIndex, entry.groupIndex, entry.entryIndex]),
    [[0, 0, 0], [1, 0, 0], [1, 0, 1]],
  );
  // Extra entry keys are disclosed by name only; values stay in the file.
  assert.deepEqual(specific[2].entryKeys, ['type', 'command', 'timeout']);
  // One HOOK_EVENT_UNMAPPED per harness event, not per command.
  const unmapped = imported.warnings.filter((warning) => warning.code === 'HOOK_EVENT_UNMAPPED');
  assert.equal(unmapped.length, 3);
  assert.ok(unmapped[0].detail.startsWith('hooks.PreToolUse'));
  assert.ok(unmapped[1].detail.startsWith('hooks.PostToolUse'));
  assert.ok(unmapped[2].detail.startsWith('hooks.SessionStart'));
});

test('Claude Code import: stdio and http MCP servers keep names and shapes without secrets', () => {
  const providers = manifestsOfKind('hub-provider/1') as HubProvider[];
  assert.equal(providers.length, 2);

  const docs = providers.find((provider) => provider.name === 'docs-lookup')!;
  assert.equal(docs.transport, 'stdio');
  assert.deepEqual(docs.credentials, ['DOCS_API_KEY', 'DOCS_REGION']);
  // Not derivable from a static config file: provides, credentialMode.
  assert.equal(docs.provides, undefined);
  assert.equal(docs.credentialMode, undefined);
  assert.deepEqual(docs.reads, []);
  assert.deepEqual(docs.writes, []);
  // The shape is key names only: values never enter the manifest.
  assert.deepEqual(docs.harnessSpecific.shape, { command: true, args: true, env: ['DOCS_API_KEY', 'DOCS_REGION'] });

  const knowledge = providers.find((provider) => provider.name === 'team-knowledge')!;
  assert.equal(knowledge.transport, 'streamable-http');
  assert.deepEqual(knowledge.credentials, ['Authorization']);
  assert.deepEqual(knowledge.harnessSpecific.shape, { type: true, url: true, headers: ['Authorization'] });

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

test('Claude Code import: ws transport is left empty with a warning', () => {
  const result = importFrom('claude-code', {
    '.mcp.json': JSON.stringify({ mcpServers: { realtime: { type: 'ws', url: 'ws://192.0.2.11:9001' } } }),
  });
  const [provider] = result.manifests as HubProvider[];
  assert.equal(provider.transport, undefined);
  assert.deepEqual(
    result.warnings.map((warning) => warning.code).sort(),
    ['CANONICAL_NORMALIZATION', 'PROVIDER_TRANSPORT_UNKNOWN', 'PROVIDER_VALUES_STRIPPED'],
  );
});

test('Claude Code import: url without type, or command and url together, skips the entry', () => {
  const result = importFrom('claude-code', {
    '.mcp.json': JSON.stringify({
      mcpServers: {
        ambiguous: { url: 'https://mcp.example.com/x' },
        conflict: { command: 'npx', url: 'https://mcp.example.com/y' },
        ok: { command: 'node', args: ['server.js'] },
      },
    }),
  });
  assert.deepEqual(
    result.manifests.map((manifest) => (manifest as HubProvider).name),
    ['ok'],
  );
  assert.deepEqual(
    result.warnings.map((warning) => warning.code).sort(),
    ['CANONICAL_NORMALIZATION', 'PROVIDER_ENTRY_INVALID', 'PROVIDER_ENTRY_INVALID'],
  );
  // Details name the entry, never the endpoint values.
  const details = result.warnings.map((warning) => warning.detail).join('\n');
  assert.equal(details.includes('mcp.example.com'), false);
  assert.ok(details.includes('ambiguous'));
  assert.ok(details.includes('conflict'));
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
  // The shape discloses key names only; command and args values never enter.
  assert.deepEqual(provider.harnessSpecific.shape, { command: true, args: true });
  assert.deepEqual(
    result.warnings.map((warning) => warning.code).sort(),
    ['CANONICAL_NORMALIZATION', 'PROVIDER_ARG_REDACTED', 'PROVIDER_COMMAND_ABSOLUTE'],
  );
  const serialized = JSON.stringify(result.manifests);
  for (const leaked of ['/opt/tools/bin/server', '/srv/data']) {
    assert.equal(serialized.includes(leaked), false, `${leaked} leaked`);
  }
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

test('Claude Code export: hub-tool/1 no longer exists as a manifest kind', () => {
  const tool = {
    kind: 'hub-tool/1',
    name: 'docs.lookup',
    sourceHarness: 'claude-code',
    knownCompatible: [],
    files: [],
    harnessSpecific: {},
  } as unknown as HubManifest;
  const result = exportTo('claude-code', [tool], {});
  assert.deepEqual(result.files, {});
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ['MANIFEST_INVALID'],
  );
});

test('Claude Code export: source files missing from the file table are reported', () => {
  const result = exportTo('claude-code', imported.manifests, {});
  // Hooks still export with just {type, command}; providers cannot be
  // rebuilt without the original entries, so no .mcp.json is written.
  assert.deepEqual(Object.keys(result.files).sort(), ['.claude/settings.json', '.claude/settings.local.json']);
  const settings = JSON.parse(result.files['.claude/settings.json'] as string) as { hooks: { PostToolUse: Array<{ hooks: unknown[] }> } };
  assert.deepEqual(settings.hooks.PostToolUse[0].hooks[0], { type: 'command', command: 'sh scripts/format-check.sh' });
  // 9 markdown files + 2 hooks files + 2 provider entries.
  assert.equal(
    result.warnings.filter((warning) => warning.code === 'SOURCE_FILE_MISSING').length,
    13,
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

test('Sanitization: env, headers and oauth values are stripped, only key names remain', () => {
  const result = importFrom('claude-code', {
    '.mcp.json': JSON.stringify({
      mcpServers: {
        svc: {
          command: 'npx',
          env: { API_KEY: 'super-secret-value' },
          oauth: { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' },
        },
      },
    }),
  });
  const [provider] = result.manifests as HubProvider[];
  assert.deepEqual(provider.harnessSpecific.shape, {
    command: true,
    env: ['API_KEY'],
    oauth: ['clientId', 'clientSecret'],
  });
  assert.deepEqual(provider.credentials, ['API_KEY']);
  const serialized = JSON.stringify(result.manifests);
  for (const secret of ['super-secret-value', 'synthetic-client', 'synthetic-secret']) {
    assert.equal(serialized.includes(secret), false, `${secret} leaked`);
  }
  // Warning details carry key names only, never values.
  const allDetails = result.warnings.map((warning) => warning.detail).join('\n');
  for (const secret of ['super-secret-value', 'synthetic-client', 'synthetic-secret']) {
    assert.equal(allDetails.includes(secret), false, `${secret} leaked into a warning detail`);
  }
});

test('Sanitization: cwd is dropped from MCP entries with a warning', () => {
  const result = importFrom('claude-code', {
    '.mcp.json': JSON.stringify({ mcpServers: { svc: { command: 'node', cwd: '/srv/app' } } }),
  });
  const [provider] = result.manifests as HubProvider[];
  assert.deepEqual(provider.harnessSpecific.shape, { command: true });
  assert.deepEqual(
    result.warnings.map((warning) => warning.code).sort(),
    ['CANONICAL_NORMALIZATION', 'PROVIDER_CWD_DROPPED'],
  );
  assert.equal(JSON.stringify(result.manifests).includes('/srv/app'), false);
});

test('Sanitization: args redaction catches endpoints and paths embedded in long strings', () => {
  const input = {
    '.mcp.json': JSON.stringify({
      mcpServers: {
        svc: {
          command: 'node',
          args: [
            'serve',
            '--root=/srv/data',
            '--config=https://192.0.2.5/x.json',
            'see http://192.0.2.9/docs for details',
            '~/bin/tool',
            '-k=short',
            '/abs/path',
            'plain',
          ],
        },
      },
    }),
  };
  const result = importFrom('claude-code', input);
  const [provider] = result.manifests as HubProvider[];
  // Args values never enter the manifest; the shape discloses the key only.
  assert.deepEqual(provider.harnessSpecific.shape, { command: true, args: true });
  assert.equal(result.warnings.filter((warning) => warning.code === 'PROVIDER_ARG_REDACTED').length, 6);
  const serialized = JSON.stringify(result.manifests);
  for (const leaked of ['/srv/data', '192.0.2.5', '192.0.2.9', '~/bin/tool', '/abs/path', 'short']) {
    assert.equal(serialized.includes(leaked), false, `${leaked} leaked`);
  }
  // Export re-applies the rules against the original file bytes.
  const exported = exportTo('claude-code', result.manifests, input);
  const mcp = JSON.parse(exported.files['.mcp.json'] as string) as { mcpServers: { svc: { args: string[] } } };
  assert.deepEqual(mcp.mcpServers.svc.args, [
    'serve',
    '[redacted]',
    '[redacted]',
    '[redacted]',
    '[redacted]',
    '[redacted]',
    '[redacted]',
    'plain',
  ]);
});

test('Sanitization: hook commands are tokenized with shell quoting, then redacted per word', () => {
  const input = {
    '.claude/settings.json': `${JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'sh /opt/team/hooks/check.sh --flag' }] },
          { hooks: [{ type: 'command', command: 'node --config=~/hooks/c.json scripts/run.js' }] },
          { hooks: [{ type: 'command', command: '/usr/bin/env bash scripts/x.sh' }] },
        ],
      },
    }, null, 2)}\n`,
  };
  const result = importFrom('claude-code', input);
  const hooks = result.manifests as HubHook[];
  // Path words are redacted per the args rules; the program word is reduced
  // to its basename.
  assert.equal(hooks[0].handler, 'sh [redacted] --flag');
  assert.equal(hooks[1].handler, 'node [redacted] scripts/run.js');
  assert.equal(hooks[2].handler, 'env bash scripts/x.sh');
  assert.equal(result.warnings.filter((warning) => warning.code === 'HOOK_ARG_REDACTED').length, 2);
  assert.equal(result.warnings.filter((warning) => warning.code === 'HOOK_COMMAND_PATH').length, 1);
  const serialized = JSON.stringify(result.manifests);
  assert.equal(serialized.includes('/opt/team'), false);
  assert.equal(serialized.includes('~/hooks'), false);
  assert.equal(serialized.includes('/usr/bin'), false);
});

test('Sanitization: Bearer tokens and URLs inside hook commands never enter manifests', () => {
  const input = {
    '.claude/settings.json': `${JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: 'sh notify.sh Bearer synthetic-token-value' },
              { type: 'command', command: 'sh -c "Authorization: Bearer synthetic-token" --verbose' },
              { type: 'command', command: 'curl http://192.0.2.40/hook -d done' },
            ],
          },
        ],
      },
    }, null, 2)}\n`,
  };
  const result = importFrom('claude-code', input);
  const handlers = (result.manifests as HubHook[]).map((hook) => hook.handler);
  assert.deepEqual(handlers, ['sh notify.sh Bearer [redacted]', 'sh -c [redacted] --verbose', 'curl [redacted] -d done']);
  const serialized = JSON.stringify(result.manifests);
  assert.equal(serialized.includes('synthetic-token'), false);
  assert.equal(serialized.includes('192.0.2.40'), false);
  const details = result.warnings.map((warning) => warning.detail).join('\n');
  assert.equal(details.includes('synthetic-token'), false);
});

test('Sanitization: unknown config keys (headersHelper and friends) disclose names only', () => {
  const result = importFrom('claude-code', {
    '.mcp.json': JSON.stringify({
      mcpServers: {
        svc: { type: 'http', url: 'https://mcp.example.com/x', headersHelper: 'fetch-token --secret=abc' },
      },
    }),
  });
  const [provider] = result.manifests as HubProvider[];
  assert.deepEqual(provider.harnessSpecific.shape, { type: true, url: true, headersHelper: true });
  const serialized = JSON.stringify(result.manifests);
  assert.equal(serialized.includes('fetch-token'), false);
  assert.equal(serialized.includes('secret=abc'), false);
});

test('Claude Code import: type streamable-http is an alias of http', () => {
  const result = importFrom('claude-code', {
    '.mcp.json': JSON.stringify({ mcpServers: { svc: { type: 'streamable-http', url: 'https://mcp.example.com/x' } } }),
  });
  const [provider] = result.manifests as HubProvider[];
  assert.equal(provider.transport, 'streamable-http');
  assert.equal(
    result.warnings.some((warning) => warning.code === 'PROVIDER_TRANSPORT_UNKNOWN' || warning.code === 'PROVIDER_ENTRY_INVALID'),
    false,
  );
});

test('Claude Code import: subdirectory rules and agents are discovered', () => {
  const result = importFrom('claude-code', {
    '.claude/rules/deep/rule.md': '---\npaths: packs/**\n---\n\nDeep rule.\n',
    '.claude/agents/nested/helper.md': '---\nname: helper\ndescription: Nested agent\n---\n\nBody.\n',
  });
  const [instruction] = result.manifests.filter((manifest) => manifest.kind === 'hub-instruction/1') as HubInstruction[];
  assert.equal(instruction.fileName, 'rule.md');
  assert.deepEqual(instruction.applies, ['packs/**']);
  const [agent] = result.manifests.filter((manifest) => manifest.kind === 'hub-agent/1') as HubAgent[];
  // The subdirectory is a location, not part of the identity.
  assert.equal(agent.name, 'helper');
  assert.deepEqual(result.warnings, []);
});

test('Sanitization: frontmatter skip warnings carry line numbers, not content', () => {
  const result = importFrom('claude-code', {
    '.claude/agents/x.md': '---\nname: x\na line with SECRET-WORD inside\n---\n\nBody.\n',
  });
  const [warning] = result.warnings.filter((entry) => entry.code === 'FRONTMATTER_LINE_SKIPPED');
  assert.ok(warning.detail.includes('line 3'), warning.detail);
  assert.equal(warning.detail.includes('SECRET-WORD'), false);
});

test('Empty config files are reported, not silently ignored', () => {
  for (const [path, text] of [
    ['.claude/settings.json', '{}'],
    ['.claude/settings.json', '   \n'],
    ['.mcp.json', '{}'],
    ['.mcp.json', ''],
  ]) {
    const result = importFrom('claude-code', { [path]: text });
    assert.deepEqual(result.manifests, []);
    assert.deepEqual(
      result.warnings.map((warning) => warning.code),
      ['EMPTY_CONFIG'],
      `${path} ${JSON.stringify(text)}`,
    );
  }
});

test('Claude Code import: non-command hook entries are skipped without copying content', () => {
  const result = importFrom('claude-code', {
    '.claude/settings.json': `${JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'http', url: 'http://192.0.2.30/hook' },
              { type: 'prompt', prompt: 'Should this secret-containing prompt text run?' },
              { type: 'command', command: 'sh ok.sh' },
            ],
          },
        ],
      },
    }, null, 2)}\n`,
  });
  assert.equal(result.manifests.length, 1);
  const skipped = result.warnings.filter((warning) => warning.code === 'HOOK_ENTRY_SKIPPED');
  assert.equal(skipped.length, 2);
  assert.ok(skipped[0].detail.includes('"http"'));
  assert.ok(skipped[1].detail.includes('"prompt"'));
  const details = skipped.map((warning) => warning.detail).join('\n');
  assert.equal(details.includes('192.0.2.30'), false);
  assert.equal(details.includes('secret-containing'), false);
});
