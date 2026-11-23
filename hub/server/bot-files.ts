import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, readdir, rename, rm, rmdir, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type { ProtocolCode } from '../../contracts/generated/protocol-codes.ts';
import { isSha256 } from '../records/api.ts';
import type { ServerDeps } from './api.ts';
import { authenticateAccessOnly, requireDirectAccessBearer } from './access-auth.ts';
import { sendJson, setCommonHeaders } from './http.ts';

const botError = (code: ProtocolCode, message: string) => ({ code, message });

export const fileLimit = 100 * 1024 * 1024;
export const MAX_MEMBER_BOT_BYTES = 512 * 1024 * 1024;
export const MAX_MEMBER_BOT_FILES = 256;
export const BOT_FILE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const fileDescriptor = z.strictObject({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().min(0).max(fileLimit),
  name: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[^/\\\p{Cc}]+$/u)
    .refine((x) => x !== '.' && x !== '..'),
});
export const botFilesPath = '/api/bot/v1/files/';
export type BotFile = z.infer<typeof fileDescriptor>;

const ownerHash = (owner: string) => createHash('sha256').update(owner).digest('hex');

const folder = (root: string, owner: string, scope: 'files' | 'channel-staging' = 'files') =>
  join(root, 'bot-runtime', scope, ownerHash(owner));

async function verifyFileInDir(dir: string, sha: string, size?: number) {
  if (!isSha256(sha)) return null;
  const handle = await open(join(dir, sha), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) return null;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > fileLimit || (size !== undefined && size !== info.size)) {
      await handle.close();
      return null;
    }
    const digest = createHash('sha256');
    for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) digest.update(chunk);
    if (digest.digest('hex') !== sha) {
      await handle.close();
      return null;
    }
    return { handle, size: info.size };
  } catch {
    await handle.close();
    return null;
  }
}

export async function verifiedBotFile(root: string, owner: string, sha: string, size?: number) {
  return verifyFileInDir(folder(root, owner, 'files'), sha, size);
}

export async function validateBotFiles(root: string, owner: string, files: BotFile[]): Promise<boolean> {
  for (const file of files) {
    const got = await verifiedBotFile(root, owner, file.sha256, file.size);
    if (!got) return false;
    await got.handle.close();
  }
  return true;
}

async function pruneAndMeasureDir(
  dir: string,
  nowMs: number,
  retentionMs: number,
): Promise<{ count: number; bytes: number }> {
  await mkdir(dir, { mode: 0o700, recursive: true });
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  let count = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!isSha256(entry.name)) continue;
    const entryPath = join(dir, entry.name);
    const info = await stat(entryPath).catch(() => null);
    if (!info || !info.isFile()) continue;
    if (nowMs - info.mtimeMs >= retentionMs) {
      await rm(entryPath, { force: true });
      continue;
    }
    count += 1;
    bytes += info.size;
  }
  return { count, bytes };
}

export interface BotFileTransferOptions {
  scope?: 'files' | 'channel-staging';
  now?: () => number;
  maxMemberBytes?: number;
  maxMemberFiles?: number;
  retentionMs?: number;
}

