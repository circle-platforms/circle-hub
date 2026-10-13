import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { VirtualFiles } from '../../../packages/harness-adapters/neutral.ts';

export const claudeCodeFixtureRoot = join(import.meta.dirname, 'claude-code');
export const codexFixtureRoot = join(import.meta.dirname, 'codex');
export const opencodeFixtureRoot = join(import.meta.dirname, 'opencode');
export const geminiFixtureRoot = join(import.meta.dirname, 'gemini');
export const cursorFixtureRoot = join(import.meta.dirname, 'cursor');

// `**/.claude/settings.local.json` is covered by the global gitignore (the
// name is machine-local by convention), so this fixture entry is synthesized
// at load time instead of being committed as a real file. The virtual file
// table key is what the adapter sees.
const CLAUDE_SETTINGS_LOCAL = `${JSON.stringify(
  {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'sh scripts/boot-check.sh' }] }],
    },
  },
  null,
  2,
)}\n`;

export async function loadVirtualFiles(root: string): Promise<VirtualFiles> {
  const files: VirtualFiles = {};
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files[relative(root, full).split(sep).join('/')] = await readFile(full, 'utf8');
    }
  }
  await walk(root);
  if (root === claudeCodeFixtureRoot) files['.claude/settings.local.json'] = CLAUDE_SETTINGS_LOCAL;
  return files;
}

export function manifestStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(manifestStrings);
  if (value !== null && typeof value === 'object') {
    return Object.values(value).flatMap(manifestStrings);
  }
  return [];
}
