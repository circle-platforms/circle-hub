import { createHash } from 'node:crypto';
import type { VirtualFiles } from './neutral.ts';

// Shared virtual-file helpers for the adapters.

export function toText(value: string | Uint8Array): string {
  return typeof value === 'string' ? value : new TextDecoder().decode(value);
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(typeof value === 'string' ? value : Buffer.from(value)).digest('hex');
}

// Structural equality for parsed frontmatter/config values: arrays ordered,
// objects unordered.
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((key) => key in (b as object) && deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
    );
  }
  return false;
}

export function normalizePath(path: string): string {
  let result = path.replace(/\\/g, '/');
  while (result.startsWith('./')) result = result.slice(2);
  return result;
}

export function baseName(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

export function dirName(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function normalizedFiles(files: VirtualFiles): VirtualFiles {
  const result: VirtualFiles = {};
  for (const [path, value] of Object.entries(files)) result[normalizePath(path)] = value;
  return result;
}