export async function promoteChannelStagedFiles(
  root: string,
  owner: string,
  files: BotFile[],
  options: Omit<BotFileTransferOptions, 'scope'> = {},
): Promise<{ ok: true } | { ok: false; status: number; code: ProtocolCode; message: string }> {
  if (files.length === 0) return { ok: true };
  const stagingDir = folder(root, owner, 'channel-staging');
  const destDir = folder(root, owner, 'files');
  const nowMs = options.now?.() ?? Date.now();
  const maxBytes = options.maxMemberBytes ?? MAX_MEMBER_BOT_BYTES;
  const maxFiles = options.maxMemberFiles ?? MAX_MEMBER_BOT_FILES;
  const retentionMs = options.retentionMs ?? BOT_FILE_RETENTION_MS;

  for (const file of files) {
    const staged = await verifyFileInDir(stagingDir, file.sha256, file.size);
    if (!staged) {
      return { ok: false, status: 400, ...botError('BOT_INVALID_REQUEST', '附件尚未暂存或校验失败') };
    }
    await staged.handle.close();
  }

  const usage = await pruneAndMeasureDir(destDir, nowMs, retentionMs);
  let pendingCount = 0;
  let pendingBytes = 0;
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.sha256)) continue;
    seen.add(file.sha256);
    const existing = await verifyFileInDir(destDir, file.sha256, file.size);
    if (existing) {
      await existing.handle.close();
    } else {
      pendingCount += 1;
      pendingBytes += file.size;
    }
  }
  if (usage.count + pendingCount > maxFiles || usage.bytes + pendingBytes > maxBytes) {
    return { ok: false, status: 413, ...botError('BOT_QUOTA_EXCEEDED', '成员个人助手文件存储配额已满') };
  }

  for (const sha of seen) {
    const stagedPath = join(stagingDir, sha);
    const destPath = join(destDir, sha);
    const expected = files.find((f) => f.sha256 === sha)!;
    const timestamp = new Date(nowMs);
    await utimes(stagedPath, timestamp, timestamp).catch(() => undefined);
    try {
      await link(stagedPath, destPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
        await rename(stagedPath, destPath);
        continue;
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const prior = await verifyFileInDir(destDir, sha, expected.size);
      if (!prior) {
        return { ok: false, status: 409, ...botError('BOT_CONFLICT', '已存在同摘要但内容冲突的文件') };
      }
      await prior.handle.close();
    }
    await rm(stagedPath, { force: true });
  }
  return { ok: true };
}

export async function cleanupBotRuntimeTempFiles(
  dataDir: string,
  options: { maxAgeMs?: number; now?: number } = {},
): Promise<void> {
  if (typeof dataDir !== 'string' || dataDir.length === 0) return;
  const nowMs = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? 0;

  const filesRoot = join(dataDir, 'bot-runtime', 'files');
  const memberDirs = await readdir(filesRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of memberDirs) {
    if (!entry.isDirectory()) continue;
    const memberDir = join(filesRoot, entry.name);
    const items = await readdir(memberDir, { withFileTypes: true }).catch(() => []);
    for (const item of items) {
      if (!item.name.endsWith('.part')) continue;
      await rm(join(memberDir, item.name), { force: true });
    }
  }

  const stagingRoot = join(dataDir, 'bot-runtime', 'channel-staging');
  const stagingDirs = await readdir(stagingRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of stagingDirs) {
    if (!entry.isDirectory()) continue;
    const stagingDir = join(stagingRoot, entry.name);
    const items = await readdir(stagingDir, { withFileTypes: true }).catch(() => []);
    for (const item of items) {
      const fullPath = join(stagingDir, item.name);
      if (item.name.endsWith('.part') || maxAgeMs <= 0) {
        await rm(fullPath, { force: true });
        continue;
      }
      const info = await stat(fullPath).catch(() => null);
      if (!info || nowMs - info.mtimeMs >= maxAgeMs) {
        await rm(fullPath, { force: true });
      }
    }
    const remaining = await readdir(stagingDir).catch(() => []);
    if (remaining.length === 0) await rmdir(stagingDir).catch(() => undefined);
  }
}

