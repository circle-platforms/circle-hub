import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { VirtualFiles } from '../../../packages/harness-adapters/neutral.ts';

export const claudeCodeFixtureRoot = join(import.meta.dirname, 'claude-code');
export const codexFixtureRoot = join(import.meta.dirname, 'codex');

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
