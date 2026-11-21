// Content-addressed disk cache for idempotent Plumb inference calls.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Hex, stableStringify, writeNewPrivateFile } from './redact.ts';
import type { PlumbAnyJudgeResponse } from './types.ts';

const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const CACHE_SCHEMA = 'plumb-cache-entry@1';

interface CacheEnvelope {
  schema: typeof CACHE_SCHEMA;
  created_at: string;
  requested_model: string;
  response: PlumbAnyJudgeResponse;
}

export function buildCacheKey(params: {
  endpoint: string;
  baseOrigin: string;
  model: string;
  request: unknown;
}): string {
  return sha256Hex(
    stableStringify({
      schema: 'plumb-cache-key@1',
      endpoint: params.endpoint,
      baseOrigin: params.baseOrigin,
      model: params.model,
      request: params.request,
    }),
  );
}

function isValidCachedJudge(value: unknown, expectedModel: string): value is CacheEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.schema !== CACHE_SCHEMA) return false;
  if (typeof record.requested_model !== 'string' || record.requested_model !== expectedModel) return false;
  if (typeof record.response !== 'object' || record.response === null || Array.isArray(record.response)) return false;
  const response = record.response as Record<string, unknown>;
  if (response.status !== '未确认' || response.decided_by !== '模型') return false;
  if (typeof response.model_version !== 'string' || response.model_version.trim() === '') return false;
  return true;
}

export class PlumbDiskCache {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private pathFor(key: string): string {
    if (!/^[0-9a-f]{64}$/u.test(key)) {
      throw new Error('参数无效：缓存摘要格式非法。请提供 64 位小写十六进制 SHA-256。');
    }
    return join(this.dir, `${key}.json`);
  }

  async get(key: string, expectedModel: string): Promise<PlumbAnyJudgeResponse | null> {
    const filePath = this.pathFor(key);
    let handle;
    try {
      handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_CACHE_BYTES) return null;
      const text = await handle.readFile({ encoding: 'utf8' });
      const parsed = JSON.parse(text) as unknown;
      if (!isValidCachedJudge(parsed, expectedModel)) return null;
      return { ...parsed.response, cache_hit: true };
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async put(key: string, requestedModel: string, response: PlumbAnyJudgeResponse): Promise<void> {
    const filePath = this.pathFor(key);
    const envelope: CacheEnvelope = {
      schema: CACHE_SCHEMA,
      created_at: new Date().toISOString(),
      requested_model: requestedModel,
      response: { ...response, cache_hit: false },
    };
    try {
      await writeNewPrivateFile(filePath, `${JSON.stringify(envelope)}\n`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') return;
      throw error;
    }
  }
}
