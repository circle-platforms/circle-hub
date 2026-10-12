// Shared helpers for the apv-mindmap-compile scripts. Node built-ins only, so the same
// scripts run in a Circle workspace and on the server without installing anything.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Keys in a fixed order, so the same document always hashes the same.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value ?? null);
}

export class CompileError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

// JSON with an 18-digit autoid written as a number would lose digits in JSON.parse; the
// reviver takes such numbers from the source text instead.
export function parseJson(text) {
  return JSON.parse(text, (key, value, context) =>
    typeof value === 'number' && key === 'autoid' && context?.source
      ? context.source
      : value,
  );
}

export function readJson(path) {
  try {
    return parseJson(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new CompileError('json_unreadable', `${path}: ${error.message}`);
  }
}

// Written to a temporary file and renamed, so a reader never sees half a file.
export function writeJson(path, value) {
  writeBytes(path, Buffer.from(JSON.stringify(value, null, 2) + '\n'));
}
export function writeBytes(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, bytes);
  renameSync(temporary, path);
}

// Whitespace runs become one space; used to compare a field with a source atom.
export const normalize = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

export const AUTOID = /^\d{18}$/;
export const SENTINEL_AUTOID = '999999999999999';

// Numbered step prefixes as the source writes them: 1. 1、 1: 1： 1) 1） and [1] forms.
const NUMBERED = /^[ \t]*\[?([0-9]+)\]?[.、:：)）][ \t]*/gm;
export function numberedAtoms(text) {
  const source = String(text ?? '');
  const matches = [...source.matchAll(NUMBERED)];
  const atoms = [];
  matches.forEach((match, index) => {
    const end = index + 1 < matches.length ? matches[index + 1].index : source.length;
    const atom = source.slice(match.index, end).trim();
    if (atom) atoms.push([match[1], atom]);
  });
  return atoms;
}
export function actionAtoms(text) {
  const source = String(text ?? '');
  const numbered = numberedAtoms(source);
  if (numbered.length) return numbered;
  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1) return lines.map((line, index) => [String(index + 1), line]);
  return source.trim() ? [['1', source.trim()]] : [];
}
const LABELED = /^[ \t]*\[([A-Za-z0-9_-]+)\][ \t]*/gm;
export function labeledAtoms(text) {
  const source = String(text ?? '');
  const matches = [...source.matchAll(LABELED)];
  const atoms = new Map();
  matches.forEach((match, index) => {
    const end = index + 1 < matches.length ? matches[index + 1].index : source.length;
    const atom = source.slice(match.index, end).trim();
    if (atom) atoms.set(match[1].toLowerCase(), atom);
  });
  return atoms;
}
export const checkRefs = (text) =>
  [...String(text ?? '').matchAll(/\[([A-Za-z0-9_-]+)\]/g)].map((m) => m[1].toLowerCase());