export async function transferBotFile(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  owner: string,
  sha: string,
  stillActive: () => Promise<boolean>,
  options: BotFileTransferOptions = {},
): Promise<void> {
  const scope = options.scope ?? 'files';
  if (!isSha256(sha)) {
    req.resume();
    return sendJson(res, 404, botError('BOT_INVALID_REQUEST', '文件摘要无效'));
  }
  if (req.method === 'GET') {
    const file = await verifiedBotFile(root, owner, sha);
    if (!file) {
      return sendJson(res, 404, botError('BOT_CONFLICT', '文件不存在或校验失败'));
    }
    try {
      if (!(await stillActive())) {
        return sendJson(res, 401, botError('BOT_CLIENT_FORBIDDEN', '请重新登录'));
      }
      setCommonHeaders(res);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': file.size,
        'content-disposition': 'attachment',
        etag: '"' + sha + '"',
      });
      await pipeline(file.handle.createReadStream({ start: 0, autoClose: false }), res);
    } finally {
      await file.handle.close();
    }
    return;
  }
  if (req.method !== 'PUT') {
    req.resume();
    return sendJson(res, 405, botError('BOT_INVALID_REQUEST', '只允许 GET 或 PUT'), { allow: 'GET, PUT' });
  }
  const lengthHeader = req.headers['content-length'];
  if (typeof lengthHeader !== 'string' || !/^\d+$/.test(lengthHeader)) {
    req.resume();
    return sendJson(res, 400, botError('BOT_INVALID_REQUEST', '需要有效的文件长度'));
  }
  const declaredLength = Number(lengthHeader);
  if (!Number.isSafeInteger(declaredLength) || declaredLength > fileLimit) {
    req.resume();
    return sendJson(res, 413, botError('BOT_QUOTA_EXCEEDED', '单个文件大小超过 100 MiB 上限'));
  }
  const nowMs = options.now?.() ?? Date.now();
  const maxBytes = options.maxMemberBytes ?? MAX_MEMBER_BOT_BYTES;
  const maxFiles = options.maxMemberFiles ?? MAX_MEMBER_BOT_FILES;
  const retentionMs = options.retentionMs ?? BOT_FILE_RETENTION_MS;
  const dir = folder(root, owner, scope);
  const usage = await pruneAndMeasureDir(dir, nowMs, retentionMs);
  const existing = await verifyFileInDir(dir, sha, declaredLength);
  if (existing) {
    await existing.handle.close();
  } else if (usage.count + 1 > maxFiles || usage.bytes + declaredLength > maxBytes) {
    req.resume();
    return sendJson(res, 413, botError('BOT_QUOTA_EXCEEDED', '成员个人助手文件存储配额已满'));
  }

  const temp = join(dir, randomUUID() + '.part');
  let handle: Awaited<ReturnType<typeof open>> | null = await open(temp, 'wx', 0o600);
  const discardTemp = async () => {
    const active = handle;
    handle = null;
    if (active) await active.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
  };
  try {
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > declaredLength) {
        req.resume();
        await discardTemp();
        return sendJson(res, 413, botError('BOT_QUOTA_EXCEEDED', '上传内容超出声明大小'), { connection: 'close' });
      }
      hash.update(chunk);
      await handle.writeFile(chunk);
    }
    if (size !== declaredLength || hash.digest('hex') !== sha) {
      await discardTemp();
      return sendJson(res, 422, botError('BOT_INVALID_REQUEST', '文件摘要或长度不一致'));
    }
    if (!(await stillActive())) {
      await discardTemp();
      return sendJson(res, 401, botError('BOT_CLIENT_FORBIDDEN', '请重新登录'));
    }
    await handle.sync();
    const timestamp = new Date(nowMs);
    await handle.utimes(timestamp, timestamp);
    try {
      await link(temp, join(dir, sha));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const prior = await verifyFileInDir(dir, sha, size);
      if (!prior) {
        await discardTemp();
        return sendJson(res, 409, botError('BOT_CONFLICT', '已存在同摘要但内容冲突的文件'));
      }
      await prior.handle.close();
    }
    await discardTemp();
    sendJson(res, 200, { sha256: sha, size });
  } finally {
    await discardTemp();
  }
}

export async function handleBotFile(req: IncomingMessage, res: ServerResponse, deps: ServerDeps, sha: string): Promise<void> {
  const actor = await requireDirectAccessBearer(req, res, deps.records.principals);
  if (!actor) return;
  const rawProfile = await deps.records.vault.get('personal-bot.model');
  if (!rawProfile) {
    req.resume();
    return sendJson(res, 503, botError('BOT_DISABLED', '个人助手尚未启用'));
  }
  return transferBotFile(
    req,
    res,
    deps.config.dataDir,
    actor.id,
    sha,
    async () => {
      const again = await authenticateAccessOnly(deps.records.principals, req.headers.authorization ?? null);
      return again.ok && again.principal.id === actor.id && again.client_id === null;
    },
    { now: () => (deps.now?.() ?? new Date()).getTime() },
  );
}
