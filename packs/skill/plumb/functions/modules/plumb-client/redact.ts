import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/giu;
const PLUMB_KEY_PATTERN = /\bplumb_sk_[A-Za-z0-9_-]{8,}\b/gu;
const CLAIM_HEADER_PATTERN = /(x-claim-code\s*[:=]\s*)([^\s,;]+)/giu;
const SECRET_HEADERS = new Set(['authorization', 'x-claim-code', 'proxy-authorization', 'cookie', 'set-cookie']);
const CJK_PATTERN = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/gu;

export function redactSecret(text: string, extraSecrets: readonly (string | undefined)[] = []): string {
  let out = text
    .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
    .replace(PLUMB_KEY_PATTERN, 'plumb_sk_[REDACTED]')
    .replace(CLAIM_HEADER_PATTERN, '$1[REDACTED]');
  for (const secret of extraSecrets) {
    if (typeof secret !== 'string' || secret.length < 6) continue;
    out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

export function redactHeaders(headers: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key] = SECRET_HEADERS.has(key.toLowerCase()) ? '[REDACTED]' : redactSecret(value);
  }
  return out;
}

export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const encode = (node: unknown): unknown => {
    if (node === null || typeof node !== 'object') return node;
    if (seen.has(node)) throw new Error('参数无效：请求载荷包含循环引用。请移除循环引用后重试。');
    seen.add(node);
    try {
      if (Array.isArray(node)) return node.map((item) => encode(item));
      const record = node as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) {
        if (record[key] === undefined) continue;
        out[key] = encode(record[key]);
      }
      return out;
    } finally {
      seen.delete(node);
    }
  };
  return JSON.stringify(encode(value));
}

export function sha256Hex(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex');
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjkMatches = text.match(CJK_PATTERN);
  const cjk = cjkMatches ? cjkMatches.length : 0;
  const nonCjk = text.length - cjk;
  return Math.ceil(cjk + nonCjk / 3.5);
}

export async function writeNewPrivateFile(filePath: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, { flag: 'wx', mode: 0o600 });
}

export async function writePrivateFile(filePath: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const handle = await open(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}

export async function appendPrivateLine(filePath: string, line: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const handle = await open(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(line.endsWith('\n') ? line : `${line}\n`, 'utf8');
  } finally {
    await handle.close();
  }
}
