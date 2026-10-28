import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export class OperationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function need(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new OperationError(code, message);
}

export function errorCode(error: unknown): string {
  return error instanceof OperationError && /^[a-z][a-z0-9_]{0,63}$/.test(error.code) ? error.code : 'internal_error';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  need(isRecord(value), 'invalid_shape', '结构必须是对象');
  const actual = Object.keys(value).sort();
  need(JSON.stringify(actual) === JSON.stringify([...keys].sort()), 'invalid_shape', '结构字段不符合约定');
  return value;
}

export function text(value: unknown, code: string, message: string, max = 65536, empty = false): string {
  need(typeof value === 'string' && value.isWellFormed() && value.length <= max && (empty || value.length > 0), code, message);
  return value;
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().filter(key => row[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
}

export function validSession(value: unknown): string {
  return text(value, 'invalid_session', '会话号格式不对', 512);
}

export function stateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CIRCLE_HOME?.trim() || join(homedir(), '.circle');
  const expanded = configured === '~' ? homedir() : configured.startsWith('~/') || configured.startsWith('~\\') ? join(homedir(), configured.slice(2)) : configured;
  const absolute = resolve(expanded);
  try { return join(realpathSync.native(absolute), 'operation-capture'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return join(absolute, 'operation-capture');
  }
}

export function sessionDirectory(session: string, env?: NodeJS.ProcessEnv): string {
  return join(stateRoot(env), 'sessions', sha256(validSession(session)));
}

export function normalizeHubUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new OperationError('invalid_hub_url', 'Hub 地址格式不对'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  need(url.username === '' && url.password === '' && url.search === '' && url.hash === '', 'invalid_hub_url', 'Hub 地址不能带凭据、查询或片段');
  need(url.protocol === 'https:' || (url.protocol === 'http:' && loopback), 'invalid_hub_url', 'Hub 只用 HTTPS，回环假 Hub 可用 HTTP');
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url;
}

export function splitTextLines(value: string): string[] {
  if (value.length === 0) return [];
  const lines: string[] = [];
  let start = 0;
  for (const match of value.matchAll(/\r\n|\r|\n/g)) {
    lines.push(value.slice(start, match.index));
    start = match.index + match[0].length;
  }
  if (start < value.length) lines.push(value.slice(start));
  return lines;
}
