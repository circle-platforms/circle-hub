// Reader for the owner's environment file (KEY = value lines, commented alternatives grouped under section markers).
// The owner's file holds secrets: values leave this module only through pick(), and describe() prints names and lengths only.
// Errors never include file content.
import { readFileSync } from 'node:fs';

export interface EnvEntry {
  key: string;
  value: string;
  commented: boolean;
  section: string;
  line: number;
}

const SECTION = /^\s*#\s*-{2,}\s*([^-].*?)\s*-*\s*$/;
const ENTRY = /^\s*(#\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

export function parseEnvText(text: string): EnvEntry[] {
  const entries: EnvEntry[] = [];
  let section = '';
  text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .forEach((raw, index) => {
      const mark = SECTION.exec(raw);
      if (mark) {
        section = mark[1];
        return;
      }
      const m = ENTRY.exec(raw);
      if (!m) return;
      entries.push({ key: m[2], value: m[3].replace(/^(["'])(.*)\1$/, '$2'), commented: Boolean(m[1]), section, line: index + 1 });
    });
  return entries;
}

export function readEnvFile(path: string): EnvEntry[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error('environment file is not readable');
  }
  return parseEnvText(text);
}

export interface PickOptions {
  /** Section marker must contain this text (case-insensitive). */
  section?: string;
  /** true: only commented alternatives, false: only active lines, undefined: either (active preferred). */
  commented?: boolean;
}

export function pick(entries: EnvEntry[], key: string, options: PickOptions = {}): EnvEntry | undefined {
  const matches = entries.filter(
    (e) =>
      e.key === key &&
      e.value !== '' &&
      (options.commented === undefined || e.commented === options.commented) &&
      (options.section === undefined || e.section.toLowerCase().includes(options.section.toLowerCase())),
  );
  return matches.find((e) => !e.commented) ?? matches[0];
}

/** One line per requested key: presence and length, never the value. */
export function describe(entries: EnvEntry[], keys: string[], options: PickOptions = {}): string[] {
  return keys.map((k) => {
    const e = pick(entries, k, options);
    return e ? `${k}: found, length ${e.value.length}${e.commented ? ' (commented alternative)' : ''}` : `${k}: absent`;
  });
}
