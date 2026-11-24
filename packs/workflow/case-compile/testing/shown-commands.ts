import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACK_DIR } from '../pack-files.ts';

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(PACK_DIR, path), 'utf8'));
const LOCAL_TOOLS = new Set(['node', 'circle-hub']);

function sampleFiles(): string[] {
  return ['positive', 'negative'].flatMap((kind) => readdirSync(join(PACK_DIR, 'samples', kind)).filter((name) => name.endsWith('.json')).map((name) => `samples/${kind}/${name}`));
}

function syntheticFixtures(): { heads: Set<string>; deviceCalls: Set<string> } {
  const heads = new Set<string>(), deviceCalls = new Set<string>();
  const profiles: unknown[] = [];
  for (const path of sampleFiles()) {
    const subject = (readJson(path) as Row).subject;
    if (!isRow(subject)) continue;
    const catalog = subject.command_catalog;
    if (isRow(catalog) && Array.isArray(catalog.entries)) for (const entry of catalog.entries) if (isRow(entry) && Array.isArray(entry.words) && typeof entry.words[0] === 'string') heads.add(entry.words[0]);
    profiles.push(subject.profile);
  }
  for (const name of readdirSync(join(PACK_DIR, 'examples'))) {
    if (name.endsWith('.xml')) for (const item of readFileSync(join(PACK_DIR, 'examples', name), 'utf8').matchAll(/<item name="([^"]+)"/g)) heads.add(item[1]!.split(' ')[0]!);
    if (name.startsWith('runtime-profile') && name.endsWith('.json')) profiles.push(readJson(`examples/${name}`));
  }
  for (const profile of profiles) {
    if (!isRow(profile) || !Array.isArray(profile.allowed)) continue;
    for (const row of profile.allowed) if (isRow(row) && isRow(row.parameters) && Object.values(row.parameters).includes('device_cli')) deviceCalls.add(`${row.object}.${row.method}`);
  }
  return { heads, deviceCalls };
}

export const SYNTHETIC = syntheticFixtures();

function jsonValues(text: string): unknown[] {
  try { return [JSON.parse(text)]; } catch { /* not one JSON document: read its JSON lines */ }
  const values: unknown[] = [];
  for (const line of text.split('\n')) {
    if (!/^\s*[[{]/.test(line)) continue;
    try { values.push(JSON.parse(line)); } catch { continue; }
  }
  return values;
}

export function shownCommands(text: string): string[] {
  const lines: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!isRow(value)) return;
    if (SYNTHETIC.deviceCalls.has(`${value.object}.${value.method}`) && Array.isArray(value.args) && typeof value.args[0] === 'string') lines.push(value.args[0]);
    Object.values(value).forEach(visit);
  };
  jsonValues(text).forEach(visit);
  for (const span of text.matchAll(/`([^`\n]+)`/g)) if (/^[a-z][a-z0-9_-]*\s/.test(span[1]!) && !LOCAL_TOOLS.has(span[1]!.split(/\s/)[0]!)) lines.push(span[1]!);
  return lines;
}

export function foreignCommands(text: string): string[] {
  return shownCommands(text).filter((line) => !SYNTHETIC.heads.has(line.trim().split(/\s+/)[0]!));
}
