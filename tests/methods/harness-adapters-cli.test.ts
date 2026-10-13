import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importFrom } from '../../packages/harness-adapters/index.ts';
import { runCli } from '../../packages/harness-adapters/cli.ts';
import { claudeCodeFixtureRoot, loadVirtualFiles } from '../fixtures/harness/load.ts';

// The synthesized .claude/settings.local.json fixture entry lives only in
// the virtual table (the name is globally gitignored), so the CLI — which
// reads the real directory — sees one hook fewer.
const onDiskFixture = await loadVirtualFiles(claudeCodeFixtureRoot);
delete onDiskFixture['.claude/settings.local.json'];
const expected = importFrom('claude-code', onDiskFixture);

test('CLI import: a real directory becomes neutral manifests as JSON', async () => {
  const result = await runCli(['import', claudeCodeFixtureRoot, '--from', 'claude-code']);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const parsed = JSON.parse(result.stdout) as { manifests: unknown[]; warnings: unknown[] };
  assert.deepEqual(parsed.manifests, JSON.parse(JSON.stringify(expected.manifests)));
  assert.deepEqual(parsed.warnings, expected.warnings);
});

test('CLI export: manifests plus the original directory produce byte-identical files', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'circle-cli-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const manifestsFile = join(tmp, 'manifests.json');
  await writeFile(manifestsFile, JSON.stringify(expected.manifests));
  const result = await runCli(['export', manifestsFile, '--to', 'claude-code', '--dir', claudeCodeFixtureRoot]);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout) as { files: Record<string, string>; warnings: { code: string }[] };
  assert.equal(
    parsed.files['.claude/skills/review-code/SKILL.md'],
    onDiskFixture['.claude/skills/review-code/SKILL.md'],
  );
  assert.equal(parsed.files['CLAUDE.md'], onDiskFixture['CLAUDE.md']);
  const mcp = JSON.parse(parsed.files['.mcp.json']) as { mcpServers: Record<string, { env?: Record<string, string>; url?: string }> };
  assert.deepEqual(mcp.mcpServers['docs-lookup'].env, { DOCS_API_KEY: '[redacted]', DOCS_REGION: '[redacted]' });
  assert.ok(parsed.warnings.some((warning) => warning.code === 'SECRET_PLACEHOLDER'));
});

test('CLI export: without --dir the original bytes are missing and reported', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'circle-cli-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const manifestsFile = join(tmp, 'manifests.json');
  await writeFile(manifestsFile, JSON.stringify(expected.manifests));
  const result = await runCli(['export', manifestsFile, '--to', 'claude-code']);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout) as { files: Record<string, string>; warnings: { code: string }[] };
  assert.equal(parsed.files['.claude/skills/review-code/SKILL.md'], undefined);
  assert.ok(parsed.warnings.some((warning) => warning.code === 'SOURCE_FILE_MISSING'));
});

test('CLI: usage errors exit 1 with a message, never a stack or a hang', async () => {
  for (const argv of [
    [] as string[],
    ['import'],
    ['import', claudeCodeFixtureRoot, '--from', 'not-a-harness'],
    ['export', '/nonexistent/manifests.json', '--to', 'claude-code'],
  ]) {
    const result = await runCli(argv);
    assert.equal(result.status, 1, argv.join(' '));
    assert.ok(result.stderr.length > 0);
    assert.equal(result.stdout, '');
  }
});
