import type { VirtualFiles } from './neutral.ts';

// Shared virtual-file helpers for the adapters. Text files stay strings;
// non-text bytes are carried as base64 so a round trip is byte-exact either
// way.

export type StoredFile = string | { base64: string };

export function toText(value: string | Uint8Array): string {
  return typeof value === 'string' ? value : new TextDecoder().decode(value);
}

export function storeFile(value: string | Uint8Array): StoredFile {
  return typeof value === 'string' ? value : { base64: Buffer.from(value).toString('base64') };
}

export function readStored(stored: StoredFile): string | Uint8Array {
  return typeof stored === 'string' ? stored : new Uint8Array(Buffer.from(stored.base64, 'base64'));
}

export function storedText(stored: StoredFile): string {
  return toText(readStored(stored));
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
